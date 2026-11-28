mod store;

use anyhow::{Context, Result, ensure};
use axum::{
    Router,
    body::to_bytes,
    extract::{Request, State},
    http::{HeaderMap, Method, StatusCode, header},
    response::{IntoResponse, Json, Response, Sse, sse::Event},
};
use serde_json::{Value, json};
use std::{
    convert::Infallible,
    io::IsTerminal,
    net::Ipv4Addr,
    path::{Component, Path, PathBuf},
    process::Command,
    sync::Arc,
    time::Duration,
};
use store::{Store, canonical, safe_integer};
use tokio::sync::{Notify, watch};
use url::Url;

const BODY_LIMIT: usize = 32768;
const CURSOR_MISMATCH: &str = "Event feed identity or cursor no longer matches this database; read /read-state before resuming catch-up.";

fn database_copy(input: &str) -> Result<PathBuf> {
    let scratch = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join(".runtime");
    let folder = std::path::absolute(input)?;
    let relative = folder
        .strip_prefix(&scratch)
        .context("Database must be a disposable worktree copy under .runtime")?;
    ensure!(
        !relative.as_os_str().is_empty()
            && relative
                .components()
                .all(|c| matches!(c, Component::Normal(_))),
        "Invalid disposable database path"
    );
    let mut location = scratch;
    ensure!(
        location.symlink_metadata()?.is_dir(),
        "Scratch directory must be a real directory"
    );
    for part in relative.components() {
        location.push(part);
        ensure!(
            location.symlink_metadata()?.is_dir(),
            "Database path must use real directories"
        );
    }
    let mut dirs = vec![folder.clone()];
    while let Some(directory) = dirs.pop() {
        for entry in directory.read_dir()? {
            let entry = entry?;
            let kind = entry.file_type()?;
            ensure!(
                kind.is_dir() || kind.is_file(),
                "Database copy must only contain regular files and directories"
            );
            if kind.is_dir() {
                dirs.push(entry.path());
            }
        }
    }
    Ok(folder)
}

#[derive(Clone)]
struct App {
    store: Arc<Store>,
    host: String,
    updates: Arc<Notify>,
    shutdown: watch::Receiver<bool>,
}

struct Header {
    version: u64,
    id: String,
    generation: u64,
}

fn identifier(value: &Value) -> Option<&str> {
    value.as_str().filter(|id| {
        (1..=128).contains(&id.len())
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b":_-".contains(&b))
    })
}

impl Header {
    fn parse(value: &Value) -> Option<Self> {
        Some(Self {
            version: safe_integer(&value["version"]).filter(|n| *n > 0)?,
            id: identifier(&value["requestId"])?.to_owned(),
            generation: safe_integer(&value["generation"])?,
        })
    }

    fn reply(&self, status: u16, payload: Value) -> Response {
        respond(
            status,
            json!({"version": 1, "requestId": self.id, "generation": self.generation,
            "kind": "reply", "status": status, "payload": payload}),
        )
    }

    fn event(&self, reason: &str, feed: &str, cursor: u64, batch: Option<&Value>) -> Event {
        let mut data = json!({"version": self.version, "requestId": self.id, "generation": self.generation,
            "kind": "feed", "reason": reason, "feedId": feed, "cursor": cursor});
        if let Some(batch) = batch {
            data["aggregateId"] = batch["aggregateId"].clone();
            data["revision"] = batch["revision"].clone();
        }
        Event::default()
            .id(json!([feed, cursor]).to_string())
            .data(data.to_string())
    }
}

fn respond(status: u16, body: Value) -> Response {
    (StatusCode::from_u16(status).unwrap(), Json(body)).into_response()
}

fn error(status: u16, message: &str) -> Response {
    respond(status, json!({"error": message}))
}

fn connection(ready: bool) -> Value {
    json!({"state": if ready {"ready"} else {"update-needed"}, "supported": {"min": 1, "max": 1},
        "features": {"commands": true, "queries": true, "feedPush": true}, "version": if ready {json!(1)} else {Value::Null}})
}

fn query_parameter(url: &Url, key: &str) -> Option<String> {
    url.query_pairs()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.into_owned())
}

fn query_number(url: &Url, key: &str, default: u64) -> Value {
    match query_parameter(url, key) {
        None => json!(default),
        Some(value) if value.trim().is_empty() => json!(0),
        Some(value) => value
            .trim()
            .parse::<f64>()
            .map_or(Value::Null, |number| json!(number)),
    }
}

fn js_space(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
        | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn valid_text(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|s| !s.trim_matches(js_space).is_empty() && s.encode_utf16().count() <= 16000)
}

