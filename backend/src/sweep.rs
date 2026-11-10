//! The sweep: deletes rebuildable build output (`target/`, `node_modules/`, `.build/`, `ios/build/`,
//! `DerivedData/`, `.cargo-build/`) from the clones in agents' workspaces that haven't changed in 3 days, so
//! they don't fill the disk. Source, git state and notes stay. A clone idle 7 days that can't lose anything
//! (clean, every commit on a remote branch) and isn't the newest clone of its repo in the workspace goes whole.
//!
//! It runs once a day, before Loft restarts into an update, and on a workspace whose agent was deleted with its
//! files kept. It skips running agents and agents with a live process (a dev server), never follows a symlink,
//! and never removes anything outside the agents' folder (`agent-local-storage/`), so Loft's own checkout stays.

use std::collections::{HashMap, HashSet};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use chrono::{DateTime, Local};
use serde::Serialize;

use crate::state::AppState;

/// A clone untouched this long loses its build output.
const IDLE: Duration = Duration::from_secs(3 * 24 * 60 * 60);
/// A clone idle this long, clean and pushed, is removed unless it's its repo's newest in the workspace.
const FINISHED: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// How deep in a workspace clones are looked for (`<workspace>/a/b/<clone>`).
const DEPTH: usize = 3;
/// How often the day's sweep runs.
const EVERY: Duration = Duration::from_secs(24 * 60 * 60);

/// What a sweep removed and how much it freed.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Report {
    pub at: Option<DateTime<Local>>,
    pub removed: Vec<PathBuf>,
    pub freed_bytes: u64,
}

/// One sweep at a time.
static RUNNING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Sweeps every workspace but those of running agents and agents with a live process, or just `only`'s.
/// Records and returns what it removed.
pub async fn run(state: &AppState, only: Option<&str>) -> Report {
    let _one = RUNNING.lock().await;
    let storage = state.cfg.storage_dir.clone();
    let running: HashSet<String> = state.rt.lock().unwrap().running.keys().cloned().collect();
    let only = only.map(str::to_string);
    let r = tokio::task::spawn_blocking(move || {
        let mut skip = running;
        skip.extend(crate::processes::with_live_processes(&storage));
        sweep(&storage, only.as_deref(), &skip, SystemTime::now())
    })
    .await
    .unwrap_or_default();
    tracing::info!("sweep freed {} bytes in {} folders: {:?}", r.freed_bytes, r.removed.len(), r.removed);
    state.rt.lock().unwrap().sweep = r.clone();
    r
}

/// The day's sweep, the first right after Loft starts.
pub async fn scheduler(state: AppState) {
    let mut tick = tokio::time::interval(EVERY);
    loop {
        tick.tick().await;
        run(&state, None).await;
    }
}

/// Sweeps the workspaces in `storage` (or only `only`'s), skipping the agent ids in `skip`, as of `now`.
pub fn sweep(storage: &Path, only: Option<&str>, skip: &HashSet<String>, now: SystemTime) -> Report {
    let mut r = Report { at: Some(Local::now()), ..Default::default() };
    let Ok(root) = storage.canonicalize() else { return r };
    for e in std::fs::read_dir(&root).into_iter().flatten().flatten() {
        let id = e.file_name().to_string_lossy().to_string();
        // `.agent-files` and the like are Loft's; a symlinked workspace leads outside.
        let is_dir = e.file_type().is_ok_and(|t| t.is_dir());
        if id.starts_with('.') || !is_dir || skip.contains(&id) || only.is_some_and(|o| o != id) {
            continue;
        }
        workspace(&root, &e.path(), now, &mut r);
    }
    r
}

fn workspace(root: &Path, ws: &Path, now: SystemTime, r: &mut Report) {
    let mut clones = vec![];
    find_clones(ws, DEPTH, &mut clones);
    let mut found = vec![];
    for clone in &clones {
        let mut builds = vec![];
        let mut newest = git_time(clone);
        walk(clone, &mut builds, &mut newest);
        found.push((clone, builds, now.duration_since(newest).unwrap_or_default(), repo(clone)));
    }
    // Each repo's newest clone is the agent's working copy.
    let mut least_idle: HashMap<&str, Duration> = HashMap::new();
    for (_, _, idle, repo) in &found {
        least_idle.entry(repo).and_modify(|d| *d = (*d).min(*idle)).or_insert(*idle);
    }
    let mut all_idle = true;
    for (clone, builds, idle, repo) in &found {
        let holds_clones = clones.iter().any(|c| c != *clone && c.starts_with(clone));
        if *idle >= FINISHED && least_idle[repo.as_str()] < *idle && !holds_clones && finished(clone) {
            remove_clone(root, clone, r);
        } else if *idle >= IDLE {
            for b in builds {
                remove(root, b, r);
            }
        } else {
            all_idle = false;
        }
    }
    // Compiled dependencies all the workspace's clones share: kept while any of them is in use.
    if all_idle {
        remove(root, &ws.join(".cargo-build"), r);
    }
}

