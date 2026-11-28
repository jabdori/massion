use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, TryLockError};
use std::time::{Duration, Instant};

/// The line bounds the daemon-side relay enforces (desktop/client-relay.ts).
pub const MAX_REQUEST_LINE: usize = 65536;
pub const MAX_RESPONSE_LINE: usize = 4194304;
pub const MAX_PENDING: usize = 64;
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(35);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CarrierError {
    /// The daemon is not answering; the caller shows a transport failure.
    Closed,
    Timeout,
    Busy,
    Invalid,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

type Pending = Box<dyn FnOnce(Result<Reply, CarrierError>) + Send>;

#[derive(Default)]
struct PendingRequests {
    requests: HashMap<String, Pending>,
    closed: bool,
}

struct Shared {
    writer: Mutex<Option<UnixStream>>,
    pending: Mutex<PendingRequests>,
    next_id: AtomicU64,
    on_event: Box<dyn Fn(&str) + Send + Sync>,
    eof: Mutex<EofWatch>,
}

enum EofWatch {
    Open,
    Watching(Box<dyn FnOnce(LineClient, Instant) + Send>),
    Eof(Instant),
    Stopped,
}

/// One multiplexed connection speaking the client connection kind.
#[derive(Clone)]
pub struct LineClient {
    shared: Arc<Shared>,
}

/// Keeps one root reply registered until the host finishes selecting a document.
pub struct PendingRoot {
    shared: Arc<Shared>,
    id: String,
}

impl Drop for PendingRoot {
    fn drop(&mut self) {
        self.shared.pending.lock().unwrap().requests.remove(&self.id);
    }
}

impl LineClient {
    /// Connects to the supervisor socket and sends the "client" first line.
    pub fn connect(path: &std::path::Path, on_event: impl Fn(&str) + Send + Sync + 'static) -> std::io::Result<Self> {
        let stream = UnixStream::connect(path)?;
        let reader = stream.try_clone()?;
        let mut writer = stream;
        writer.write_all(b"client\n")?;
        let shared = Arc::new(Shared {
            writer: Mutex::new(Some(writer)),
            pending: Mutex::new(PendingRequests::default()),
            next_id: AtomicU64::new(0),
            on_event: Box::new(on_event),
            eof: Mutex::new(EofWatch::Open),
        });
        std::thread::Builder::new().spawn({
            let shared = Arc::clone(&shared);
            move || read_loop(reader, shared)
        })?;
        Ok(Self { shared })
    }

    pub fn is_closed(&self) -> bool {
        matches!(*self.shared.eof.lock().unwrap(), EofWatch::Eof(_) | EofWatch::Stopped)
    }

    pub fn closed_without_eof(&self) -> bool {
        matches!(*self.shared.eof.lock().unwrap(), EofWatch::Stopped)
    }

    pub fn same_connection(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.shared, &other.shared)
    }

    /// Observe the end of reading, including EOF before the host installed its client.
    pub fn on_eof(&self, notify: impl FnOnce(Self, Instant) + Send + 'static) {
        let ended_at = {
            let mut watch = self.shared.eof.lock().unwrap();
            match &*watch {
                EofWatch::Open => {
                    *watch = EofWatch::Watching(Box::new(notify));
                    return;
                }
                EofWatch::Eof(ended_at) => *ended_at,
                EofWatch::Watching(_) | EofWatch::Stopped => return,
            }
        };
        notify(self.clone(), ended_at);
    }

    pub fn disconnect(&self) {
        if let Some(writer) = self.shared.writer.lock().unwrap().as_ref() {
            let _ = writer.shutdown(std::net::Shutdown::Both);
        }
    }

    /// Sends one request line and waits for the reply with the same id.
    pub fn request(&self, method: &str, path: &str, last_event_id: Option<&str>, body: Option<&str>) -> Result<Reply, CarrierError> {
        self.request_as_timed(&format!("c-{}", self.shared.next_id.fetch_add(1, Ordering::SeqCst)), method, path, last_event_id, body, REQUEST_TIMEOUT)
    }

    /// Same as request with an explicit timeout (tests use short ones).
    pub fn request_timed(&self, method: &str, path: &str, last_event_id: Option<&str>, body: Option<&str>, timeout: Duration) -> Result<Reply, CarrierError> {
        self.request_as_timed(&format!("c-{}", self.shared.next_id.fetch_add(1, Ordering::SeqCst)), method, path, last_event_id, body, timeout)
    }

    /// Sends one request under a caller-chosen id, so one subscription id can
    /// travel the whole path (subscribe, events, close).
    pub fn request_as_timed(&self, id: &str, method: &str, path: &str, last_event_id: Option<&str>, body: Option<&str>, timeout: Duration) -> Result<Reply, CarrierError> {
        self.request_line(id, method, path, last_event_id, body, timeout, None)
    }

    /// The first document shares one deadline across registration, writing and receiving.
    pub fn request_root_until(&self, deadline: Instant) -> Result<Reply, CarrierError> {
        let id = format!("c-{}", self.shared.next_id.fetch_add(1, Ordering::SeqCst));
        self.request_line(&id, "GET", "/", None, None, Duration::ZERO, Some(deadline))
    }

    /// Root replies share the reader's ordering even when two requests overlap.
    pub fn begin_root_request(
        &self,
        deadline: Instant,
        complete: impl FnOnce(Result<Reply, CarrierError>) + Send + 'static,
    ) -> Result<PendingRoot, CarrierError> {
        let id = format!("c-{}", self.shared.next_id.fetch_add(1, Ordering::SeqCst));
        let line = request_frame(&id, "GET", "/", None, None);
        self.register(&id, Box::new(complete))?;
        let pending = PendingRoot {
            shared: Arc::clone(&self.shared),
            id: id.clone(),
        };
        let shared = Arc::clone(&self.shared);
        std::thread::Builder::new()
            .spawn(move || {
                if let Err(error) = write_line(&shared, &line, Some(deadline)) {
                    let pending = shared.pending.lock().unwrap().requests.remove(&id);
                    if let Some(complete) = pending {
                        complete(Err(error));
                    }
                }
            })
            .map_err(|_| CarrierError::Busy)?;
        Ok(pending)
    }

    fn register(&self, id: &str, complete: Pending) -> Result<(), CarrierError> {
        let mut pending = self.shared.pending.lock().unwrap();
        if pending.closed {
            return Err(CarrierError::Closed);
        }
        if pending.requests.len() >= MAX_PENDING {
            return Err(CarrierError::Busy);
        }
        pending.requests.insert(id.to_owned(), complete);
        Ok(())
    }

    fn request_line(&self, id: &str, method: &str, path: &str, last_event_id: Option<&str>, body: Option<&str>, timeout: Duration, deadline: Option<Instant>) -> Result<Reply, CarrierError> {
        let line = request_frame(id, method, path, last_event_id, body);
        let (sender, receiver) = std::sync::mpsc::channel();
        self.register(id, Box::new(move |result| {
            let _ = sender.send(result);
        }))?;
        if let Err(error) = write_line(&self.shared, &line, deadline) {
            self.shared.pending.lock().unwrap().requests.remove(id);
            return Err(error);
        }
        let timeout = deadline.map_or(timeout, |deadline| deadline.saturating_duration_since(Instant::now()));
        match receiver.recv_timeout(timeout) {
            Ok(result) => result,
            Err(_) => {
                self.shared.pending.lock().unwrap().requests.remove(id);
                Err(CarrierError::Timeout)
            }
        }
    }

    /// Sends a client event line (ready, notification-clicked) without waiting.
    pub fn send_event(&self, line: &str) -> Result<(), CarrierError> {
        write_line(&self.shared, line, None)
    }

    /// Sends a close for one subscription id.
    pub fn send_close(&self, subscription: &str) -> Result<(), CarrierError> {
        let line = serde_json::json!({ "event": "close", "subscription": subscription }).to_string();
        write_line(&self.shared, &line, None)
    }
}