fn mission_input(body: &Value) -> std::result::Result<(Value, &str), &'static str> {
    let id = identifier(&body["id"]).ok_or("Invalid Mission identifier")?;
    let command = identifier(&body["commandId"]).ok_or("Invalid command identity")?;
    if command.starts_with("assistant-") {
        return Err("assistant- command identities are reserved for host steps");
    }
    let criteria = &body["criteria"];
    if !criteria.is_object() {
        return Err("Acceptance criteria required");
    }
    if id.starts_with("assistant-conversation:") {
        return Err("Mission identifier prefix assistant-conversation: is reserved");
    }
    for (value, message) in [
        (&body["purpose"], "Invalid purpose"),
        (&body["scope"], "Invalid scope"),
    ] {
        if !valid_text(value) {
            return Err(message);
        }
    }
    if !safe_integer(&criteria["version"]).is_some_and(|n| n > 0) {
        return Err("Invalid criteria version");
    }
    if !valid_text(&criteria["description"]) {
        return Err("Invalid criteria");
    }
    if !valid_text(&criteria["oracle"]) {
        return Err("Invalid oracle");
    }
    if !body["constraints"]
        .as_array()
        .is_some_and(|items| items.iter().all(Value::is_string))
    {
        return Err("Invalid constraints");
    }
    Ok((
        json!({"id": id, "purpose": body["purpose"], "scope": body["scope"], "constraints": body["constraints"], "criteria": criteria}),
        command,
    ))
}

async fn logical_request(app: &App, message: &Value) -> Result<(u16, Value)> {
    let kind = message["kind"].as_str().unwrap_or_default();
    let path = message["path"].as_str().unwrap_or_default();
    if !matches!(kind, "command" | "query")
        || path.encode_utf16().count() > 8192
        || !path.starts_with('/')
        || path.starts_with("//")
        || path.contains(['\\', '#', '\r', '\n'])
    {
        return Ok((400, json!({"error": "Invalid protocol request"})));
    }
    let url = Url::parse(&format!("http://{}{path}", app.host))?;
    if url.path() == "/" || url.path().starts_with("/protocol") {
        return Ok((400, json!({"error": "Invalid protocol target"})));
    }
    let payload = message.get("payload");
    if kind == "command" && !payload.is_some_and(Value::is_object)
        || kind == "query" && payload.is_some()
    {
        return Ok((400, json!({"error": "Invalid protocol payload"})));
    }
    if payload.is_some_and(|value| canonical(value).len() > BODY_LIMIT) {
        return Ok((413, json!({"error": "Request too large"})));
    }
    let requested_feed = if let Some(value) = message.get("feedId") {
        let Some(feed) = identifier(value) else {
            return Ok((400, json!({"error": "Invalid Feed identity"})));
        };
        Some(feed)
    } else {
        None
    };
    match (kind, url.path()) {
        ("command", "/missions") => {
            let boundary = app.store.read_state(None).await?;
            let feed = boundary["feedId"].as_str().unwrap();
            if requested_feed.is_some_and(|requested| requested != feed) {
                return Ok((
                    409,
                    json!({"error": "Database changed before admission", "reason": "feed", "outcome": "rejected", "feedId": feed}),
                ));
            }
            let (input, command) = match mission_input(payload.unwrap()) {
                Ok(input) => input,
                Err(message) => return Ok((400, json!({"error": message, "feedId": feed}))),
            };
            let mut result = match app.store.create(input, command, feed).await {
                Ok(result) => result,
                Err(_) => {
                    return Ok((
                        503,
                        json!({"error": "Commit outcome is unknown. Read durable events before deciding any next action.", "outcome": "unknown", "feedId": feed}),
                    ));
                }
            };
            let status = match result["status"].as_str() {
                Some("committed") => {
                    app.updates.notify_waiters();
                    201
                }
                Some("replayed") => 200,
                Some("conflict") => 409,
                Some("feed-mismatch") => {
                    return Ok((
                        503,
                        json!({"error": "Database changed before commit admission", "reason": "feed", "outcome": "unknown", "feedId": feed}),
                    ));
                }
                _ => anyhow::bail!("Invalid commit receipt"),
            };
            result["feedId"] = json!(feed);
            Ok((status, result))
        }
        ("query", "/read-state") => {
            let mission = query_parameter(&url, "mission");
            if let Some(id) = &mission {
                if identifier(&json!(id)).is_none() {
                    return Ok((400, json!({"error": "Invalid Mission identifier"})));
                }
                if id.starts_with("assistant-conversation:") {
                    return Ok((
                        400,
                        json!({"error": "Conversation segments are not Missions"}),
                    ));
                }
            }
            Ok((200, app.store.read_state(mission.as_deref()).await?))
        }
        ("query", "/events") => {
            let after = safe_integer(&query_number(&url, "after", 0));
            let limit =
                safe_integer(&query_number(&url, "limit", 100)).filter(|n| (1..=1000).contains(n));
            let (Some(after), Some(limit)) = (after, limit) else {
                return Ok((400, json!({"error": "Invalid event cursor or limit"})));
            };
            Ok(
                match app.store.catchup(after, requested_feed, limit).await? {
                    Some(page) => (200, page),
                    None => (409, json!({"error": CURSOR_MISMATCH})),
                },
            )
        }
        _ => Ok((404, json!({"error": "Unknown route"}))),
    }
}

