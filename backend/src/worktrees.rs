//! Worktrees: one base clone of each project, shared by all agents, in `<storage>/.repos/<project>`, and one git
//! worktree per job in the agent's workspace, `<project>-<branch>`, so a job costs a checkout, not a whole clone.
//! Checkers get one `<project>-review` worktree per project instead, detached at the head of the PR they check.
//!
//! The base clone is never a worktree of the user's own checkout: agents don't touch the user's projects, and
//! worktrees write into their base repo's `.git`. Its `origin` is the project's remote, so agents push there.
//! It has no branch of its own and no checkout, so any branch can be checked out in a worktree.
//!
//! Every agent's worktree writes to the base clone's shared `.git/config`, at any moment, so Loft runs nothing
//! there that a config key can turn into a command: no fetch, no checkout, no status, and no git at all in an
//! agent's workspace. Loft fetches into its own mirror of each project, `<storage>/.mirrors/<project>`, which
//! no agent's git writes to; the base clone borrows the mirror's objects (git alternates) and Loft copies its
//! refs over. Worktrees are made without files: the agent checks them out itself, with its own permissions.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use crate::state::AppState;

/// The base clones' folder in the agents' folder. A dot folder, so the sweep doesn't take it for a workspace.
pub const REPOS: &str = ".repos";

/// Loft's own mirrors of the projects, which agents' git never writes to.
const MIRRORS: &str = ".mirrors";

/// The refs Loft copies from a project's mirror to its base clone.
const SHARED_REFS: [&str; 2] = ["refs/remotes/origin/", "refs/pull/"];

/// One clone, fetch or worktree change per project at a time: two agents asking for a new project clone it once.
static LOCKS: Mutex<Vec<(String, Arc<Mutex<()>>)>> = Mutex::new(Vec::new());

/// The `worktree` tool: `agent`'s worktree of `project` on `branch`, made from `base` when the branch is new;
/// or, with `pr`, its review worktree, for the agent to move to that PR's head.
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
            "Your review worktree is `{}`. Move it to PR #{n}'s head with `git -C {0} checkout --quiet --detach {sha}`; then `git -C {0} status --short` must print nothing and `git -C {0} rev-parse HEAD` must print `{sha}`. Name that SHA in your verdict. Never commit there; call this again for each review round.",
            path.display()
        ));
    }
    let shown = branch.trim().to_string();
    let path = tokio::task::spawn_blocking(move || worktree(&storage, &projects, &ws, &project, &branch, &base))
        .await
        .map_err(|e| e.to_string())??;
    Ok(format!(
        "Your worktree is `{}`: work, commit and push there, and use it again for this branch. A new one has no files yet: run `git -C {0} checkout --quiet {branch}` first. Run `git pull --ff-only` there before each build. When the work is merged, run `git worktree remove {0}` (never `--force`).",
        path.display(),
        branch = shown
    ))
}

/// The line that names the Dev's folder in a ticket's brief: its worktree of `project` on `branch`, made or
/// reused from `origin/<base>` (the default branch when `base` is empty) as just fetched. Loft runs no git in
/// the agent's folder (see the module docs), so a new one has no files and an old one is pulled by the Dev.
pub async fn dev_folder(state: &AppState, agent_id: &str, project: &str, branch: &str, base: &str) -> String {
    let storage = state.cfg.storage_dir.clone();
    let projects = state.settings.boot().projects_dir.clone();
    let ws = crate::agents::workspace(state, agent_id);
    let (p, b, from) = (project.to_string(), branch.to_string(), base.to_string());
    tokio::task::spawn_blocking(move || dev_line(&storage, &projects, &ws, &p, &b, &from)).await.unwrap_or_else(|e| e.to_string())
}

