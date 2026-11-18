use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

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

struct Pending {
    sender: std::sync::mpsc::Sender<Result<Reply, CarrierError>>,
}

struct Shared {
    writer: Mutex<UnixStream>,
    pending: Mutex<HashMap<String, Pending>>,
    next_id: AtomicU64,
    closed: AtomicBool,
    on_event: Box<dyn Fn(&str) + Send + Sync>,
}

/// One multiplexed connection speaking the client connection kind.
#[derive(Clone)]
pub struct LineClient {
    shared: Arc<Shared>,
}

impl LineClient {
    /// Connects to the supervisor socket and sends the "client" first line.
    pub fn connect(path: &std::path::Path, on_event: impl Fn(&str) + Send + Sync + 'static) -> std::io::Result<Self> {
        let stream = UnixStream::connect(path)?;
        let reader = stream.try_clone()?;
        let mut writer = stream;
        writer.write_all(b"client\n")?;
        let shared = Arc::new(Shared {
            writer: Mutex::new(writer),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(0),
            closed: AtomicBool::new(false),
            on_event: Box::new(on_event),
        });
        std::thread::Builder::new().spawn({
            let shared = Arc::clone(&shared);
            move || read_loop(reader, shared)
        })?;
        Ok(Self { shared })
    }

    pub fn is_closed(&self) -> bool {
        self.shared.closed.load(Ordering::SeqCst)
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
        let id = id.to_string();
        let mut headers = serde_json::Map::new();
        if let Some(value) = last_event_id {
            headers.insert("Last-Event-ID".into(), serde_json::Value::String(value.into()));
        }
        let line = serde_json::json!({
            "id": id,
            "method": method,
            "path": path,
            "headers": headers,
            "body": body,
        })
        .to_string();
        // The limit includes the newline this write appends.
        if line.len() + 1 > MAX_REQUEST_LINE {
            return Err(CarrierError::Invalid);
        }
        let (sender, receiver) = std::sync::mpsc::channel();
        {
            let mut pending = self.shared.pending.lock().unwrap();
            if pending.len() >= MAX_PENDING {
                return Err(CarrierError::Busy);
            }
            pending.insert(id.clone(), Pending { sender });
        }
        if write_line(&self.shared, &line).is_err() {
            self.fail_pending(id, CarrierError::Closed);
            return Err(CarrierError::Closed);
        }
        match receiver.recv_timeout(timeout) {
            Ok(result) => result,
            Err(_) => {
                self.shared.pending.lock().unwrap().remove(&id);
                Err(CarrierError::Timeout)
            }
        }
    }

    /// Sends a client event line (ready, notification-clicked) without waiting.
    pub fn send_event(&self, line: &str) -> Result<(), CarrierError> {
        write_line(&self.shared, line).map_err(|_| CarrierError::Closed)
    }

    /// Sends a close for one subscription id.
    pub fn send_close(&self, subscription: &str) -> Result<(), CarrierError> {
        let line = serde_json::json!({ "event": "close", "subscription": subscription }).to_string();
        write_line(&self.shared, &line).map_err(|_| CarrierError::Closed)
    }

    fn fail_pending(&self, id: String, error: CarrierError) {
        if let Some(pending) = self.shared.pending.lock().unwrap().remove(&id) {
            let _ = pending.sender.send(Err(error));
        }
    }
}

fn write_line(shared: &Shared, line: &str) -> std::io::Result<()> {
    let mut writer = shared.writer.lock().unwrap();
    writer.write_all(line.as_bytes())?;
    writer.write_all(b"\n")?;
    writer.flush()
}

enum ReadLine {
    Line(String),
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
            return ReadLine::Closed;
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
    let close_reason = loop {
        let line = match read_bounded_line(&mut reader, MAX_RESPONSE_LINE) {
            ReadLine::Line(line) => line,
            ReadLine::Closed => break CarrierError::Closed,
            ReadLine::Invalid => break CarrierError::Invalid,
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
            if let Some(pending) = shared.pending.lock().unwrap().remove(&id) {
                let _ = pending.sender.send(parse_reply(&value));
                continue;
            }
        }
        if value.get("event").is_some() {
            (shared.on_event)(trimmed);
        }
    };
    let _ = reader.into_inner().shutdown(std::net::Shutdown::Both);
    shared.closed.store(true, Ordering::SeqCst);
    let pending: Vec<_> = shared.pending.lock().unwrap().drain().collect();
    for (_, item) in pending {
        let _ = item.sender.send(Err(close_reason.clone()));
    }
}