fn request_frame(
    id: &str,
    method: &str,
    path: &str,
    last_event_id: Option<&str>,
    body: Option<&str>,
) -> String {
    let mut headers = serde_json::Map::new();
    if let Some(value) = last_event_id {
        headers.insert("Last-Event-ID".into(), serde_json::Value::String(value.into()));
    }
    serde_json::json!({
        "id": id,
        "method": method,
        "path": path,
        "headers": headers,
        "body": body,
    })
    .to_string()
}

/// Every line the host writes passes here, so the relay's request-line limit
/// is enforced in one place: a line at or over the limit (the newline this
/// write appends included) is refused before any byte reaches the connection,
/// because the relay closes the whole connection for one such line.
fn write_line(shared: &Shared, line: &str, deadline: Option<Instant>) -> Result<(), CarrierError> {
    if line.len() + 1 > MAX_REQUEST_LINE {
        return Err(CarrierError::Invalid);
    }
    let mut writer = if let Some(deadline) = deadline {
        loop {
            match shared.writer.try_lock() {
                Ok(writer) => break writer,
                Err(TryLockError::Poisoned(_)) => return Err(CarrierError::Closed),
                Err(TryLockError::WouldBlock) => {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        return Err(CarrierError::Timeout);
                    }
                    std::thread::sleep(remaining.min(Duration::from_millis(1)));
                }
            }
        }
    } else {
        shared.writer.lock().unwrap()
    };
    let Some(writer) = writer.as_mut() else {
        return Err(CarrierError::Closed);
    };
    if let Some(deadline) = deadline {
        return write_until(writer, &[line.as_bytes(), b"\n"].concat(), deadline);
    }
    writer
        .write_all(line.as_bytes())
        .and_then(|()| writer.write_all(b"\n"))
        .and_then(|()| writer.flush())
        .map_err(|_| CarrierError::Closed)
}