/// The line that names a checker's folder: its `<project>-review` worktree, with the PR's head fetched just now.
pub async fn checker_folder(state: &AppState, agent_id: &str, project: &str, pr: u64) -> String {
    let storage = state.cfg.storage_dir.clone();
    let projects = state.settings.boot().projects_dir.clone();
    let ws = crate::agents::workspace(state, agent_id);
    let p = project.to_string();
    tokio::task::spawn_blocking(move || checker_line(&storage, &projects, &ws, &p, pr)).await.unwrap_or_else(|e| e.to_string())
}

fn dev_line(storage: &Path, projects: &Path, ws: &Path, project: &str, branch: &str, base: &str) -> String {
    match worktree(storage, projects, ws, project, branch, base) {
        Ok(path) => {
            let from = if base.trim().is_empty() { "HEAD" } else { base.trim() };
            let next = if has_files(&path) {
                "Run `git pull --ff-only` there before you build.".to_string()
            } else {
                format!("It has no files yet: run `git -C {} checkout --quiet {branch}` first.", path.display())
            };
            format!("Your folder: {}, on {branch} from origin/{from}, fetched just now. {next}", path.display())
        }
        Err(e) => format!("Loft couldn't prepare your folder ({e}): call `mcp__loft__worktree` with the project and the branch."),
    }
}

fn checker_line(storage: &Path, projects: &Path, ws: &Path, project: &str, pr: u64) -> String {
    match review(storage, projects, ws, project, pr) {
        Ok((path, sha)) => format!(
            "Your folder: {0}, detached at {sha} (PR #{pr}). Move it there with `git -C {0} checkout --quiet --detach {sha}`, check `git rev-parse HEAD` prints that SHA before you report, and never commit there.",
            path.display()
        ),
        Err(e) => format!("Loft couldn't prepare your folder ({e}): call `mcp__loft__worktree` with the project and `pr` {pr}."),
    }
}

/// Whether a worktree has files checked out: a new one made `--no-checkout` holds only its `.git` file.
fn has_files(path: &Path) -> bool {
    std::fs::read_dir(path).is_ok_and(|d| d.flatten().any(|e| e.file_name() != ".git"))
}

/// The worktree of `project` on `branch` in `ws`, made on first use, with no files checked out: the existing
/// branch (local or on the remote), or a new one from `origin/<base>` (the remote's default branch when `base`
/// is empty).
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
    let repo = base_clone(storage, &mirror(storage, &src, &project)?, &project)?;
    let path = ws.join(format!("{}-{}", project.replace('/', "-"), branch.replace('/', "-")));
    if path.exists() {
        return match listed(&repo, &path)? {
            Some(head) if head == format!("branch refs/heads/{branch}") => Ok(path),
            _ => Err(format!("`{}` exists and isn't your worktree of `{branch}`", path.display())),
        };
    }
    let has = |r: &str| git(&repo, &["rev-parse", "--verify", "--quiet", r]).is_ok();
    let p = path.to_string_lossy();
    if has(&format!("refs/heads/{branch}")) || has(&format!("refs/remotes/origin/{branch}")) {
        git(&repo, &["worktree", "add", "--no-checkout", &p, branch])?;
    } else {
        let from = if base.is_empty() { "origin/HEAD".to_string() } else { format!("origin/{base}") };
        git(&repo, &["worktree", "add", "--no-checkout", "-b", branch, &p, &from])?;
    }
    Ok(path)
}