/// Real (not symlinked) directories, never a dotfile one.
fn subdirs(dir: &Path) -> impl Iterator<Item = (String, PathBuf)> {
    std::fs::read_dir(dir).into_iter().flatten().flatten().filter_map(|e| {
        let name = e.file_name().to_string_lossy().to_string();
        (e.file_type().ok()?.is_dir() && !name.starts_with('.')).then(|| (name, e.path()))
    })
}

/// The git clones in `dir`, down to `depth` levels, nested ones included.
fn find_clones(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if dir.join(".git").symlink_metadata().is_ok() {
        out.push(dir.to_path_buf());
    }
    if depth == 0 {
        return;
    }
    for (name, path) in subdirs(dir) {
        if !is_build(dir, &name) {
            find_clones(&path, depth - 1, out);
        }
    }
}

/// Whether `parent/name` is build output.
fn is_build(parent: &Path, name: &str) -> bool {
    match name {
        "node_modules" | "DerivedData" => true,
        "target" => parent.join("Cargo.toml").exists(),
        "build" => parent.file_name().is_some_and(|n| n == "ios"),
        _ => false,
    }
}

/// Collects the clone's build folders and the newest change to any other file in it, stopping at nested clones.
/// Folders' own times don't count: emptying `frontend/node_modules` would make the clone look fresh.
fn walk(dir: &Path, builds: &mut Vec<PathBuf>, newest: &mut SystemTime) {
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        // Not followed: a symlink's own metadata.
        let Ok(meta) = e.metadata() else { continue };
        if !meta.is_dir() {
            *newest = (*newest).max(meta.modified().unwrap_or(SystemTime::UNIX_EPOCH));
            continue;
        }
        if name == ".git" {
            continue;
        }
        let path = e.path();
        if name == ".build" || name == ".cargo-build" || is_build(dir, &name) {
            builds.push(path);
        } else if path.join(".git").symlink_metadata().is_err() {
            walk(&path, builds, newest);
        }
    }
}

/// When the clone's git state last changed: a commit, checkout, add or fetch.
fn git_time(clone: &Path) -> SystemTime {
    let dot = clone.join(".git");
    // A worktree's `.git` is a file naming its git dir.
    let dir = match std::fs::read_to_string(&dot) {
        Ok(s) => s.trim().strip_prefix("gitdir:").map(|d| clone.join(d.trim())).unwrap_or(dot),
        Err(_) => dot,
    };
    ["index", "HEAD", "logs/HEAD", "FETCH_HEAD"]
        .iter()
        .filter_map(|f| dir.join(f).symlink_metadata().ok()?.modified().ok())
        .max()
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

/// Runs git in `dir` without taking optional locks, so reading doesn't refresh the index, and without fetching
/// missing objects from a promisor remote, which runs that remote's transport; its output if it succeeded.
fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(crate::repos::SAFE_GIT)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_NO_LAZY_FETCH", "1")
        .output()
        .ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// The repo a clone is of: its origin, or the clone itself when it has none.
fn repo(clone: &Path) -> String {
    git(clone, &["config", "--get", "remote.origin.url"]).filter(|u| !u.is_empty()).unwrap_or_else(|| clone.display().to_string())
}

/// Whether removing the clone loses nothing: no changes, no untracked files, every commit on a remote branch.
/// A worktree's branches stay in its base clone, so only its HEAD counts there.
fn finished(clone: &Path) -> bool {
    let refs = if clone.join(".git").is_file() { "HEAD" } else { "--all" };
    status_runs_nothing(clone)
        && git(clone, &["status", "--porcelain", "--untracked-files=all"]).is_some_and(|s| s.is_empty())
        && git(clone, &["rev-list", "-n1", refs, "--not", "--remotes"]).is_some_and(|s| s.is_empty())
}

/// Whether `git status` in the clone runs no command its own config sets. The agent owns that config, and the
/// sweep runs as Loft, so a clone whose config has any key outside [`plain_key`] stays (filter drivers, promisor
/// remotes, ssh commands and whatever comes next), and so does one with submodules, which status enters with
/// their own config. The user's global and system config are theirs, so a git-lfs filter there doesn't count.
fn status_runs_nothing(clone: &Path) -> bool {
    let repo_key = |l: &str| match l.split_once('\t') {
        Some(("local" | "worktree", k)) => !plain_key(k),
        _ => false,
    };
    git(clone, &["config", "--list", "--includes", "--name-only", "--show-scope"]).is_some_and(|keys| !keys.lines().any(repo_key))
        && !clone.join(".gitmodules").exists()
        && git(clone, &["ls-files", "--stage"]).is_some_and(|s| !s.lines().any(|l| l.starts_with("160000 ")))
}

/// A config key `git clone` or Loft's base clones set, which no git command turns into a command to run.
fn plain_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    let Some((section, rest)) = key.split_once('.') else { return false };
    let name = rest.rsplit_once('.').map_or(rest, |(_, n)| n);
    match section {
        // `core.hookspath` is Loft's own on base clones, and the sweep turns hooks off anyway.
        "core" => !rest.contains('.') && matches!(name, "repositoryformatversion" | "filemode" | "bare" | "logallrefupdates" | "ignorecase" | "precomposeunicode" | "hookspath"),
        // `gh-resolved` is what `gh` records for the default repo.
        "remote" => rest.contains('.') && matches!(name, "url" | "fetch" | "gh-resolved"),
        "branch" => rest.contains('.') && matches!(name, "remote" | "merge"),
        "user" => !rest.contains('.') && matches!(name, "name" | "email"),
        _ => false,
    }
}