fn write_until(writer: &mut UnixStream, line: &[u8], deadline: Instant) -> Result<(), CarrierError> {
    let mut remaining = line;
    let result = loop {
        let time = deadline.saturating_duration_since(Instant::now());
        if time.is_zero() {
            break Err(CarrierError::Timeout);
        }
        // Unix socket timeouts can round a sub-millisecond value down to zero.
        if writer.set_write_timeout(Some(time.max(Duration::from_millis(1)))).is_err() {
            break Err(CarrierError::Closed);
        }
        match writer.write(remaining) {
            Ok(0) => break Err(CarrierError::Closed),
            Ok(sent) => {
                remaining = &remaining[sent..];
                if remaining.is_empty() {
                    break Ok(());
                }
            }
            Err(error) => match error.kind() {
                std::io::ErrorKind::Interrupted => continue,
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut => {
                    break Err(CarrierError::Timeout);
                }
                _ => break Err(CarrierError::Closed),
            },
        }
    };
    // Restore the ordinary writer behavior while still holding its lock.
    let restore = writer.set_write_timeout(None).map_err(|_| CarrierError::Closed);
    // A partial frame cannot be followed by another request on this stream.
    if restore.is_err() || (result.is_err() && remaining.len() != line.len()) {
        let _ = writer.shutdown(std::net::Shutdown::Both);
    }
    result.and(restore)
}

enum ReadLine {
    Line(String),
    Eof,
    Closed,
    Invalid,
}

/// Reads one line with a hard byte bound that includes the newline: the
/// remaining capacity is checked BEFORE appending, so nothing beyond the limit
/// is ever allocated and a peer that never sends a newline cannot grow memory
/// unbounded.
fn read_bounded_line(reader: &mut BufReader<UnixStream>, limit: usize) -> ReadLine {
    let mut line: Vec<u8> = Vec::with_capacity(1024);
    loop {
        let available = match reader.fill_buf() {
            Ok(available) => available,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return ReadLine::Closed,
        };
        if available.is_empty() {
            return ReadLine::Eof;
        }
        match available.iter().position(|&byte| byte == b'\n') {
            Some(index) => {
                let end = index + 1; // including the newline
                if line.len() + end > limit {
                    return ReadLine::Invalid;
                }
                line.extend_from_slice(&available[..end]);
                reader.consume(end);
                let content = &line[..line.len() - 1];
                return match String::from_utf8(content.to_vec()) {
                    Ok(text) => ReadLine::Line(text),
                    Err(_) => ReadLine::Invalid,
                };
            }
            None => {
                // Without a newline here, the finished line needs at least one
                // more byte; refuse before appending anything.
                if line.len() + available.len() >= limit {
                    return ReadLine::Invalid;
                }
                let length = available.len();
                line.extend_from_slice(available);
                reader.consume(length);
            }
        }
    }
}

fn parse_reply(value: &serde_json::Value) -> Result<Reply, CarrierError> {
    if value.get("error").is_some() {
        return Err(CarrierError::Invalid);
    }
    let status = value
        .get("status")
        .and_then(|item| item.as_u64())
        .and_then(|code| u16::try_from(code).ok())
        .filter(|code| (100..=599).contains(code))
        .ok_or(CarrierError::Invalid)?;
    let headers = match value.get("headers") {
        None => Vec::new(),
        Some(item) => {
            let object = item.as_object().ok_or(CarrierError::Invalid)?;
            let mut parsed = Vec::with_capacity(object.len());
            for (name, val) in object {
                let text = val.as_str().ok_or(CarrierError::Invalid)?;
                parsed.push((name.clone(), text.to_string()));
            }
            parsed
        }
    };
    let body = match value.get("body") {
        None | Some(serde_json::Value::Null) => None,
        Some(item) => Some(item.as_str().ok_or(CarrierError::Invalid)?.to_string()),
    };
    Ok(Reply {
        status,
        headers,
        body,
    })
}

