//! Worktrees: one base clone of each project, shared by all agents, in `<storage>/.repos/<project>`, and one git
//! worktree per job in the agent's workspace, `<project>-<branch>`, so a job costs a checkout, not a whole clone.
//! Checkers get one `<project>-review` worktree per project instead, detached at the head of the PR they check.
//!
//! The base clone is never a worktree of the user's own checkout: agents don't touch the user's projects, and
//! worktrees write into their base repo's `.git`. Its `origin` is the project's remote, so agents push there.
//! It has no branch of its own and no checkout, so any branch can be checked out in a worktree.
//!
//! Every agent's worktree writes to the base clone's shared `.git/config`, so Loft never trusts it: each call
//! rewrites it from what Loft knows (the project's remote, hooks off) before running git there.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use crate::state::AppState;

/// The base clones' folder in the agents' folder. A dot folder, so the sweep doesn't take it for a workspace.
pub const REPOS: &str = ".repos";

/// One clone, fetch or worktree change per project at a time: two agents asking for a new project clone it once.
static LOCKS: Mutex<Vec<(String, Arc<Mutex<()>>)>> = Mutex::new(Vec::new());

/// The `worktree` tool: `agent`'s worktree of `project` on `branch`, made from `base` when the branch is new;
/// or, with `pr`, its review worktree detached at that PR's head.
pub async fn for_agent(state: &AppState, agent_id: &str, project: &str, branch: &str, base: &str, pr: Option<u64>) -> Result<String, String> {
    let storage = state.cfg.storage_dir.clone();
    let projects = state.settings.boot().projects_dir.clone();
    let ws = crate::agents::workspace(state, agent_id);
    let (project, branch, base) = (project.to_string(), branch.to_string(), base.to_string());
    if let Some(n) = pr {
        let (path, sha) = tokio::task::spawn_blocking(move || review(&storage, &projects, &ws, &project, n))
            .await
            .map_err(|e| e.to_string())??;
        return Ok(format!(
            "Your review worktree is `{}`, detached at PR #{n}'s head `{sha}`. Check that `git -C {0} rev-parse HEAD` is `{sha}` and name that SHA in your verdict. Never commit there; call this again for each review round.",
            path.display()
        ));
    }
    let path = tokio::task::spawn_blocking(move || worktree(&storage, &projects, &ws, &project, &branch, &base))
        .await
        .map_err(|e| e.to_string())??;
    Ok(format!(
        "Your worktree is `{}`: work, commit and push there, and use it again for this branch. Run `git pull --ff-only` there before each build. When the work is merged, run `git worktree remove {0}` (never `--force`).",
        path.display()
    ))
}

/// The worktree of `project` on `branch` in `ws`, made on first use: the existing branch (local or on the
/// remote), or a new one from `origin/<base>` (the remote's default branch when `base` is empty).
pub fn worktree(storage: &Path, projects: &Path, ws: &Path, project: &str, branch: &str, base: &str) -> Result<PathBuf, String> {
    let branch = branch.trim();
    if branch.is_empty() || branch.starts_with('-') || git(ws.parent().unwrap_or(ws), &["check-ref-format", "--branch", branch]).is_err() {
        return Err(format!("`{branch}` isn't a valid branch name"));
    }
    let base = base.trim();
    if base.starts_with('-') {
        return Err(format!("`{base}` isn't a valid branch name"));
    }
    let (project, src) = source(storage, projects, project)?;
    let lock = lock(&project);
    let _one = lock.lock().unwrap_or_else(|e| e.into_inner());
    let repo = base_clone(storage, &src, &project)?;
    let path = ws.join(format!("{}-{}", project.replace('/', "-"), branch.replace('/', "-")));
    if path.exists() {
        return match git(&path, &["symbolic-ref", "--short", "HEAD"]) {
            Ok(head) if head.trim() == branch && path.join(".git").is_file() => Ok(path),
            _ => Err(format!("`{}` exists and isn't your worktree of `{branch}`", path.display())),
        };
    }
    let has = |r: &str| git(&repo, &["rev-parse", "--verify", "--quiet", r]).is_ok();
    let p = path.to_string_lossy();
    if has(&format!("refs/heads/{branch}")) || has(&format!("refs/remotes/origin/{branch}")) {
        git(&repo, &["worktree", "add", &p, branch])?;
    } else {
        let from = if base.is_empty() { "origin/HEAD".to_string() } else { format!("origin/{base}") };
        git(&repo, &["worktree", "add", "-b", branch, &p, &from])?;
    }
    Ok(path)
}