/// Removes a whole clone; a worktree is also dropped from its base clone's list.
fn remove_clone(root: &Path, clone: &Path, r: &mut Report) {
    let base = clone.join(".git").is_file().then(|| git(clone, &["rev-parse", "--path-format=absolute", "--git-common-dir"])).flatten();
    remove(root, clone, r);
    if let Some(base) = base {
        git(Path::new(&base), &["worktree", "prune"]);
    }
}

/// Removes `path` when it is a real directory inside `root`, adding it and its size to the report.
fn remove(root: &Path, path: &Path, r: &mut Report) {
    if !path.symlink_metadata().is_ok_and(|m| m.is_dir()) || !path.canonicalize().is_ok_and(|p| p.starts_with(root)) {
        return;
    }
    let size = du(path);
    // Removes symlinks inside, not what they point at.
    match std::fs::remove_dir_all(path) {
        Ok(()) => {
            r.removed.push(path.to_path_buf());
            r.freed_bytes += size;
        }
        Err(e) => tracing::warn!("sweep: can't remove {}: {e}", path.display()),
    }
}

/// Disk space `path` takes, symlinks not followed.
fn du(path: &Path) -> u64 {
    let Ok(meta) = path.symlink_metadata() else { return 0 };
    let mut n = meta.blocks() * 512;
    if meta.is_dir() {
        for e in std::fs::read_dir(path).into_iter().flatten().flatten() {
            n += du(&e.path());
        }
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("loft-sweep-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    fn file(p: &Path) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, "x").unwrap();
    }

    /// A clone with Rust, web and iOS build output.
    fn clone(dir: &Path) {
        for f in [".git/HEAD", ".git/index", "Cargo.toml", "src/main.rs", "ios/App/App.swift", "frontend/package.json"] {
            file(&dir.join(f));
        }
        for f in ["target/debug/app", "frontend/node_modules/vite/index.js", "ios/build/App.app/App", "ios/DerivedData/x", "Pkg/.build/x"] {
            file(&dir.join(f));
        }
    }

    fn later() -> SystemTime {
        SystemTime::now() + Duration::from_secs(4 * 24 * 60 * 60)
    }

    #[test]
    fn an_idle_clone_loses_its_build_output_and_keeps_source_git_and_notes() {
        let storage = temp();
        let ws = storage.join("a");
        clone(&ws.join("loft"));
        file(&ws.join("notes/plan.md"));
        file(&ws.join(".cargo-build/debug/deps/x"));
        // A folder named `target` that isn't Cargo's, and a non-git folder's node_modules.
        file(&ws.join("loft/docs/target/keep.md"));
        file(&ws.join("scratch/node_modules/keep.js"));

        let r = sweep(&storage, None, &HashSet::new(), later());

        for gone in ["loft/target", "loft/frontend/node_modules", "loft/ios/build", "loft/ios/DerivedData", "loft/Pkg/.build", ".cargo-build"] {
            assert!(!ws.join(gone).exists(), "{gone} stays");
            assert!(r.removed.contains(&ws.join(gone)), "{gone} not reported");
        }
        for kept in ["loft/.git/HEAD", "loft/Cargo.toml", "loft/src/main.rs", "loft/ios/App/App.swift", "loft/docs/target/keep.md", "notes/plan.md", "scratch/node_modules/keep.js"] {
            assert!(ws.join(kept).exists(), "{kept} removed");
        }
        assert_eq!(r.removed.len(), 6);
        assert!(r.freed_bytes > 0);
    }

    /// Dates everything in `dir` 4 days back.
    fn age(dir: &Path) {
        let then = SystemTime::now() - Duration::from_secs(4 * 24 * 60 * 60);
        for e in fs::read_dir(dir).unwrap().flatten() {
            if e.file_type().unwrap().is_dir() {
                age(&e.path());
            }
            fs::File::open(e.path()).unwrap().set_modified(then).unwrap();
        }
        fs::File::open(dir).unwrap().set_modified(then).unwrap();
    }

    #[test]
    fn a_running_agent_s_workspace_and_a_fresh_clone_are_skipped() {
        let storage = temp();
        clone(&storage.join("running/loft"));
        clone(&storage.join("idle/old"));
        age(&storage.join("running"));
        age(&storage.join("idle/old"));
        clone(&storage.join("idle/fresh"));

        let r = sweep(&storage, None, &HashSet::from(["running".to_string()]), SystemTime::now());

        assert!(!storage.join("idle/old/target").exists(), "an idle clone keeps its build output");
        assert!(storage.join("idle/fresh/target").exists(), "a fresh clone lost its build output");
        assert!(storage.join("running/loft/target").exists(), "a running agent's build output was removed");
        assert!(r.removed.iter().all(|p| p.starts_with(storage.join("idle/old"))), "{:?}", r.removed);
    }

    #[test]
    fn one_workspace_alone_is_swept_when_named() {
        let storage = temp();
        clone(&storage.join("a/loft"));
        clone(&storage.join("b/loft"));
        sweep(&storage, Some("a"), &HashSet::new(), later());
        assert!(!storage.join("a/loft/target").exists());
        assert!(storage.join("b/loft/target").exists());
    }

    #[test]
    fn symlinks_are_not_followed_and_nothing_outside_the_agents_folder_is_touched() {
        let root = temp();
        let storage = root.join("agent-local-storage");
        // Loft's own checkout, next to the agents' folder, and another folder outside it.
        let loft = root.join("loft");
        clone(&loft);
        let outside = root.join("outside");
        file(&outside.join("lib/index.js"));

        let ws = storage.join("a");
        clone(&ws.join("app"));
        std::os::unix::fs::symlink(&loft, ws.join("loft")).unwrap();
        fs::create_dir_all(ws.join("app/web")).unwrap();
        std::os::unix::fs::symlink(&outside, ws.join("app/web/node_modules")).unwrap();
        std::os::unix::fs::symlink(&outside, ws.join("app/target/linked")).unwrap();
        // A whole workspace that is a symlink to Loft's checkout.
        std::os::unix::fs::symlink(&loft, storage.join("b")).unwrap();

        let r = sweep(&storage, None, &HashSet::new(), later());

        assert!(!ws.join("app/target").exists(), "the real target/ is removed");
        assert!(ws.join("app/web/node_modules").symlink_metadata().is_ok(), "a symlinked node_modules is left alone");
        for kept in ["target/debug/app", "frontend/node_modules/vite/index.js", "ios/build/App.app/App"] {
            assert!(loft.join(kept).exists(), "Loft's checkout lost {kept}");
        }
        assert!(outside.join("lib/index.js").exists(), "a symlink target was removed");
        assert!(r.removed.iter().all(|p| p.starts_with(&storage)), "{:?}", r.removed);
    }

    #[test]
    fn a_worktree_counts_its_git_dir_s_changes() {
        let storage = temp();
        let ws = storage.join("a");
        clone(&ws.join("wt"));
        fs::remove_dir_all(ws.join("wt/.git")).unwrap();
        file(&ws.join("main/.git/worktrees/wt/HEAD"));
        fs::write(ws.join("wt/.git"), "gitdir: ../main/.git/worktrees/wt\n").unwrap();
        assert!(git_time(&ws.join("wt")) > SystemTime::UNIX_EPOCH);
    }

    fn sh(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git").arg("-C").arg(dir).args(["-c", "user.name=T", "-c", "user.email=t@example.com"]).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// A repo with one commit, to clone from.
    fn origin(dir: &Path) {
        file(&dir.join("README.md"));
        sh(dir, &["init", "-q", "-b", "main"]);
        sh(dir, &["add", "."]);
        sh(dir, &["commit", "-qm", "first"]);
    }

    fn git_clone(from: &Path, to: &Path) {
        sh(from.parent().unwrap(), &["clone", "-q", from.to_str().unwrap(), to.to_str().unwrap()]);
    }

    /// A week and a day from now: every clone below is idle 7+ days.
    fn week_later() -> SystemTime {
        SystemTime::now() + Duration::from_secs(8 * 24 * 60 * 60)
    }

    #[test]
    fn a_finished_clone_is_removed_and_one_that_could_lose_work_stays() {
        let storage = temp();
        let (src, other) = (storage.join(".src"), storage.join(".other"));
        origin(&src);
        origin(&other);
        let ws = storage.join("a");
        for c in ["done", "ahead", "changed", "untracked", "stashed"] {
            git_clone(&src, &ws.join(c));
        }
        file(&ws.join("ahead/new.rs"));
        sh(&ws.join("ahead"), &["add", "."]);
        sh(&ws.join("ahead"), &["commit", "-qm", "unpushed"]);
        fs::write(ws.join("changed/README.md"), "edited").unwrap();
        file(&ws.join("untracked/notes.md"));
        fs::write(ws.join("stashed/README.md"), "edited").unwrap();
        sh(&ws.join("stashed"), &["stash", "-q"]);
        // The only clone of its repo, and a folder that isn't a clone.
        git_clone(&other, &ws.join("lone"));
        file(&ws.join("notes/plan.md"));
        age(&ws);
        // The agent's working copy of `src`.
        git_clone(&src, &ws.join("current"));

        let r = sweep(&storage, None, &HashSet::new(), week_later());

        assert!(!ws.join("done").exists(), "a clean, pushed clone stays");
        assert_eq!(r.removed, vec![ws.join("done")]);
        assert!(r.freed_bytes > 0);
        for kept in ["ahead/new.rs", "changed/README.md", "untracked/notes.md", "stashed/README.md", "lone/README.md", "current/README.md", "notes/plan.md"] {
            assert!(ws.join(kept).exists(), "{kept} removed");
        }
    }

    #[test]
    fn a_clone_with_a_filter_driver_or_a_submodule_stays_and_runs_nothing() {
        let storage = temp();
        let src = storage.join(".src");
        origin(&src);
        fs::write(src.join(".gitattributes"), "* filter=x\n").unwrap();
        sh(&src, &["add", "."]);
        sh(&src, &["commit", "-qm", "attrs"]);
        let ws = storage.join("a");
        git_clone(&src, &ws.join("filtered"));
        git_clone(&src, &ws.join("sub"));
        let marker = storage.join("PWNED");
        sh(&ws.join("filtered"), &["config", "filter.x.clean", &format!("sh -c 'echo ran >> {}; cat'", marker.display())]);
        let head = std::process::Command::new("git").arg("-C").arg(&src).args(["rev-parse", "HEAD"]).output().unwrap();
        let gitlink = format!("160000,{},lib", String::from_utf8_lossy(&head.stdout).trim());
        sh(&ws.join("sub"), &["update-index", "--add", "--cacheinfo", &gitlink]);
        age(&ws);
        // Same content, newer time: status would run the clean filter on it.
        fs::write(ws.join("filtered/README.md"), "x").unwrap();
        git_clone(&src, &ws.join("current"));

        let r = sweep(&storage, None, &HashSet::new(), week_later());

        assert!(!marker.exists(), "the clone's filter ran");
        assert!(!status_runs_nothing(&ws.join("sub")), "a clone with a submodule counts as safe");
        assert!(r.removed.is_empty(), "removed {:?}", r.removed);
    }

    #[test]
    fn a_clone_with_a_promisor_remote_stays_and_runs_nothing() {
        let storage = temp();
        let src = storage.join(".src");
        origin(&src);
        let ws = storage.join("a");
        let evil = ws.join("evil");
        git_clone(&src, &evil);
        // A commit the clone doesn't have, for status to lazy-fetch.
        file(&src.join("new.md"));
        sh(&src, &["add", "."]);
        sh(&src, &["commit", "-qm", "second"]);
        let head = std::process::Command::new("git").arg("-C").arg(&src).args(["rev-parse", "HEAD"]).output().unwrap();
        let marker = storage.join("PWNED");
        sh(&evil, &["config", "extensions.partialClone", "evil"]);
        sh(&evil, &["config", "remote.evil.promisor", "true"]);
        sh(&evil, &["config", "remote.evil.url", src.to_str().unwrap()]);
        sh(&evil, &["config", "remote.evil.uploadpack", &format!("sh -c 'echo ran >> {}; exit 1' #", marker.display())]);
        fs::write(evil.join(".git/refs/heads/main"), &head.stdout).unwrap();
        age(&ws);
        git_clone(&src, &ws.join("current"));

        // Status and rev-list alone, without the config check, fetch nothing either.
        assert!(git(&evil, &["status", "--porcelain"]).is_none());
        let r = sweep(&storage, None, &HashSet::new(), week_later());

        assert!(!marker.exists(), "the promisor remote's command ran");
        assert!(r.removed.is_empty(), "removed {:?}", r.removed);
    }

    #[test]
    fn only_keys_that_run_nothing_count_as_plain() {
        for k in ["core.repositoryformatversion", "core.ignoreCase", "remote.origin.url", "remote.my.fork.fetch", "branch.main.merge", "user.email"] {
            assert!(plain_key(k), "{k}");
        }
        for k in ["core.sshCommand", "core.fsmonitor", "core.x.bare", "remote.origin.uploadpack", "remote.origin.promisor", "remote.url", "extensions.partialclone", "filter.x.clean", "submodule.a.url", "include.path", "protocol.ext.allow", "user.x.name"] {
            assert!(!plain_key(k), "{k}");
        }
    }

    #[test]
    fn a_clone_idle_under_a_week_stays() {
        let storage = temp();
        let src = storage.join(".src");
        origin(&src);
        git_clone(&src, &storage.join("a/old"));
        age(&storage.join("a"));
        git_clone(&src, &storage.join("a/new"));
        sweep(&storage, None, &HashSet::new(), SystemTime::now());
        assert!(storage.join("a/old/README.md").exists());
    }

    #[test]
    fn a_finished_worktree_is_removed_and_dropped_from_its_base_clone() {
        let storage = temp();
        let src = storage.join(".src");
        origin(&src);
        let base = storage.join(".repos/src");
        git_clone(&src, &base);
        let ws = storage.join("a");
        sh(&base, &["worktree", "add", "-q", "-b", "x", ws.join("src-x").to_str().unwrap(), "origin/main"]);
        age(&storage.join(".repos"));
        age(&ws);
        sh(&base, &["worktree", "add", "-q", "-b", "y", ws.join("src-y").to_str().unwrap(), "origin/main"]);

        let r = sweep(&storage, None, &HashSet::new(), week_later());

        assert_eq!(r.removed, vec![ws.join("src-x")]);
        assert!(ws.join("src-y/README.md").exists(), "the newest worktree was removed");
        let out = std::process::Command::new("git").arg("-C").arg(&base).args(["worktree", "list"]).output().unwrap();
        assert!(!String::from_utf8_lossy(&out.stdout).contains("src-x"), "the base clone still lists it");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn deleting_an_agent_but_keeping_its_files_sweeps_its_workspace() {
        let st = crate::tasks::tests::state();
        let a = crate::tasks::tests::agent(&st, "Gone");
        let ws = crate::agents::workspace(&st, &a.id);
        clone(&ws.join("loft"));
        age(&ws);

        let uri: axum::http::Uri = "/?purge_files=false".parse().unwrap();
        let opts = axum::extract::Query::try_from_uri(&uri).unwrap();
        let _ = crate::api::delete_agent(axum::extract::State(st.clone()), axum::extract::Path(a.id.clone()), opts).await.ok().unwrap();

        for _ in 0..50 {
            if !ws.join("loft/target").exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(!ws.join("loft/target").exists(), "the kept workspace's build output stays");
        assert!(ws.join("loft/src/main.rs").exists());
    }
}
