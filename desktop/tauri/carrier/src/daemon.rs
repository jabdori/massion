use std::fs::OpenOptions;
use std::io;
use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

/// One function decides the Node executable: MASSION_NODE_BINARY, else PATH
/// (the bundled runtime file joins here in T2).
pub fn node_binary() -> String {
    std::env::var("MASSION_NODE_BINARY").unwrap_or_else(|_| "node".into())
}

/// Starts the supervisor detached: a new process group, stdio to the private
/// log file, not waited on, no secret in argv or environment.
pub fn start_detached(node: &str, args: &[String], log_path: &Path) -> io::Result<u32> {
    let log = OpenOptions::new().create(true).append(true).mode(0o600).open(log_path)?;
    Command::new(node)
        .args(args)
        .env_remove("MASSION_SURREALDB_BINARY")
        .stdin(std::process::Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .process_group(0)
        .spawn()
        .map(|child| child.id())
}

/// The same check desktop/daemon.ts applies before asking for the credential:
/// a socket, owned by this user, with no group or other permission.
pub fn socket_is_private(path: &Path) -> io::Result<bool> {
    let metadata = std::fs::metadata(path)?;
    Ok(metadata.file_type().is_socket() && metadata.uid() == unsafe { libc::getuid() } && metadata.mode() & 0o077 == 0)
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