async fn events(mut app: App, method: Method, headers: HeaderMap, url: Url) -> Result<Response> {
    let fields = json!({"version": query_number(&url, "version", 0), "requestId": query_parameter(&url, "requestId"),
        "generation": query_number(&url, "generation", 0)});
    let Some(message) = Header::parse(&fields) else {
        return Ok(error(400, "Invalid protocol header"));
    };
    if method != Method::GET || message.version != 1 {
        return Ok(message.reply(
            426,
            json!({"error": "Unsupported feed protocol", "outcome": "rejected"}),
        ));
    }
    let feed = query_parameter(&url, "feedId");
    let position = match headers.get("last-event-id") {
        Some(id) => id
            .to_str()
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(s).ok()),
        None => Some(json!([feed, query_number(&url, "after", 0)])),
    };
    let Some(position) =
        position.filter(|value| value.as_array().is_some_and(|items| items.len() == 2))
    else {
        return Ok(message.reply(400, json!({"error": "Invalid resume cursor"})));
    };
    let Some(mut cursor) = safe_integer(&position[1]) else {
        return Ok(message.reply(400, json!({"error": "Invalid resume cursor"})));
    };
    if (headers.contains_key("last-event-id") || !position[0].is_null())
        && identifier(&position[0]).is_none()
    {
        return Ok(message.reply(400, json!({"error": "Invalid Feed identity"})));
    }
    let head = app.store.read_state(None).await?;
    let mut feed = position[0]
        .as_str()
        .unwrap_or_else(|| head["feedId"].as_str().unwrap())
        .to_owned();
    let stream = async_stream::stream! {
        yield Ok::<_, Infallible>(message.event("connected", &feed, cursor, None));
        let mut timer = tokio::time::interval(Duration::from_secs(1));
        let mut more = false;
        while !*app.shutdown.borrow() {
            if !more {
                tokio::select! {
                    _ = timer.tick() => {},
                    _ = app.updates.notified() => {},
                    _ = app.shutdown.changed() => break,
                }
            }
            more = false;
            let Ok(head) = app.store.read_state(None).await else { break; };
            let current = head["feedId"].as_str().unwrap();
            let high = safe_integer(&head["cursor"]).unwrap();
            if current != feed || cursor > high {
                feed = current.to_owned();
                cursor = high;
                yield Ok(message.event("reset", &feed, cursor, None));
            } else if cursor < high {
                let Ok(Some(page)) = app.store.catchup(cursor, Some(&feed), 100).await else { break; };
                let mut gap = true;
                for batch in page["events"].as_array().unwrap() {
                    let next = safe_integer(&batch["cursor"]).unwrap();
                    gap = next != cursor + 1;
                    if gap { break; }
                    cursor = next;
                    yield Ok(message.event("revision", &feed, cursor, Some(batch)));
                }
                if gap {
                    cursor = high;
                    yield Ok(message.event("reset", &feed, cursor, None));
                }
                more = cursor < high;
            }
        }
    };
    let mut response = Sse::new(stream).into_response();
    response
        .headers_mut()
        .insert("x-accel-buffering", "no".parse().unwrap());
    Ok(response)
}

async fn dispatch(State(app): State<App>, request: Request) -> Response {
    let result = handle(app, request).await;
    let mut response = result.unwrap_or_else(|cause| {
        eprintln!("Spike request failed: {cause}");
        error(500, "Operation failed; inspect local host logs. Unresolved effects are not replayed automatically.")
    });
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert("x-content-type-options", "nosniff".parse().unwrap());
    response
}