/// The checker's `<project>-review` worktree in `ws`, detached at PR `pr`'s head as just fetched; and that SHA.
/// No branch is checked out, so the PR's dev keeps its branch and any number of checkers see the same commit.
pub fn review(storage: &Path, projects: &Path, ws: &Path, project: &str, pr: u64) -> Result<(PathBuf, String), String> {
    let (project, src) = source(storage, projects, project)?;
    let lock = lock(&project);
    let _one = lock.lock().unwrap_or_else(|e| e.into_inner());
    let repo = base_clone(storage, &src, &project)?;
    let head = format!("refs/pull/{pr}/head");
    fetch(&repo, &[&format!("+{head}:{head}")])?;
    let sha = git(&repo, &["rev-parse", "--verify", &format!("{head}^{{commit}}")])?.trim().to_string();
    let path = ws.join(format!("{}-review", project.replace('/', "-")));
    if !path.exists() {
        git(&repo, &["worktree", "add", "--detach", &path.to_string_lossy(), &sha])?;
        return Ok((path, sha));
    }
    if !path.join(".git").is_file() || git(&path, &["symbolic-ref", "-q", "HEAD"]).is_ok() {
        return Err(format!("`{}` exists and isn't your review worktree (one detached, with no branch)", path.display()));
    }
    let changes = git(&path, &["status", "--porcelain", "--untracked-files=all"])?;
    if !changes.trim().is_empty() {
        return Err(format!("`{}` has changes; checkers never change it. Clean it up first:\n{changes}", path.display()));
    }
    git(&path, &["checkout", "--quiet", "--detach", &sha])?;
    Ok((path, sha))
}

/// The project's name and its folder in `projects`: never an agent's workspace (an agent can make a repo there
/// with any origin), even where the agents' folder sits inside the projects folder.
fn source(storage: &Path, projects: &Path, project: &str) -> Result<(String, PathBuf), String> {
    let project = crate::repos::project_name(project)?;
    if project.is_empty() {
        return Err("project is required".into());
    }
    let root = projects.canonicalize().map_err(|e| format!("{}: {e}", projects.display()))?;
    let agents = storage.canonicalize().unwrap_or_else(|_| storage.to_path_buf());
    match projects.join(&project).canonicalize() {
        Ok(dir) if dir.starts_with(&root) && !dir.starts_with(&agents) && dir.join(".git").exists() => Ok((project, dir)),
        _ => Err(format!("`{project}` isn't a git repo in {}", projects.display())),
    }
}

/// `project`'s lock.
fn lock(project: &str) -> Arc<Mutex<()>> {
    let mut all = LOCKS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((_, l)) = all.iter().find(|(p, _)| p == project) {
        return l.clone();
    }
    let l = Arc::new(Mutex::new(()));
    all.push((project.to_string(), l.clone()));
    l
}

/// Where `project`'s base clone lives: one folder per project, `/` escaped, so `work` and `work/isa` don't nest.
fn base_dir(storage: &Path, project: &str) -> PathBuf {
    storage.join(REPOS).join(project.replace('%', "%25").replace('/', "%2F"))
}