/// Deletes the workspace `ws` and, in each base clone, the records of the worktrees it held, so their branches
/// aren't "already used": another agent can check them out again. Agents can write in a base clone's `.git`, so
/// git doesn't do this (`git worktree prune` empties whatever folder a record symlinks to): only real folders
/// are walked, and only the records whose `gitdir` points inside `ws` are removed.
pub fn remove_workspace(storage: &Path, ws: &Path) {
    let ws_real = ws.canonicalize().ok();
    let _ = std::fs::remove_dir_all(ws);
    let is_dir = |p: &Path| std::fs::symlink_metadata(p).is_ok_and(|m| m.is_dir());
    let repos = storage.join(REPOS);
    if !is_dir(&repos) {
        return;
    }
    let Ok(dirs) = std::fs::read_dir(&repos) else { return };
    for dir in dirs.flatten() {
        let records = dir.path().join(".git/worktrees");
        if !is_dir(&dir.path()) || !is_dir(&dir.path().join(".git")) || !is_dir(&records) {
            continue;
        }
        let project = dir.file_name().to_string_lossy().replace("%2F", "/").replace("%25", "%");
        let lock = lock(&project);
        let _one = lock.lock().unwrap_or_else(|e| e.into_inner());
        let Ok(entries) = std::fs::read_dir(&records) else { continue };
        for record in entries.flatten() {
            let (record, gitdir) = (record.path(), record.path().join("gitdir"));
            if !is_dir(&record) || !std::fs::symlink_metadata(&gitdir).is_ok_and(|m| m.is_file()) {
                continue;
            }
            let Ok(target) = std::fs::read_to_string(&gitdir) else { continue };
            let target = Path::new(target.trim());
            if target.is_absolute() && (target.starts_with(ws) || ws_real.as_deref().is_some_and(|w| target.starts_with(w))) {
                let _ = std::fs::remove_dir_all(&record);
            }
        }
    }
}

/// The checker's `<project>-review` worktree in `ws`, made detached without files on first use; and PR `pr`'s
/// head as just fetched, for the checker to move it to. No branch is checked out, so the PR's dev keeps its
/// branch and any number of checkers see the same commit.
pub fn review(storage: &Path, projects: &Path, ws: &Path, project: &str, pr: u64) -> Result<(PathBuf, String), String> {
    let (project, src) = source(storage, projects, project)?;
    let lock = lock(&project);
    let _one = lock.lock().unwrap_or_else(|e| e.into_inner());
    let mirror = mirror(storage, &src, &project)?;
    let head = format!("refs/pull/{pr}/head");
    fetch(&mirror, &[&format!("+{head}:{head}")])?;
    let sha = git(&mirror, &["rev-parse", "--verify", &format!("{head}^{{commit}}")])?.trim().to_string();
    let repo = base_clone(storage, &mirror, &project)?;
    let path = ws.join(format!("{}-review", project.replace('/', "-")));
    if !path.exists() {
        git(&repo, &["worktree", "add", "--no-checkout", "--detach", &path.to_string_lossy(), &sha])?;
        return Ok((path, sha));
    }
    match listed(&repo, &path)? {
        Some(head) if head == "detached" => Ok((path, sha)),
        _ => Err(format!("`{}` exists and isn't your review worktree (one detached, with no branch)", path.display())),
    }
}

