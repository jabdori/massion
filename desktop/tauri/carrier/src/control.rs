use socket2::{Domain, SockAddr, Socket, Type};
use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::{mpsc, Condvar, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

// The drain inactivity bound of the Node control client in desktop/daemon.ts.
pub const DRAIN_TIMEOUT: Duration = Duration::from_secs(60);
// The status request timeout of the Node control client in desktop/daemon.ts.
pub const STATUS_TIMEOUT: Duration = Duration::from_secs(1);
const MAX_CONTROL_REPLY: usize = 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DrainFailure {
    StartFailed,
    NotConnected,
    NoAnswer,
    Disconnected,
    TransportError,
    Unsettled,
    UnexpectedStatus,
    TruncatedReply,
    InvalidReply,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StatusError {
    NotListening,
    NotPrivate,
    NoAnswer,
    Disconnected,
    TransportError,
    TruncatedReply,
    InvalidReply,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StatusReply {
    pub status: String,
    #[serde(default)]
    pub pid: Option<u64>,
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub draining: bool,
    #[serde(default)]
    pub cause: Option<String>,
    #[serde(default)]
    pub detail: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct DrainReply {
    status: String,
}

#[derive(Clone, Copy)]
enum ReplyReadError {
    NoAnswer,
    Disconnected,
    TransportError,
    TruncatedReply,
    InvalidReply,
}

impl From<ReplyReadError> for DrainFailure {
    fn from(error: ReplyReadError) -> Self {
        match error {
            ReplyReadError::NoAnswer => Self::NoAnswer,
            ReplyReadError::Disconnected => Self::Disconnected,
            ReplyReadError::TransportError => Self::TransportError,
            ReplyReadError::TruncatedReply => Self::TruncatedReply,
            ReplyReadError::InvalidReply => Self::InvalidReply,
        }
    }
}

impl From<ReplyReadError> for StatusError {
    fn from(error: ReplyReadError) -> Self {
        match error {
            ReplyReadError::NoAnswer => Self::NoAnswer,
            ReplyReadError::Disconnected => Self::Disconnected,
            ReplyReadError::TransportError => Self::TransportError,
            ReplyReadError::TruncatedReply => Self::TruncatedReply,
            ReplyReadError::InvalidReply => Self::InvalidReply,
        }
    }
}

pub fn query_status(path: &Path, timeout: Duration) -> Result<StatusReply, StatusError> {
    query_status_with(path, timeout, Read::read_to_end)
}

fn query_status_with(
    path: &Path,
    timeout: Duration,
    read: impl FnOnce(&mut io::Take<UnixStream>, &mut Vec<u8>) -> io::Result<usize>,
) -> Result<StatusReply, StatusError> {
    match crate::daemon::socket_is_private(path) {
        Ok(true) => {}
        Ok(false) => return Err(StatusError::NotPrivate),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(StatusError::NotListening);
        }
        Err(_) => return Err(StatusError::TransportError),
    }
    let mut stream = UnixStream::connect(path).map_err(|error| match error.kind() {
        io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused => StatusError::NotListening,
        _ => StatusError::TransportError,
    })?;
    let bounded = timeout.min(STATUS_TIMEOUT);
    if bounded.is_zero() {
        return Err(StatusError::NoAnswer);
    }
    stream
        .set_read_timeout(Some(bounded))
        .map_err(|_| StatusError::TransportError)?;
    stream
        .set_write_timeout(Some(bounded))
        .map_err(|_| StatusError::TransportError)?;
    stream
        .write_all(b"status\n")
        .map_err(|error| StatusError::from(reply_io_failure(error)))?;
    stream
        .shutdown(Shutdown::Write)
        .map_err(|error| StatusError::from(reply_io_failure(error)))?;
    read_json_reply(stream, read).map_err(StatusError::from)
}

pub fn drain(path: &Path) -> Result<(), DrainFailure> {
    match DrainConnection::connect(path)? {
        // Nothing of ours to drain: the supervisor is already gone.
        None => Ok(()),
        Some(connection) => connection.drain_if(|| Some(())),
    }
}

pub struct DrainConnection(UnixStream);

struct ConnectWorkers {
    active: Mutex<usize>,
    available: Condvar,
}

impl ConnectWorkers {
    const fn new() -> Self {
        Self {
            active: Mutex::new(0),
            available: Condvar::new(),
        }
    }

    fn connect_until(
        &'static self,
        path: &Path,
        deadline: Instant,
        lookup: impl FnOnce(&Path) -> io::Result<bool> + Send + 'static,
    ) -> Result<Option<DrainConnection>, DrainFailure> {
        let active = self.active.lock().unwrap_or_else(PoisonError::into_inner);
        // Leave room for one retry behind a stuck syscall. A worker keeps its permit
        // until the syscall returns, even if its caller has timed out.
        let (mut active, timed_out) = self
            .available
            .wait_timeout_while(
                active,
                deadline.saturating_duration_since(Instant::now()),
                |active| *active == 2,
            )
            .unwrap_or_else(PoisonError::into_inner);
        if timed_out.timed_out() || Instant::now() >= deadline {
            return Err(DrainFailure::NoAnswer);
        }
        *active += 1;
        drop(active);

        let permit = ConnectPermit(self);
        let path = path.to_owned();
        let (send, receive) = mpsc::channel();
        thread::Builder::new()
            .spawn(move || {
                let _permit = permit;
                let _ = send.send(DrainConnection::connect_path_until(&path, deadline, lookup));
            })
            .map_err(|_| DrainFailure::TransportError)?;
        let outcome = receive.recv_timeout(deadline.saturating_duration_since(Instant::now()));
        if Instant::now() >= deadline {
            return Err(DrainFailure::NoAnswer);
        }
        match outcome {
            Ok(outcome) => outcome,
            Err(mpsc::RecvTimeoutError::Timeout) => Err(DrainFailure::NoAnswer),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(DrainFailure::TransportError),
        }
    }
}

struct ConnectPermit(&'static ConnectWorkers);

impl Drop for ConnectPermit {
    fn drop(&mut self) {
        *self.0.active.lock().unwrap_or_else(PoisonError::into_inner) -= 1;
        self.0.available.notify_all();
    }
}

impl DrainConnection {
    /// Ok(None) means there is nothing of ours to drain: the socket path does
    /// not exist, nothing listens at it any more, or the path is not this
    /// user's private socket. Nothing is written to, removed at or signalled
    /// through that path on the way to Ok(None).
    pub fn connect(path: &Path) -> Result<Option<Self>, DrainFailure> {
        Self::connect_until(path, Instant::now() + DRAIN_TIMEOUT)
    }

    pub fn connect_until(path: &Path, deadline: Instant) -> Result<Option<Self>, DrainFailure> {
        static WORKERS: ConnectWorkers = ConnectWorkers::new();
        WORKERS.connect_until(path, deadline, crate::daemon::socket_is_private)
    }

    fn connect_path_until(
        path: &Path,
        deadline: Instant,
        lookup: impl FnOnce(&Path) -> io::Result<bool>,
    ) -> Result<Option<Self>, DrainFailure> {
        if Instant::now() >= deadline {
            return Err(DrainFailure::NoAnswer);
        }
        let private = lookup(path);
        if Instant::now() >= deadline {
            return Err(DrainFailure::NoAnswer);
        }
        match private {
            Ok(true) => {}
            // Not ours: a directory, another owner or wider permissions.
            Ok(false) => return Ok(None),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            // For example a permission error reading the path: something may
            // well be there, so this stays a failure instead of a claimed drain.
            Err(_) => return Err(DrainFailure::NotConnected),
        }
        let connection = connect_unix_until(path, deadline);
        if Instant::now() >= deadline {
            return Err(DrainFailure::NoAnswer);
        }
        let stream = match connection {
            Ok(stream) => stream,
            // A stale socket file, or a path that disappeared after the check:
            // nothing listens any more.
            Err(error) => match error.kind() {
                io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused => return Ok(None),
                io::ErrorKind::TimedOut => return Err(DrainFailure::NoAnswer),
                _ => return Err(DrainFailure::NotConnected),
            },
        };
        stream
            .set_read_timeout(Some(DRAIN_TIMEOUT))
            .map_err(|_| DrainFailure::TransportError)?;
        Ok(Some(Self(stream)))
    }

    /// Interrupt an in-flight drain read without taking ownership of the connection.
    pub fn shutdown_handle(&self) -> Result<impl FnOnce() + Send + 'static, DrainFailure> {
        let stream = self
            .0
            .try_clone()
            .map_err(|_| DrainFailure::TransportError)?;
        Ok(move || {
            let _ = stream.shutdown(Shutdown::Both);
        })
    }

    /// Keep the identity check on the socket that would receive the drain.
    pub fn verify_peer(&self, expected_pid: u32) -> Result<(), DrainFailure> {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            use std::os::fd::AsRawFd;
            #[cfg(target_os = "macos")]
            let (level, option, mut credential) =
                (libc::SOL_LOCAL, libc::LOCAL_PEERPID, 0 as libc::pid_t);
            #[cfg(target_os = "linux")]
            let (level, option, mut credential) = (
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                libc::ucred {
                    pid: 0,
                    uid: 0,
                    gid: 0,
                },
            );
            let expected_length = std::mem::size_of_val(&credential) as libc::socklen_t;
            let mut length = expected_length;
            // The connected descriptor stays open, and the buffer has the size of the requested credential.
            let result = unsafe {
                libc::getsockopt(
                    self.0.as_raw_fd(),
                    level,
                    option,
                    std::ptr::addr_of_mut!(credential).cast(),
                    &mut length,
                )
            };
            #[cfg(target_os = "macos")]
            let pid = credential;
            #[cfg(target_os = "linux")]
            let pid = credential.pid;
            if result == 0 && length == expected_length && u32::try_from(pid) == Ok(expected_pid) {
                return Ok(());
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        let _ = expected_pid;
        Err(DrainFailure::NotConnected)
    }

    pub fn drain_if<G>(self, authorize: impl FnOnce() -> Option<G>) -> Result<(), DrainFailure> {
        self.drain_with(authorize, Read::read_to_end)
    }

    fn drain_with<G>(
        self,
        authorize: impl FnOnce() -> Option<G>,
        read: impl FnOnce(&mut io::Take<UnixStream>, &mut Vec<u8>) -> io::Result<usize>,
    ) -> Result<(), DrainFailure> {
        let mut stream = self.0;
        // The caller can hold its attempt lock across the request without blocking on I/O.
        stream
            .set_nonblocking(true)
            .map_err(|_| DrainFailure::TransportError)?;
        {
            let _permission = authorize().ok_or(DrainFailure::NoAnswer)?;
            stream
                .write_all(b"drain\n")
                .map_err(|error| DrainFailure::from(reply_io_failure(error)))?;
            stream
                .shutdown(Shutdown::Write)
                .map_err(|error| DrainFailure::from(reply_io_failure(error)))?;
        }
        stream
            .set_nonblocking(false)
            .map_err(|_| DrainFailure::TransportError)?;
        let reply: DrainReply = read_json_reply(stream, read)?;
        match reply.status.as_str() {
            "drained" => Ok(()),
            "unsettled" => Err(DrainFailure::Unsettled),
            _ => Err(DrainFailure::UnexpectedStatus),
        }
    }
}

fn connect_unix_until(path: &Path, deadline: Instant) -> io::Result<UnixStream> {
    let address = SockAddr::unix(path)?;
    let socket = Socket::new(Domain::UNIX, Type::STREAM, None)?;
    #[cfg(not(target_os = "linux"))]
    {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::ErrorKind::TimedOut.into());
        }
        socket.connect_timeout(&address, remaining)?;
    }
    #[cfg(target_os = "linux")]
    {
        socket.set_nonblocking(true)?;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(io::ErrorKind::TimedOut.into());
            }
            match socket.connect(&address) {
                Ok(()) => break,
                // A full AF_UNIX accept queue returns EAGAIN without a pending connect to poll.
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    std::thread::sleep(remaining.min(Duration::from_millis(10)));
                }
                Err(error) => return Err(error),
            }
        }
    }
    Ok(OwnedFd::from(socket).into())
}