/// `project`'s base clone, cloned from `src` on first use; its config rewritten and fetched every time.
fn base_clone(storage: &Path, src: &Path, project: &str) -> Result<PathBuf, String> {
    let repo = base_dir(storage, project);
    // The project's remote, or the project itself when it has none.
    let url = git(src, &["remote", "get-url", "origin"]).map(|u| u.trim().to_string()).unwrap_or_else(|_| src.to_string_lossy().into_owned());
    if url.is_empty() || url.starts_with('-') {
        return Err(format!("`{project}`'s remote `{url}` isn't one Loft fetches"));
    }
    let new = !repo.join(".git").exists();
    if new {
        std::fs::create_dir_all(repo.parent().unwrap_or(storage)).map_err(|e| e.to_string())?;
        // A local clone is quick and shares objects; then it follows the project's remote, not the user's checkout.
        git(storage, &["clone", "--quiet", "--no-checkout", "--", &src.to_string_lossy(), &repo.to_string_lossy()])?;
    }
    trusted_config(&repo, &url)?;
    fetch(&repo, &[])?;
    if new {
        git(&repo, &["remote", "set-head", "origin", "--auto"])?;
        // No branch of its own (the clone took the user's current one), so worktrees can check out any.
        git(&repo, &["checkout", "--quiet", "--detach"])?;
        for b in git(&repo, &["for-each-ref", "--format=%(refname:short)", "refs/heads"])?.lines() {
            git(&repo, &["branch", "--quiet", "-D", b])?;
        }
    }
    Ok(repo)
}

/// Replaces the base clone's shared config with one Loft wrote: `origin` is `url`, hooks are off, and only the
/// branches' upstreams carry over (onto `origin`), so nothing an agent set there runs or redirects anything.
fn trusted_config(repo: &Path, url: &str) -> Result<(), String> {
    let old = repo.join(".git/config");
    let new = repo.join(".git/config.loft");
    let _ = std::fs::remove_file(&new);
    let f = new.to_string_lossy().into_owned();
    let set = |k: &str, v: &str| git(repo, &["config", "--file", &f, k, v]);
    for (k, v) in [
        ("core.repositoryformatversion", "0"),
        ("core.filemode", "true"),
        ("core.bare", "false"),
        ("core.logallrefupdates", "true"),
        ("core.hooksPath", "/dev/null"),
        ("remote.origin.url", url),
        ("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"),
    ] {
        set(k, v)?;
    }
    // `--file` reads the file alone, without following its includes.
    let read = |pattern: &str| git(repo, &["config", "--file", &old.to_string_lossy(), "--get-regexp", pattern]).unwrap_or_default();
    for line in read(r"^core\.(ignorecase|precomposeunicode)$").lines() {
        if let Some((k, v @ ("true" | "false"))) = line.split_once(' ') {
            set(k, v)?;
        }
    }
    for line in read(r"^branch\..*\.merge$").lines() {
        let Some((key, merge)) = line.split_once(' ') else { continue };
        let Some(branch) = key.strip_prefix("branch.").and_then(|k| k.strip_suffix(".merge")) else { continue };
        let ok = |b: &str| !b.starts_with('-') && git(repo, &["check-ref-format", "--branch", b]).is_ok();
        if ok(branch) && merge.strip_prefix("refs/heads/").is_some_and(ok) {
            set(&format!("branch.{branch}.remote"), "origin")?;
            set(&format!("branch.{branch}.merge"), merge)?;
        }
    }
    std::fs::rename(&new, &old).map_err(|e| format!("writing {}: {e}", old.display()))
}

/// Fetches `origin` (its branches, or `refspecs`), retrying once when another agent's fetch holds a ref lock.
fn fetch(repo: &Path, refspecs: &[&str]) -> Result<String, String> {
    let mut args = vec!["-c", "protocol.ext.allow=never", "fetch", "--quiet"];
    if refspecs.is_empty() {
        args.push("--prune");
    }
    args.push("origin");
    args.extend(refspecs);
    match git(repo, &args) {
        Err(e) if e.contains(".lock") || e.contains("cannot lock ref") => {
            std::thread::sleep(std::time::Duration::from_secs(1));
            git(repo, &args)
        }
        r => r,
    }
}