fn read_loop(reader: UnixStream, shared: Arc<Shared>) {
    let mut reader = BufReader::new(reader);
    let (close_reason, ended_at) = loop {
        let line = match read_bounded_line(&mut reader, MAX_RESPONSE_LINE) {
            ReadLine::Line(line) => line,
            ReadLine::Eof => break (CarrierError::Closed, Some(Instant::now())),
            ReadLine::Closed => break (CarrierError::Closed, None),
            ReadLine::Invalid => break (CarrierError::Invalid, None),
        };
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            continue;
        }
        let value: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let id = value.get("id").and_then(|item| item.as_str()).map(str::to_string);
        if let Some(id) = id {
            let pending = shared.pending.lock().unwrap().requests.remove(&id);
            if let Some(complete) = pending {
                complete(parse_reply(&value));
                continue;
            }
        }
        if value.get("event").is_some() {
            (shared.on_event)(trimmed);
        }
    };
    let watch = std::mem::replace(
        &mut *shared.eof.lock().unwrap(),
        ended_at.map_or(EofWatch::Stopped, EofWatch::Eof),
    );
    // Publish the cause before shutdown can cause a concurrent write to fail.
    // Shut the read half down in both directions: incoming data is discarded
    // from here on, and a later write from this side fails at once instead of
    // waiting for the request timeout. The write half dies with the reader:
    // closing the host's last file descriptor is what releases a peer that is
    // ALREADY blocked writing (a shutdown alone does not wake it on macOS).
    // The drain control connection and any later connection are separate
    // sockets and cannot be touched here.
    let _ = reader.into_inner().shutdown(std::net::Shutdown::Both);
    if let Some(writer) = shared.writer.lock().unwrap().take() {
        let _ = writer.shutdown(std::net::Shutdown::Both);
    }
    let pending = {
        let mut pending = shared.pending.lock().unwrap();
        pending.closed = true;
        std::mem::take(&mut pending.requests)
    };
    for complete in pending.into_values() {
        complete(Err(close_reason.clone()));
    }
    if let (Some(ended_at), EofWatch::Watching(notify)) = (ended_at, watch) {
        notify(LineClient { shared }, ended_at);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn paired_client() -> (LineClient, UnixStream) {
        let (writer, peer) = UnixStream::pair().unwrap();
        let client = LineClient { shared: Arc::new(Shared {
            writer: Mutex::new(Some(writer)),
            pending: Mutex::new(PendingRequests::default()),
            next_id: AtomicU64::new(0),
            on_event: Box::new(|_| {}),
            eof: Mutex::new(EofWatch::Open),
        }) };
        (client, peer)
    }

    #[test]
    fn root_deadline_expires_with_the_write_lock_still_held() {
        let (client, _peer) = paired_client();
        let writer = client.shared.writer.lock().unwrap();
        let (done, finished) = mpsc::channel();
        let worker = std::thread::spawn({
            let client = client.clone();
            move || done.send(client.request_root_until(Instant::now())).unwrap()
        });
        assert_eq!(
            finished.recv_timeout(Duration::from_secs(5)),
            Ok(Err(CarrierError::Timeout)),
            "the root request must time out before the writer lock is released",
        );
        drop(writer);
        worker.join().unwrap();
        assert!(client.shared.pending.lock().unwrap().requests.is_empty());
    }

    #[test]
    fn root_write_expires_when_the_peer_stops_reading() {
        let (client, _peer) = paired_client();
        let mut slot = client.shared.writer.lock().unwrap();
        let writer = slot.as_mut().unwrap();
        writer.set_nonblocking(true).unwrap();
        let mut full = false;
        for _ in 0..1024 {
            match writer.write(&[0; 4096]) {
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    full = true;
                    break;
                }
                Err(error) => panic!("filling socket failed: {error}"),
            }
        }
        assert!(full, "fixture must observe socket backpressure");
        writer.set_nonblocking(false).unwrap();
        drop(slot);

        let (done, finished) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_millis(20);
            let result = client.request_root_until(deadline);
            done.send(result).unwrap();
        });
        assert_eq!(
            finished.recv_timeout(Duration::from_secs(5)),
            Ok(Err(CarrierError::Timeout)),
            "the root write must time out while its peer is still open",
        );
        worker.join().unwrap();
    }

    #[test]
    fn registration_after_reader_drain_refuses_before_touching_the_writer() {
        let (client, peer) = paired_client();
        let reader = client.shared.writer.lock().unwrap().as_ref().unwrap().try_clone().unwrap();
        drop(peer);
        read_loop(reader, Arc::clone(&client.shared));
        let writer = client.shared.writer.lock().unwrap();
        let (done, finished) = mpsc::channel();
        let worker = std::thread::spawn({
            let client = client.clone();
            move || done.send(client.request("GET", "/other", None, None)).unwrap()
        });
        assert_eq!(
            finished.recv_timeout(Duration::from_secs(5)),
            Ok(Err(CarrierError::Closed)),
            "registration after the drain must not reach the writer",
        );
        drop(writer);
        worker.join().unwrap();
    }
}
