//! Worktrees: one base clone of each project, shared by all agents, in `<storage>/.repos/<project>`, and one git
//! worktree per job in the agent's workspace, `<project>-<branch>`, so a job costs a checkout, not a whole clone.
//!
//! The base clone is never a worktree of the user's own checkout: agents don't touch the user's projects, and
//! worktrees write into their base repo's `.git`. Its `origin` is the project's remote, so agents push there.
//! It has no branch of its own and no checkout, so any branch can be checked out in a worktree.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::state::AppState;

/// The base clones' folder in the agents' folder. A dot folder, so the sweep doesn't take it for a workspace.
pub const REPOS: &str = ".repos";

/// One clone or worktree change at a time: two agents asking for the same new project clone it once.
static ONE: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The `worktree` tool: `agent`'s worktree of `project` on `branch`, made from `base` when the branch is new.
pub async fn for_agent(state: &AppState, agent_id: &str, project: &str, branch: &str, base: &str) -> Result<String, String> {
    let storage = state.cfg.storage_dir.clone();
    let projects = state.settings.boot().projects_dir.clone();
    let ws = crate::agents::workspace(state, agent_id);
    let (project, branch, base) = (project.to_string(), branch.to_string(), base.to_string());
    let path = tokio::task::spawn_blocking(move || worktree(&storage, &projects, &ws, &project, &branch, &base))
        .await
        .map_err(|e| e.to_string())??;
    Ok(format!(
        "Your worktree is `{}`: work, commit and push there, and use it again for this branch. When the work is merged, run `git worktree remove {0}` (never `--force`).",
        path.display()
    ))
}

/// The worktree of `project` on `branch` in `ws`, made on first use: the existing branch (local or on the
/// remote), or a new one from `origin/<base>` (the remote's default branch when `base` is empty).
pub fn worktree(storage: &Path, projects: &Path, ws: &Path, project: &str, branch: &str, base: &str) -> Result<PathBuf, String> {
    let project = crate::repos::project_name(project)?;
    if project.is_empty() {
        return Err("project is required".into());
    }
    let branch = branch.trim();
    if branch.is_empty() || branch.starts_with('-') || git(ws.parent().unwrap_or(ws), &["check-ref-format", "--branch", branch]).is_err() {
        return Err(format!("`{branch}` isn't a valid branch name"));
    }
    let _one = ONE.lock().unwrap_or_else(|e| e.into_inner());
    let repo = base_clone(storage, projects, &project)?;
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
        let from = if base.trim().is_empty() { "origin/HEAD".to_string() } else { format!("origin/{}", base.trim()) };
        git(&repo, &["worktree", "add", "-b", branch, &p, &from])?;
    }
    Ok(path)
}

/// `project`'s base clone, cloned on first use and fetched every time.
fn base_clone(storage: &Path, projects: &Path, project: &str) -> Result<PathBuf, String> {
    let repo = storage.join(REPOS).join(project);
    if !repo.join(".git").exists() {
        let src = projects.join(project);
        if !src.join(".git").exists() {
            return Err(format!("`{project}` isn't a git repo in {}", projects.display()));
        }
        std::fs::create_dir_all(repo.parent().unwrap_or(storage)).map_err(|e| e.to_string())?;
        // A local clone is quick and shares objects; then it follows the project's remote, not the user's checkout.
        git(storage, &["clone", "--quiet", "--no-checkout", &src.to_string_lossy(), &repo.to_string_lossy()])?;
        if let Ok(url) = git(&src, &["remote", "get-url", "origin"]) {
            git(&repo, &["remote", "set-url", "origin", url.trim()])?;
        }
        git(&repo, &["fetch", "--quiet", "--prune", "origin"])?;
        git(&repo, &["remote", "set-head", "origin", "--auto"])?;
        // No branch of its own (the clone took the user's current one), so worktrees can check out any.
        git(&repo, &["checkout", "--quiet", "--detach"])?;
        for b in git(&repo, &["for-each-ref", "--format=%(refname:short)", "refs/heads"])?.lines() {
            git(&repo, &["branch", "--quiet", "-D", b])?;
        }
        return Ok(repo);
    }
    git(&repo, &["fetch", "--quiet", "--prune", "origin"])?;
    Ok(repo)
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
}