async fn handle(app: App, request: Request) -> Result<Response> {
    if request
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        != Some(&app.host)
    {
        return Ok(error(403, "Loopback host required"));
    }
    let origin = format!("http://{}", app.host);
    if request
        .headers()
        .get(header::ORIGIN)
        .is_some_and(|value| value != origin.as_str())
    {
        return Ok(error(403, "Cross-origin request denied"));
    }
    let url = Url::parse(&format!("{origin}{}", request.uri()))?;
    if url.path() == "/protocol/events" {
        return events(
            app,
            request.method().clone(),
            request.headers().clone(),
            url,
        )
        .await;
    }
    let connect = url.path() == "/protocol/connect";
    if !connect && url.path() != "/protocol/request" {
        return Ok(error(404, "Unknown route"));
    }
    if request.method() != Method::POST {
        return Ok(error(405, "Protocol messages require POST"));
    }
    if request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        != Some("application/json")
    {
        return Ok(error(415, "JSON required"));
    }
    let Ok(bytes) = to_bytes(request.into_body(), BODY_LIMIT + 16384).await else {
        return Ok(error(413, "Request too large"));
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return Ok(error(400, "Invalid JSON"));
    };
    if !value.is_object() {
        return Ok(error(400, "JSON object required"));
    }
    let Some(message) = Header::parse(&value) else {
        return Ok(error(400, "Invalid protocol header"));
    };
    if connect {
        let min = safe_integer(&value["supported"]["min"]);
        let max = safe_integer(&value["supported"]["max"]);
        let (Some(min), Some(max)) = (min, max) else {
            return Ok(message.reply(400, json!({"error": "Invalid protocol range"})));
        };
        if min == 0 || max < min {
            return Ok(message.reply(400, json!({"error": "Invalid protocol range"})));
        }
        return Ok(message.reply(if min == 1 { 200 } else { 426 }, connection(min == 1)));
    }
    if message.version != 1 {
        let mut payload = connection(false);
        payload["error"] = json!("Unsupported protocol version");
        payload["outcome"] = json!("rejected");
        return Ok(message.reply(426, payload));
    }
    match logical_request(&app, &value).await {
        Ok((status, payload)) => Ok(message.reply(status, payload)),
        Err(cause) => {
            eprintln!("Spike logical request failed: {cause}");
            Ok(message.reply(500, json!({"error": "Operation failed; inspect local host logs. Unresolved effects are not replayed automatically."})))
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let [mode, folder, rest @ ..] = args.as_slice() else {
        anyhow::bail!(
            "Usage: massion-core-spike serve <database-directory> <port> [--pause-before-commit] | export <database-directory>"
        );
    };
    let folder = database_copy(folder)?;
    if mode == "p5" {
        let [command, arguments @ ..] = rest else {
            anyhow::bail!("Missing Claude Code invocation");
        };
        let home = PathBuf::from(std::env::var_os("HOME").context("Missing account home")?);
        let installed = home.join(".local/bin/claude").canonicalize()?;
        ensure!(
            Path::new(command) == installed,
            "Use the installed Claude Code executable"
        );
        ensure!(
            !std::io::stdout().is_terminal() && !std::io::stderr().is_terminal(),
            "P5 requires the output-capturing harness"
        );
        let store = Store::open(&folder, false).await?;
        store.read_state(None).await?;
        let mut child = Command::new(installed).args(arguments).spawn()?;
        eprintln!("massion-p5-child-started");
        let status = child.wait()?;
        store.shutdown().await?;
        if !status.success() {
            std::process::exit(status.code().unwrap_or(1));
        }
        return Ok(());
    }
    if mode == "export" && rest.is_empty() {
        let store = Store::open(&folder, false).await?;
        let journal = store.export_journal().await?;
        let rows = store.inspect_rows().await?;
        store.shutdown().await?;
        println!("{}", json!({"journal": journal, "rows": rows}));
        return Ok(());
    }
    ensure!(
        mode == "serve"
            && (rest.len() == 1 || rest.len() == 2 && rest[1] == "--pause-before-commit"),
        "Invalid serve arguments"
    );
    let port: u16 = rest[0].parse().context("Invalid port")?;
    let store = Arc::new(Store::open(&folder, rest.len() == 2).await?);
    store.initialize().await?;
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await?;
    let (shutdown, receiver) = watch::channel(false);
    let app = App {
        store: Arc::clone(&store),
        host: listener.local_addr()?.to_string(),
        updates: Arc::new(Notify::new()),
        shutdown: receiver,
    };
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    println!("Massion spike: http://{}", app.host);
    axum::serve(listener, Router::new().fallback(dispatch).with_state(app))
        .with_graceful_shutdown(async move {
            tokio::select! { _ = term.recv() => {}, _ = tokio::signal::ctrl_c() => {} }
            shutdown.send_replace(true);
        })
        .await?;
    store.shutdown().await
}