fn read_json_reply<T: serde::de::DeserializeOwned>(
    stream: UnixStream,
    read: impl FnOnce(&mut io::Take<UnixStream>, &mut Vec<u8>) -> io::Result<usize>,
) -> Result<T, ReplyReadError> {
    let mut response = Vec::new();
    read(
        &mut stream.take((MAX_CONTROL_REPLY + 1) as u64),
        &mut response,
    )
    .map_err(reply_io_failure)?;
    if response.len() > MAX_CONTROL_REPLY {
        return Err(ReplyReadError::InvalidReply);
    }
    if response.is_empty() {
        return Err(ReplyReadError::Disconnected);
    }
    if response
        .iter()
        .find(|&&byte| !matches!(byte, b' ' | b'\t' | b'\n' | b'\r'))
        .is_some_and(|&byte| byte != b'{')
    {
        return Err(ReplyReadError::InvalidReply);
    }
    serde_json::from_slice(&response).map_err(|error| {
        if error.is_eof() {
            ReplyReadError::TruncatedReply
        } else {
            ReplyReadError::InvalidReply
        }
    })
}

fn reply_io_failure(error: io::Error) -> ReplyReadError {
    match error.kind() {
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock => ReplyReadError::NoAnswer,
        io::ErrorKind::ConnectionAborted
        | io::ErrorKind::ConnectionReset
        | io::ErrorKind::BrokenPipe
        | io::ErrorKind::NotConnected => ReplyReadError::Disconnected,
        _ => ReplyReadError::TransportError,
    }
}

#[cfg(test)]
#[path = "control_tests.rs"]
mod tests;