/// How the base clone lists the worktree at `path` (`branch refs/heads/<name>` or `detached`); `None` when
/// `path` isn't one of its worktrees. Read from the base clone, so no git runs in the agent's folder.
fn listed(repo: &Path, path: &Path) -> Result<Option<String>, String> {
    let Ok(path) = path.canonicalize() else { return Ok(None) };
    let list = git(repo, &["worktree", "list", "--porcelain"])?;
    Ok(list.split("\n\n").find_map(|entry| {
        let mut lines = entry.lines();
        let at = lines.next()?.strip_prefix("worktree ")?;
        if Path::new(at).canonicalize().ok()? != path {
            return None;
        }
        lines.find(|l| l.starts_with("branch ") || *l == "detached").map(str::to_string)
    }))
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

/// `project`'s folder in `dir`: one per project, `/` escaped, so `work` and `work/isa` don't nest.
fn dir_of(storage: &Path, dir: &str, project: &str) -> PathBuf {
    storage.join(dir).join(project.replace('%', "%25").replace('/', "%2F"))
}

/// Where `project`'s base clone lives.
fn base_dir(storage: &Path, project: &str) -> PathBuf {
    dir_of(storage, REPOS, project)
}

/// `project`'s mirror, a bare clone of `src` made on first use, following the project's remote, fetched every
/// time. Only Loft writes to it, so its config is Loft's alone.
fn mirror(storage: &Path, src: &Path, project: &str) -> Result<PathBuf, String> {
    let mirror = dir_of(storage, MIRRORS, project);
    // The project's remote, or the project itself when it has none.
    let url = git(src, &["remote", "get-url", "origin"]).map(|u| u.trim().to_string()).unwrap_or_else(|_| src.to_string_lossy().into_owned());
    if url.is_empty() || url.starts_with('-') {
        return Err(format!("`{project}`'s remote `{url}` isn't one Loft fetches"));
    }
    let new = !mirror.join("HEAD").exists();
    if new {
        std::fs::create_dir_all(mirror.parent().unwrap_or(storage)).map_err(|e| e.to_string())?;
        // A local clone is quick and shares objects; then it follows the project's remote, not the user's checkout.
        git(storage, &["clone", "--quiet", "--bare", "--", &src.to_string_lossy(), &mirror.to_string_lossy()])?;
        git(&mirror, &["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"])?;
        // Base clones borrow its objects, so it never prunes one.
        git(&mirror, &["config", "gc.pruneExpire", "never"])?;
    }
    git(&mirror, &["config", "remote.origin.url", &url])?;
    fetch(&mirror, &[])?;
    if new {
        git(&mirror, &["remote", "set-head", "origin", "--auto"])?;
    }
    Ok(mirror)
}

/// `project`'s base clone, made on first use with `mirror`'s objects, no branch and no checkout, so
/// worktrees can check out any branch. Every time: the mirror's refs are copied over, and the config
/// rewritten so agents push to the project's remote.
fn base_clone(storage: &Path, mirror: &Path, project: &str) -> Result<PathBuf, String> {
    let repo = base_dir(storage, project);
    let new = !repo.join(".git").exists();
    if new {
        std::fs::create_dir_all(&repo).map_err(|e| e.to_string())?;
        git(&repo, &["init", "--quiet"])?;
    }
    let mirror = mirror.canonicalize().map_err(|e| e.to_string())?;
    std::fs::write(repo.join(".git/objects/info/alternates"), format!("{}\n", mirror.join("objects").display())).map_err(|e| e.to_string())?;
    let url = git(&mirror, &["remote", "get-url", "origin"])?;
    trusted_config(&repo, url.trim())?;
    copy_refs(&mirror, &repo)?;
    if new {
        let sha = git(&repo, &["rev-parse", "--verify", "refs/remotes/origin/HEAD^{commit}"])?;
        git(&repo, &["update-ref", "--no-deref", "HEAD", sha.trim()])?;
    }
    Ok(repo)
}

/// Makes `repo`'s origin branches and PR heads the mirror's, retrying once when an agent's git holds a ref lock.
fn copy_refs(mirror: &Path, repo: &Path) -> Result<(), String> {
    let refs = |dir: &Path| -> Result<Vec<(String, String)>, String> {
        let mut args = vec!["for-each-ref", "--format=%(objectname) %(refname) %(symref)"];
        args.extend(SHARED_REFS);
        Ok(git(dir, &args)?
            .lines()
            .filter_map(|l| {
                let mut f = l.split(' ');
                let (sha, name, symref) = (f.next()?, f.next()?, f.next().unwrap_or(""));
                symref.is_empty().then(|| (name.to_string(), sha.to_string()))
            })
            .collect())
    };
    let want = refs(mirror)?;
    let mut stdin = String::new();
    for (name, _) in refs(repo)? {
        if !want.iter().any(|(n, _)| *n == name) {
            stdin.push_str(&format!("delete {name}\n"));
        }
    }
    for (name, sha) in &want {
        stdin.push_str(&format!("update {name} {sha}\n"));
    }
    let update = || git_in(repo, &["update-ref", "--stdin"], &stdin);
    match update() {
        Err(e) if e.contains(".lock") || e.contains("cannot lock ref") => {
            std::thread::sleep(std::time::Duration::from_secs(1));
            update()?;
        }
        r => {
            r?;
        }
    }
    if let Ok(head) = git(mirror, &["symbolic-ref", "refs/remotes/origin/HEAD"]) {
        git(repo, &["symbolic-ref", "refs/remotes/origin/HEAD", head.trim()])?;
    }
    Ok(())
}

/// Replaces the base clone's shared config with one Loft wrote: `origin` is `url`, hooks are off, and only the
/// branches' upstreams carry over (onto `origin`), so agents push and pull where Loft says.
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

/// Fetches the mirror's `origin`: its branches, or `refspecs`.
fn fetch(mirror: &Path, refspecs: &[&str]) -> Result<String, String> {
    let mut args = vec!["-c", "protocol.ext.allow=never", "fetch", "--quiet"];
    if refspecs.is_empty() {
        args.push("--prune");
    }
    args.push("origin");
    args.extend(refspecs);
    match git(mirror, &args) {
        Err(e) if e.contains(".lock") || e.contains("cannot lock ref") => {
            std::thread::sleep(std::time::Duration::from_secs(1));
            git(mirror, &args)
        }
        r => r,
    }
}

/// Runs git in `dir` with [`crate::repos::SAFE_GIT`] and no automatic maintenance (a fetch starts one, and its
/// `worktree prune` empties whatever folder a record in `.git/worktrees` symlinks to); its output, or what git said.
fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(crate::repos::SAFE_GIT)
        .args(["-c", "maintenance.auto=false", "-c", "gc.auto=0"])
        .args(args)
        .output()
        .map_err(|e| format!("spawning git: {e}"))?;
    if !out.status.success() {
        return Err(format!("git {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Runs git in `dir` like [`git`], with `input` on its stdin.
fn git_in(dir: &Path, args: &[&str], input: &str) -> Result<String, String> {
    use std::io::Write;
    use std::process::Stdio;
    let mut child = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(crate::repos::SAFE_GIT)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawning git: {e}"))?;
    child.stdin.take().map(|mut i| i.write_all(input.as_bytes())).transpose().map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
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
    fn a_deleted_workspace_s_branches_can_be_checked_out_again() {
        let (storage, projects, ws, _) = setup();
        worktree(&storage, &projects, &ws, "loft", "feat/x", "").unwrap();
        worktree(&storage, &projects, &ws, "loft", "fix/new", "").unwrap();
        remove_workspace(&storage, &ws);
        assert!(!ws.exists());

        let other = storage.join("b");
        fs::create_dir_all(&other).unwrap();
        assert_eq!(worktree(&storage, &projects, &other, "loft", "feat/x", "").unwrap(), other.join("loft-feat-x"));
        assert_eq!(worktree(&storage, &projects, &other, "loft", "fix/new", "").unwrap(), other.join("loft-fix-new"));
        let list = run(&storage.join(REPOS).join("loft"), &["worktree", "list"]);
        assert!(!list.contains(&*ws.to_string_lossy()), "{list}");
    }

    #[test]
    fn deleting_a_workspace_follows_no_symlink_and_leaves_other_workspaces_records() {
        let (storage, projects, ws, _) = setup();
        worktree(&storage, &projects, &ws, "loft", "feat/x", "").unwrap();
        let other = storage.join("b");
        fs::create_dir_all(&other).unwrap();
        let kept = worktree(&storage, &projects, &other, "loft", "fix/kept", "").unwrap();
        let victim = temp();
        fs::create_dir_all(victim.join("sub")).unwrap();
        fs::write(victim.join("a.txt"), "keep").unwrap();
        fs::write(victim.join("sub/b.txt"), "keep").unwrap();
        let base = storage.join(REPOS).join("loft");
        std::os::unix::fs::symlink(&victim, base.join(".git/worktrees/evil")).unwrap();
        // A plain folder in .repos isn't a base clone: nothing runs there.
        fs::create_dir_all(storage.join(REPOS).join("plain")).unwrap();

        remove_workspace(&storage, &ws);
        assert!(victim.join("a.txt").exists() && victim.join("sub/b.txt").exists(), "a record's symlink is never followed");
        let list = run(&base, &["worktree", "list"]);
        assert!(!list.contains("loft-feat-x") && list.contains("loft-fix-kept"), "{list}");
        // Its fetch starts no maintenance, whose `worktree prune` would empty the victim.
        assert_eq!(worktree(&storage, &projects, &other, "loft", "fix/kept", "").unwrap(), kept);
        assert!(victim.join("a.txt").exists() && victim.join("sub/b.txt").exists(), "no git maintenance prunes the records");

        // With `.git/worktrees` itself a symlink, nothing is touched either.
        fs::remove_file(base.join(".git/worktrees/evil")).unwrap();
        let real = base.join(".git/worktrees");
        fs::rename(&real, victim.join("records")).unwrap();
        std::os::unix::fs::symlink(&victim, &real).unwrap();
        remove_workspace(&storage, &other);
        assert!(victim.join("a.txt").exists() && victim.join("sub/b.txt").exists() && victim.join("records/loft-fix-kept").exists());
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
        // Made without files; the checker checks it out, as the tool tells it to.
        run(&review_wt, &["checkout", "--quiet", "--detach", &sha]);
        assert_eq!(run(&review_wt, &["rev-parse", "HEAD"]).trim(), head);
        assert_eq!(run(&review_wt, &["status", "--porcelain"]), "");
        assert!(git(&review_wt, &["symbolic-ref", "-q", "HEAD"]).is_err(), "the review worktree is detached");

        // The dev keeps its branch and goes on; the next round moves the checker to the new head.
        run(&dev, &["commit", "--quiet", "--allow-empty", "-m", "fix"]);
        run(&dev, &["push", "--quiet"]);
        let next = run(&dev, &["rev-parse", "HEAD"]).trim().to_string();
        run(&remote, &["update-ref", "refs/pull/7/head", &next]);
        assert_eq!(review(&storage, &projects, &checker, "loft", 7).unwrap(), (review_wt.clone(), next.clone()));
        run(&review_wt, &["checkout", "--quiet", "--detach", &next]);
        assert_eq!(run(&review_wt, &["rev-parse", "HEAD"]).trim(), next);
        assert_eq!(run(&dev, &["symbolic-ref", "--short", "HEAD"]).trim(), "feat-x");

        // A second checker on the same commit, and the dev's branch, all in one base clone.
        let other = storage.join("c");
        fs::create_dir_all(&other).unwrap();
        assert_eq!(review(&storage, &projects, &other, "loft", 7).unwrap().1, next);
        let list = run(&storage.join(REPOS).join("loft"), &["worktree", "list"]);
        assert_eq!(list.lines().count(), 4, "{list}");

        // A worktree on a branch isn't taken for a review worktree.
        run(&review_wt, &["switch", "--quiet", "-c", "oops"]);
        assert!(review(&storage, &projects, &checker, "loft", 7).is_err());
        assert!(review(&storage, &projects, &other, "loft", 99).is_err(), "no such PR");
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
    fn briefs_name_the_dev_s_folder_and_the_checker_s_folder_at_the_pr_head() {
        let (storage, projects, ws, remote) = setup();
        // A project under another name: its folder is a symlink; and a nested one.
        std::os::unix::fs::symlink(projects.join("loft"), projects.join("Laufey & Gustavo")).unwrap();
        run(&projects, &["clone", "--quiet", &remote.to_string_lossy(), "dineout"]);
        run(&projects.join("dineout"), &["clone", "--quiet", &remote.to_string_lossy(), "api"]);

        let line = dev_line(&storage, &projects, &ws, "Laufey & Gustavo", "feat/x", "main");
        let path = ws.join("Laufey & Gustavo-feat-x");
        assert!(line.starts_with(&format!("Your folder: {}, on feat/x from origin/main, fetched just now.", path.display())), "{line}");
        assert!(line.contains("It has no files yet") && line.contains("checkout --quiet feat/x"), "{line}");
        // Reused for a review round: the Dev pulls.
        run(&path, &["checkout", "--quiet", "feat/x"]);
        fs::write(path.join("README"), "x").unwrap();
        assert!(dev_line(&storage, &projects, &ws, "Laufey & Gustavo", "feat/x", "main").contains("Run `git pull --ff-only` there before you build."));
        assert!(dev_line(&storage, &projects, &ws, "dineout/api", "one", "").contains(&format!("{}/dineout-api-one", ws.display())));

        run(&path, &["commit", "--quiet", "--allow-empty", "-m", "work"]);
        run(&path, &["push", "--quiet"]);
        let head = run(&path, &["rev-parse", "HEAD"]).trim().to_string();
        run(&remote, &["update-ref", "refs/pull/7/head", &head]);
        let checker = storage.join("b");
        fs::create_dir_all(&checker).unwrap();
        let line = checker_line(&storage, &projects, &checker, "loft", 7);
        assert!(line.starts_with(&format!("Your folder: {}, detached at {head} (PR #7).", checker.join("loft-review").display())), "{line}");
        // The Dev on the branch and the checker on its SHA at once, and a missing PR says so.
        assert!(checker_line(&storage, &projects, &checker, "loft", 99).contains("Loft couldn't prepare your folder"));
        assert!(dev_line(&storage, &projects, &ws, "nope", "x", "").contains("Loft couldn't prepare your folder"));
    }

    #[test]
    fn a_fetch_held_up_by_a_ref_lock_is_retried_once() {
        let (storage, projects, ws, remote) = setup();
        worktree(&storage, &projects, &ws, "loft", "feat/x", "").unwrap();
        let head = run(&remote, &["rev-parse", "main"]).trim().to_string();
        run(&remote, &["update-ref", "refs/pull/7/head", &head]);
        let mirror = dir_of(&storage, MIRRORS, "loft");
        fs::create_dir_all(mirror.join("refs/pull/7")).unwrap();
        let lock = mirror.join("refs/pull/7/head.lock");
        fs::write(&lock, "").unwrap();
        let held = std::thread::spawn({
            let lock = lock.clone();
            move || {
                std::thread::sleep(std::time::Duration::from_millis(400));
                fs::remove_file(lock).unwrap();
            }
        });
        assert_eq!(review(&storage, &projects, &ws, "loft", 7).unwrap().1, head);
        held.join().unwrap();
    }

    #[test]
    fn copying_refs_held_up_by_an_agent_s_ref_lock_is_retried_once() {
        let (storage, projects, ws, remote) = setup();
        worktree(&storage, &projects, &ws, "loft", "one", "").unwrap();
        let up = remote.parent().unwrap().join("up");
        run(&up, &["commit", "--quiet", "--allow-empty", "-m", "two"]);
        run(&up, &["push", "--quiet", &remote.to_string_lossy(), "main"]);
        let base = storage.join(REPOS).join("loft");
        let mirror = dir_of(&storage, MIRRORS, "loft");
        fetch(&mirror, &[]).unwrap();
        let lock = base.join(".git/refs/remotes/origin/main.lock");
        fs::write(&lock, "").unwrap();
        let held = lock.clone();
        let other = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            fs::remove_file(held).unwrap();
        });
        copy_refs(&mirror, &base).unwrap();
        other.join().unwrap();
        assert_eq!(run(&base, &["rev-parse", "origin/main"]), run(&up, &["rev-parse", "main"]));
    }

    /// A command that leaves `marker` behind when it runs.
    fn trap(marker: &Path) -> String {
        format!("sh -c 'touch {}; cat'", marker.display())
    }

    #[test]
    fn a_worktree_of_the_agent_s_own_clone_is_not_taken_for_its_review_worktree() {
        let (storage, projects, ws, remote) = setup();
        run(&remote, &["update-ref", "refs/pull/1/head", "main"]);
        let own = ws.join("own");
        run(&ws, &["clone", "--quiet", &remote.to_string_lossy(), "own"]);
        let ran = storage.join("ran");
        run(&own, &["config", "filter.x.smudge", &trap(&ran)]);
        run(&own, &["config", "filter.x.clean", &trap(&ran)]);
        fs::write(own.join(".git/info/attributes"), "* filter=x\n").unwrap();
        run(&own, &["worktree", "add", "--quiet", "--detach", &ws.join("loft-review").to_string_lossy(), "HEAD"]);
        run(&own, &["worktree", "add", "--quiet", "-b", "b", &ws.join("loft-b").to_string_lossy(), "HEAD"]);

        assert!(review(&storage, &projects, &ws, "loft", 1).is_err());
        assert!(worktree(&storage, &projects, &ws, "loft", "b", "").is_err());
        assert!(!ran.exists(), "a command an agent set ran");
    }

    #[test]
    fn config_an_agent_writes_while_loft_works_runs_nothing() {
        let (storage, projects, ws, remote) = setup();
        let mine = worktree(&storage, &projects, &ws, "loft", "mine", "").unwrap();
        run(&mine, &["checkout", "--quiet", "mine"]);
        // A branch whose files go through filter `x`, and a PR to it.
        fs::write(mine.join(".gitattributes"), "* filter=x\n").unwrap();
        fs::write(mine.join("a.txt"), "a\n").unwrap();
        run(&mine, &["add", "."]);
        run(&mine, &["commit", "--quiet", "-m", "attrs"]);
        run(&mine, &["push", "--quiet", "origin", "mine:filtered"]);
        run(&remote, &["update-ref", "refs/pull/2/head", "filtered"]);
        let ran = storage.join("ran");
        let base_config = storage.join(REPOS).join("loft/.git/config");

        // What an agent can run from its worktree in a loop while Loft's call is in flight.
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let writer = {
            let (stop, mine, cmd) = (stop.clone(), mine.clone(), trap(&ran));
            std::thread::spawn(move || {
                while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                    for (k, v) in [
                        ("filter.x.smudge", cmd.as_str()),
                        ("filter.x.clean", cmd.as_str()),
                        ("filter.x.process", cmd.as_str()),
                        ("remote.origin.uploadpack", &format!("{cmd}; git-upload-pack")),
                        ("core.sshCommand", cmd.as_str()),
                        ("credential.helper", &format!("!{cmd}")),
                        ("protocol.ext.allow", "always"),
                    ] {
                        let _ = Command::new("git").arg("-C").arg(&mine).args(["config", k, v]).output();
                    }
                }
            })
        };
        for i in 0..5 {
            worktree(&storage, &projects, &ws, "loft", "filtered", "").unwrap();
            worktree(&storage, &projects, &ws, "loft", &format!("new-{i}"), "filtered").unwrap();
            review(&storage, &projects, &ws, "loft", 2).unwrap();
        }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        writer.join().unwrap();

        assert!(fs::read_to_string(&base_config).unwrap().contains("filter"), "the writer never wrote");
        assert!(!ran.exists(), "a command an agent set ran");
        // Loft's mirror is untouched: its origin is the project's remote.
        let mirror = dir_of(&storage, MIRRORS, "loft");
        assert_eq!(run(&mirror, &["remote", "get-url", "origin"]).trim(), remote.to_string_lossy());
        assert!(!fs::read_to_string(mirror.join("config")).unwrap().contains("filter"));
    }
}