/// Runs git in `dir` with [`crate::repos::SAFE_GIT`]; its output, or what git said.
fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(crate::repos::SAFE_GIT)
        .args(args)
        .output()
        .map_err(|e| format!("spawning git: {e}"))?;
    if !out.status.success() {
        return Err(format!("git {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("loft-worktrees-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    fn run(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").arg("-C").arg(dir).args(["-c", "user.name=T", "-c", "user.email=t@example.com"]).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// A remote with `main` and `feat/x`, the user's checkout of it (`projects/loft`, on a local branch of
    /// their own), and the agents' folder with workspace `a`.
    fn setup() -> (PathBuf, PathBuf, PathBuf, PathBuf) {
        let root = temp();
        let up = root.join("up");
        fs::create_dir_all(&up).unwrap();
        run(&up, &["init", "--quiet", "-b", "main"]);
        run(&up, &["commit", "--quiet", "--allow-empty", "-m", "one"]);
        run(&up, &["branch", "feat/x"]);
        let remote = root.join("remote.git");
        run(&root, &["clone", "--quiet", "--bare", &up.to_string_lossy(), &remote.to_string_lossy()]);
        let projects = root.join("projects");
        fs::create_dir_all(&projects).unwrap();
        run(&projects, &["clone", "--quiet", &remote.to_string_lossy(), "loft"]);
        run(&projects.join("loft"), &["switch", "--quiet", "-c", "mine"]);
        let storage = root.join("agent-local-storage");
        let ws = storage.join("a");
        fs::create_dir_all(&ws).unwrap();
        (storage, projects, ws, remote)
    }

    #[test]
    fn two_jobs_share_one_base_clone_and_get_a_worktree_each() {
        let (storage, projects, ws, remote) = setup();
        let one = worktree(&storage, &projects, &ws, "loft", "fix/one", "").unwrap();
        let two = worktree(&storage, &projects, &ws, "loft", "feat/x", "").unwrap();
        assert_eq!(one, ws.join("loft-fix-one"));
        assert_eq!(two, ws.join("loft-feat-x"));

        let base = storage.join(REPOS).join("loft");
        let list = run(&base, &["worktree", "list"]);
        assert!(list.contains("loft-fix-one") && list.contains("loft-feat-x"), "{list}");
        assert_eq!(fs::read_dir(storage.join(REPOS)).unwrap().count(), 1);
        // The base clone pushes to the project's remote, never to the user's checkout.
        assert_eq!(run(&base, &["remote", "get-url", "origin"]).trim(), remote.to_string_lossy());
        assert_eq!(run(&one, &["symbolic-ref", "--short", "HEAD"]).trim(), "fix/one");
        assert_eq!(run(&two, &["rev-parse", "--abbrev-ref", "@{upstream}"]).trim(), "origin/feat/x");
        // The user's checkout is untouched: still on their branch, with no worktrees.
        assert_eq!(run(&projects.join("loft"), &["worktree", "list"]).lines().count(), 1);

        // A follow-up on the same branch gets the same worktree.
        assert_eq!(worktree(&storage, &projects, &ws, "loft", "fix/one", "").unwrap(), one);
        // Loft rewrote the shared config on that call; the branch keeps its upstream.
        assert_eq!(run(&two, &["rev-parse", "--abbrev-ref", "@{upstream}"]).trim(), "origin/feat/x");
    }

    #[test]
    fn the_remote_default_branch_can_be_checked_out_and_a_new_branch_starts_from_base() {
        let (storage, projects, ws, _) = setup();
        let main = worktree(&storage, &projects, &ws, "loft", "main", "").unwrap();
        assert_eq!(run(&main, &["symbolic-ref", "--short", "HEAD"]).trim(), "main");
        let new = worktree(&storage, &projects, &ws, "loft", "on-x", "feat/x").unwrap();
        assert_eq!(run(&new, &["rev-parse", "HEAD"]), run(&main, &["rev-parse", "origin/feat/x"]));
    }

    #[test]
    fn a_merged_worktree_is_removed_and_a_dirty_one_is_kept() {
        let (storage, projects, ws, _) = setup();
        let clean = worktree(&storage, &projects, &ws, "loft", "clean", "").unwrap();
        let dirty = worktree(&storage, &projects, &ws, "loft", "dirty", "").unwrap();
        fs::write(dirty.join("notes.txt"), "unsaved").unwrap();
        let base = storage.join(REPOS).join("loft");

        run(&base, &["worktree", "remove", &clean.to_string_lossy()]);
        assert!(!clean.exists());
        assert!(git(&base, &["worktree", "remove", &dirty.to_string_lossy()]).is_err(), "git refuses without --force");
        assert!(dirty.join("notes.txt").exists());
    }

    #[test]
    fn bad_names_and_unknown_projects_are_refused() {
        let (storage, projects, ws, _) = setup();
        assert!(worktree(&storage, &projects, &ws, "../loft", "b", "").is_err());
        assert!(worktree(&storage, &projects, &ws, "nope", "b", "").is_err());
        for bad in ["", "-b", "a..b", "a b"] {
            assert!(worktree(&storage, &projects, &ws, "loft", bad, "").is_err(), "{bad:?}");
        }
        // A folder that's already there for something else isn't taken over.
        fs::create_dir_all(ws.join("loft-taken")).unwrap();
        assert!(worktree(&storage, &projects, &ws, "loft", "taken", "").is_err());
        assert!(!storage.join(REPOS).join("nope").exists());
    }

    #[test]
    fn a_dev_on_its_branch_and_a_checker_on_the_same_pr_s_head_work_at_once() {
        let (storage, projects, ws, remote) = setup();
        let dev = worktree(&storage, &projects, &ws, "loft", "feat-x", "").unwrap();
        run(&dev, &["commit", "--quiet", "--allow-empty", "-m", "work"]);
        run(&dev, &["push", "--quiet", "-u", "origin", "feat-x"]);
        let head = run(&dev, &["rev-parse", "HEAD"]).trim().to_string();
        run(&remote, &["update-ref", "refs/pull/7/head", &head]);

        let checker = storage.join("b");
        fs::create_dir_all(&checker).unwrap();
        let (review_wt, sha) = review(&storage, &projects, &checker, "loft", 7).unwrap();
        assert_eq!(review_wt, checker.join("loft-review"));
        assert_eq!(sha, head);
        assert_eq!(run(&review_wt, &["rev-parse", "HEAD"]).trim(), head);
        assert!(git(&review_wt, &["symbolic-ref", "-q", "HEAD"]).is_err(), "the review worktree is detached");

        // The dev keeps its branch and goes on; the next round moves the checker to the new head.
        run(&dev, &["commit", "--quiet", "--allow-empty", "-m", "fix"]);
        run(&dev, &["push", "--quiet"]);
        let next = run(&dev, &["rev-parse", "HEAD"]).trim().to_string();
        run(&remote, &["update-ref", "refs/pull/7/head", &next]);
        assert_eq!(review(&storage, &projects, &checker, "loft", 7).unwrap(), (review_wt.clone(), next.clone()));
        assert_eq!(run(&review_wt, &["rev-parse", "HEAD"]).trim(), next);
        assert_eq!(run(&dev, &["symbolic-ref", "--short", "HEAD"]).trim(), "feat-x");

        // A second checker on the same commit, and the dev's branch, all in one base clone.
        let other = storage.join("c");
        fs::create_dir_all(&other).unwrap();
        assert_eq!(review(&storage, &projects, &other, "loft", 7).unwrap().1, next);
        let list = run(&storage.join(REPOS).join("loft"), &["worktree", "list"]);
        assert_eq!(list.lines().count(), 4, "{list}");

        // A checker's changes are never thrown away: the next round refuses instead.
        fs::write(review_wt.join("scratch.txt"), "x").unwrap();
        assert!(review(&storage, &projects, &checker, "loft", 7).is_err());
        assert!(review(&storage, &projects, &checker, "loft", 99).is_err(), "no such PR");
    }

    #[test]
    fn nothing_an_agent_sets_in_the_shared_config_runs_or_redirects_origin() {
        let (storage, projects, ws, remote) = setup();
        let mine = worktree(&storage, &projects, &ws, "loft", "mine", "").unwrap();
        let ran = storage.join("ran");
        let hooks = storage.join("hooks");
        fs::create_dir_all(&hooks).unwrap();
        let hook = hooks.join("post-checkout");
        fs::write(&hook, format!("#!/bin/sh\ntouch {}\n", ran.display())).unwrap();
        fs::set_permissions(&hook, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        // What an agent can do from its worktree: it writes the base clone's config.
        run(&mine, &["config", "protocol.ext.allow", "always"]);
        run(&mine, &["config", "remote.origin.url", &format!("ext::sh -c touch% {}", ran.display())]);
        run(&mine, &["config", "core.hooksPath", &hooks.to_string_lossy()]);
        run(&mine, &["config", "core.sshCommand", &format!("touch {}", ran.display())]);

        worktree(&storage, &projects, &ws, "loft", "next", "").unwrap();
        run(&remote, &["update-ref", "refs/pull/1/head", "main"]);
        review(&storage, &projects, &ws, "loft", 1).unwrap();

        assert!(!ran.exists(), "a command an agent set ran");
        let base = storage.join(REPOS).join("loft");
        assert_eq!(run(&base, &["remote", "get-url", "origin"]).trim(), remote.to_string_lossy());
        let config = fs::read_to_string(base.join(".git/config")).unwrap();
        assert!(!config.contains("ext::") && !config.contains("protocol") && !config.contains("sshCommand") && config.contains("hooksPath = /dev/null"), "{config}");
    }

    #[test]
    fn an_agent_s_repo_is_never_a_project_and_nested_projects_get_their_own_base_clone() {
        let (storage, _, ws, remote) = setup();
        // Here the agents' folder sits inside the projects folder.
        let projects = storage.parent().unwrap().to_path_buf();
        let evil = storage.join("a/evil");
        fs::create_dir_all(&evil).unwrap();
        run(&evil, &["init", "--quiet"]);
        assert!(worktree(&storage, &projects, &ws, "agent-local-storage/a/evil", "b", "").is_err());
        assert!(review(&storage, &projects, &ws, "agent-local-storage/a/evil", 1).is_err());

        let work = projects.join("work");
        run(&projects, &["clone", "--quiet", &remote.to_string_lossy(), "work"]);
        run(&work, &["clone", "--quiet", &remote.to_string_lossy(), "isa"]);
        worktree(&storage, &projects, &ws, "work/isa", "one", "").unwrap();
        worktree(&storage, &projects, &ws, "work", "two", "").unwrap();
        assert!(storage.join(REPOS).join("work%2Fisa/.git").exists());
        assert!(storage.join(REPOS).join("work/.git").exists());
    }

    #[test]
    fn a_fetch_held_up_by_another_agent_s_ref_lock_is_retried_once() {
        let (storage, projects, ws, remote) = setup();
        worktree(&storage, &projects, &ws, "loft", "one", "").unwrap();
        let up = remote.parent().unwrap().join("up");
        run(&up, &["commit", "--quiet", "--allow-empty", "-m", "two"]);
        run(&up, &["push", "--quiet", &remote.to_string_lossy(), "main"]);
        let base = storage.join(REPOS).join("loft");
        let lock = base.join(".git/refs/remotes/origin/main.lock");
        fs::write(&lock, "").unwrap();
        let held = lock.clone();
        let other = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            fs::remove_file(held).unwrap();
        });
        fetch(&base, &[]).unwrap();
        other.join().unwrap();
        assert_eq!(run(&base, &["rev-parse", "origin/main"]), run(&up, &["rev-parse", "main"]));
    }
}
