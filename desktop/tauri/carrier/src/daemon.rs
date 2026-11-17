use std::fs::OpenOptions;
use std::io;
use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt};
use std::os::unix::io::AsRawFd;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

/// The environment names the daemon tree itself reads (src/agent-browser-environment.ts,
/// src/server.ts, desktop/daemon-runner.mjs); never NODE_OPTIONS, never arbitrary names.
pub const CHILD_ENV_ALWAYS: &[&str] = &["HOME", "PATH", "TMPDIR"];
/// Development overrides, honoured in a debug build only (same rule as the packaged runtime).
pub const CHILD_ENV_DEBUG_ONLY: &[&str] = &[
    "MASSION_DAEMON_ORIGIN",
    "MASSION_DESKTOP_HTML",
    "MASSION_SURREAL_RPC",
    "MASSION_SURREAL_NAMESPACE",
    "MASSION_SURREAL_DATABASE",
];

/// The environment passed to the supervisor: a cleared environment plus the
/// short named allow-list. In a release build the development overrides never
/// reach the child.
pub fn child_environment() -> Vec<(String, String)> {
    let mut allowed: Vec<&str> = CHILD_ENV_ALWAYS.to_vec();
    if cfg!(debug_assertions) {
        allowed.extend(CHILD_ENV_DEBUG_ONLY);
    }
    std::env::vars().filter(|(name, _)| allowed.contains(&name.as_str())).collect()
}

/// Debug resolution: the MASSION_NODE_BINARY override, else a bare node on PATH.
pub fn node_binary_dev(override_value: Option<String>) -> String {
    override_value.unwrap_or_else(|| "node".into())
}

/// Release resolution: only the executable placed beside the app bundle.
pub fn node_binary_release(app_dir: &Path) -> Result<String, String> {
    let candidate = app_dir.join("node");
    if candidate.is_file() {
        Ok(candidate.to_string_lossy().to_string())
    } else {
        Err("The bundled Node executable is missing".to_string())
    }
}

/// One function decides the Node executable. Debug builds honour the
/// development override; a release build resolves only inside the app bundle
/// and refuses when absent (bundling arrives in T2; until then a release
/// build has no daemon to start, which is the correct result).
pub fn node_binary() -> Result<String, String> {
    if cfg!(debug_assertions) {
        Ok(node_binary_dev(std::env::var("MASSION_NODE_BINARY").ok()))
    } else {
        let beside_app = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| dir.to_path_buf()))
            .unwrap_or_default();
        node_binary_release(&beside_app)
    }
}

/// Starts the supervisor detached: a new process group, stdio to the private
/// log file, not waited on, no secret in argv or environment. The packaged
/// start passes the user data directory as cwd because the supervisor resolves
/// its database folder relative to its working directory; a launch from Finder
/// would otherwise inherit "/". None inherits the caller's directory (development).
pub fn start_detached(node: &str, args: &[String], log_path: &Path, cwd: Option<&Path>) -> io::Result<u32> {
    let log = OpenOptions::new().create(true).append(true).mode(0o600).open(log_path)?;
    let mut command = Command::new(node);
    command
        .args(args)
        .env_clear()
        .envs(child_environment())
        .stdin(std::process::Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .process_group(0);
    if let Some(dir) = cwd {
        command.current_dir(dir);
    }
    command.spawn().map(|child| child.id())
}

/// The same check desktop/daemon.ts applies before asking for the credential:
/// a socket, owned by this user, with no group or other permission.
pub fn socket_is_private(path: &Path) -> io::Result<bool> {
    let metadata = std::fs::metadata(path)?;
    Ok(metadata.file_type().is_socket() && metadata.uid() == unsafe { libc::getuid() } && metadata.mode() & 0o077 == 0)
}

/// An exclusive start lock held across "decide that the socket is stale, remove it,
/// start the supervisor, wait until it listens". flock(2) is the primitive: the kernel
/// releases it when the holder's descriptor closes, so a starter that dies inside the
/// section cannot deadlock the next starter. The lock file lives beside the socket and
/// is never removed.
pub struct StartLock {
    _file: std::fs::File,
}

fn start_lock_path(socket: &Path) -> std::path::PathBuf {
    let mut name = socket.as_os_str().to_os_string();
    name.push(".lock");
    std::path::PathBuf::from(name)
}

pub fn acquire_start_lock(socket: &Path) -> io::Result<StartLock> {
    let file = OpenOptions::new().create(true).truncate(false).write(true).mode(0o600).open(start_lock_path(socket))?;
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(StartLock { _file: file })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupervisorStart {
    /// Another supervisor answered under the lock; nothing was removed or started.
    Existing,
    /// This starter launched the supervisor; it is listening.
    Started(u32),
}

/// The whole start decision under one ownership lock: take the lock, RE-CHECK whether
/// the socket now answers (another starter may have won), then at most remove a stale
/// owned socket, start the supervisor and wait until it listens. A starter that loses
/// the race returns Existing and connects to the winner's supervisor.
pub fn ensure_supervisor(socket: &Path, node: &str, args: &[String], log_path: &Path, timeout: Duration, cwd: Option<&Path>) -> Result<SupervisorStart, String> {
    let _lock = acquire_start_lock(socket).map_err(|_| "The daemon start lock is unavailable".to_string())?;
    if std::os::unix::net::UnixStream::connect(socket).is_ok() {
        return Ok(SupervisorStart::Existing);
    }
    if socket.exists()
        && std::fs::symlink_metadata(socket).map(|meta| meta.file_type().is_socket()).unwrap_or(false)
    {
        if socket_is_private(socket).unwrap_or(false) {
            let _ = std::fs::remove_file(socket);
        } else {
            return Err("Refusing an unowned or exposed daemon socket".to_string());
        }
    }
    let pid = start_detached(node, args, log_path, cwd).map_err(|_| "The supervisor could not start".to_string())?;
    if !wait_for_socket(socket, timeout) {
        return Err("The supervisor did not answer".to_string());
    }
    Ok(SupervisorStart::Started(pid))
}

/// Waits until the socket answers a TCP-style connect (the supervisor listens
/// as soon as it boots; core readiness is the daemon's own concern).
pub fn wait_for_socket(path: &Path, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(metadata) = std::fs::metadata(path) {
            if metadata.file_type().is_socket() && std::os::unix::net::UnixStream::connect(path).is_ok() {
                return true;
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}
