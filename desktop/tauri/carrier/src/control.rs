use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

// The drain inactivity bound of the Node control client in desktop/daemon.ts.
pub const DRAIN_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_CONTROL_REPLY: usize = 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DrainFailure {
    NotConnected,
    NoAnswer,
    Disconnected,
    TransportError,
    Unsettled,
    UnexpectedStatus,
    TruncatedReply,
    InvalidReply,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct DrainReply {
    status: String,
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
            stream.write_all(b"drain\n").map_err(reply_io_failure)?;
            stream.shutdown(Shutdown::Write).map_err(reply_io_failure)?;
        }
        stream
            .set_nonblocking(false)
            .map_err(|_| DrainFailure::TransportError)?;
        read_reply(stream, read)
    }
}

fn read_reply(
    stream: UnixStream,
    read: impl FnOnce(&mut io::Take<UnixStream>, &mut Vec<u8>) -> io::Result<usize>,
) -> Result<(), DrainFailure> {
    let mut response = Vec::new();
    read(
        &mut stream.take((MAX_CONTROL_REPLY + 1) as u64),
        &mut response,
    )
    .map_err(reply_io_failure)?;
    if response.len() > MAX_CONTROL_REPLY {
        return Err(DrainFailure::InvalidReply);
    }
    if response.is_empty() {
        return Err(DrainFailure::Disconnected);
    }
    if response
        .iter()
        .find(|&&byte| !matches!(byte, b' ' | b'\t' | b'\n' | b'\r'))
        .is_some_and(|&byte| byte != b'{')
    {
        return Err(DrainFailure::InvalidReply);
    }
    let reply: DrainReply = serde_json::from_slice(&response).map_err(|error| {
        if error.is_eof() {
            DrainFailure::TruncatedReply
        } else {
            DrainFailure::InvalidReply
        }
    })?;
    match reply.status.as_str() {
        "drained" => Ok(()),
        "unsettled" => Err(DrainFailure::Unsettled),
        _ => Err(DrainFailure::UnexpectedStatus),
    }
}

fn reply_io_failure(error: io::Error) -> DrainFailure {
    match error.kind() {
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock => DrainFailure::NoAnswer,
        io::ErrorKind::ConnectionAborted
        | io::ErrorKind::ConnectionReset
        | io::ErrorKind::BrokenPipe
        | io::ErrorKind::NotConnected => DrainFailure::Disconnected,
        _ => DrainFailure::TransportError,
    }
}

#[cfg(test)]
#[path = "control_tests.rs"]
mod tests;
