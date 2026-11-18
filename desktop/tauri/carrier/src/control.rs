use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

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
    DrainConnection::connect(path)?.drain_if(|| Some(()))
}

pub struct DrainConnection(UnixStream);

impl DrainConnection {
    pub fn connect(path: &Path) -> Result<Self, DrainFailure> {
        if !crate::daemon::socket_is_private(path).map_err(|_| DrainFailure::NotConnected)? {
            return Err(DrainFailure::NotConnected);
        }
        let stream = UnixStream::connect(path).map_err(|_| DrainFailure::NotConnected)?;
        stream
            .set_read_timeout(Some(DRAIN_TIMEOUT))
            .map_err(|_| DrainFailure::TransportError)?;
        Ok(Self(stream))
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
