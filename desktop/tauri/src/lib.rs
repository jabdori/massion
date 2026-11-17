//! The Tauri 2 host: one window, two custom URI schemes, the four deny
//! callbacks, single instance, notifications, and byte carriage between the
//! webview and the daemon's client relay socket. Every relay rule lives on
//! the daemon side (desktop/client-relay.ts); this process carries lines only
//! and holds no secret, core address or HTTP client.
//!
//! Tauri mechanisms (official documentation):
//! - Custom URI scheme protocols, including the per-platform Origin warning:
//!   https://docs.rs/tauri/latest/tauri/struct.Builder.html
//! - Webview security callbacks: https://docs.rs/tauri/latest/tauri/webview/struct.WebviewBuilder.html
//! - Capabilities: https://v2.tauri.app/security/capabilities/
//! - Channels: https://v2.tauri.app/develop/calling-rust/#channels
//! - Single instance: https://v2.tauri.app/plugin/single-instance/
//! - Notifications (Rust click actions): https://v2.tauri.app/plugin/notification/
//!   and https://docs.rs/tauri-plugin-notification/latest/tauri_plugin_notification/struct.Notification.html

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use massion_carrier::{daemon::SupervisorDirectories, LineClient};
use serde_json::Value;
use tauri::http;
use tauri::{AppHandle, Emitter, Manager};

/// The same size rules as desktop/security.ts windowOptions.
pub const WINDOW_WIDTH: f64 = 1440.0;
pub const WINDOW_HEIGHT: f64 = 960.0;
pub const WINDOW_MIN_WIDTH: f64 = 650.0;
pub const WINDOW_MIN_HEIGHT: f64 = 600.0;
pub const WINDOW_LABEL: &str = "main";
pub const APP_URL: &str = "massion://app/";
/// Both documented host forms of the app origin (docs.rs Builder Origin warning).
pub const APP_ORIGINS: [&str; 2] = ["massion://app", "massion://localhost"];
/// The two custom URI scheme protocols the daemon serves.
pub const SCHEMES: [&str; 2] = ["massion", "massion-app"];
const FOCUS_EVENT: &str = "desktop:focus";
const CLIENT_WAIT: Duration = Duration::from_secs(30);
const DAEMON_SOCKET_NAME: &str = "daemon.sock";

struct Subscription {
    channel: tauri::ipc::Channel<serde_json::Value>,
}

#[derive(Default)]
pub struct HostState {
    client: Mutex<Option<LineClient>>,
    subscriptions: Mutex<HashMap<String, Subscription>>,
    notification_keys: Mutex<HashMap<i32, String>>,
    next_notification_id: AtomicI32,
}

/// Navigation is limited to the app document itself: both host forms of the
/// massion scheme (the documented custom-scheme origin is
/// <scheme>://localhost/<path> on macOS/iOS/Linux, docs.rs Builder warning).
/// A massion-app URL is never allowed as a top-level page; published documents
/// load only inside the sandboxed frame (Electron's will-navigate allowed only
/// isAppURL for the main frame, desktop/main.ts:34-38).
pub fn is_app_navigation(url: &tauri::Url) -> bool {
    let text = url.as_str();
    for base in APP_ORIGINS {
        let with_slash = format!("{}/", base);
        let with_hash = format!("{}/#", base);
        if text == base || text == with_slash || text == with_hash || text.starts_with(&with_hash) {
            return true;
        }
    }
    false
}

/// A published-document path: /<64 hex> or /document/<64 hex> (how
/// AppDocuments stores and serves them).
pub fn is_document_path(path: &str) -> bool {
    let tail = match path.strip_prefix("/document/") {
        Some(tail) => tail,
        None => match path.strip_prefix('/') {
            Some(tail) => tail,
            None => return false,
        },
    };
    tail.len() == 64 && tail.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// The shared command guard, applied by one wrapping invoke handler that none
/// of the six commands can skip: the webview's CURRENT top-level URL (an
/// engine-owned value the caller cannot choose on either IPC path) must be the
/// app document itself. The command layer receives no calling-frame URL or
/// identifier on either IPC path, so this is the strongest frame-agnostic
/// check available; it cannot be split from the work by a top-level navigation
/// because is_app_navigation only ever allows the app document.
pub fn sender_allowed(top_level_url: &str) -> bool {
    APP_ORIGINS.iter().any(|base| {
        top_level_url == *base
            || top_level_url == format!("{}/", base)
            || top_level_url.starts_with(&format!("{}/#", base))
    })
}

fn guarded_invoke(invoke: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let top_level = invoke.message.webview_ref().url().map(|url| url.to_string()).unwrap_or_default();
    if !sender_allowed(&top_level) {
        invoke.resolver.reject("Refused desktop sender");
        return true;
    }
    #[allow(unused_assignments)]
    let commands = {
        let commands: Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool> = Box::new(tauri::generate_handler![
        desktop_settings,
        desktop_save_notifications,
        desktop_restart,
        desktop_ready,
        desktop_events_subscribe,
        desktop_events_close
        ]);
        commands
    };
    commands(invoke)
}

fn wait_client(app: &AppHandle) -> Option<LineClient> {
    let deadline = std::time::Instant::now() + CLIENT_WAIT;
    while std::time::Instant::now() < deadline {
        if let Some(client) = app.state::<HostState>().client.lock().unwrap().clone() {
            if !client.is_closed() {
                return Some(client);
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    None
}

fn route_event(app: &AppHandle, line: &str) {
    let value: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(_) => return,
    };
    match value.get("event").and_then(Value::as_str).unwrap_or_default() {
        "notification" => show_notification(app, &value),
        "focus" => {
            let target = value.get("target").cloned().unwrap_or(Value::Null);
            let _ = app.emit(FOCUS_EVENT, target);
        }
        "message" | "error" => {
            let subscription = value.get("subscription").and_then(Value::as_str).unwrap_or_default().to_string();
            let state = app.state::<HostState>();
            let mut subscriptions = state.subscriptions.lock().unwrap();
            if let Some(entry) = subscriptions.get_mut(&subscription) {
                let _ = entry.channel.send(value);
            }
        }
        _ => {}
    }
}

fn show_notification(app: &AppHandle, value: &Value) {
    use tauri_plugin_notification::NotificationExt;
    let Some(key) = value.get("key").and_then(Value::as_str).filter(|key| !key.is_empty()) else { return };
    let Some(title) = value.get("title").and_then(Value::as_str).filter(|title| !title.is_empty()) else { return };
    let state = app.state::<HostState>();
    let id = state.next_notification_id.fetch_add(1, Ordering::SeqCst);
    state.notification_keys.lock().unwrap().insert(id, key.to_string());
    let _ = app.notification().builder().title("Massion").body(title).id(id).show();
}

fn supervisor_script(app: &AppHandle) -> PathBuf {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../daemon-runner.mjs")
    }
    #[cfg(not(debug_assertions))]
    {
        app.path()
            .resource_dir()
            .map(|dir| dir.join("desktop").join("daemon-runner.mjs"))
            .unwrap_or_default()
    }
}

/// The supervisor's argument line: runner and socket always; in a packaged
/// build the core entry and daemon-side relay resources, the loopback origin
/// and the runtime directory beside the executable. Dev builds keep the two
/// arguments of the merged host.
fn supervisor_args(runner: &str, entry: &str, origin: &str, runtime_directory: &str) -> Vec<String> {
    let mut args = vec![runner.to_string(), DAEMON_SOCKET_NAME.to_string()];
    if !entry.is_empty() {
        args.push(entry.to_string());
        args.push(origin.to_string());
        args.push(runtime_directory.to_string());
    }
    args
}

#[derive(Debug, PartialEq, Eq)]
enum StartRefusal {
    DataDirectoryEnterFailed,
    Other(String),
}

impl From<String> for StartRefusal {
    fn from(message: String) -> Self {
        Self::Other(message)
    }
}

impl std::fmt::Display for StartRefusal {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DataDirectoryEnterFailed => formatter.write_str(
                "The desktop data directory could not be entered (data-directory-enter-failed)",
            ),
            Self::Other(message) => formatter.write_str(message),
        }
    }
}

fn enter_data_directory(data_dir: &Path) -> Result<(), StartRefusal> {
    std::env::set_current_dir(data_dir).map_err(|_| StartRefusal::DataDirectoryEnterFailed)
}

/// Tries the socket; if nothing answers it starts the supervisor detached,
/// then connects after the same privacy check desktop/daemon.ts applies.
fn connect_or_start(app: &AppHandle) -> Result<LineClient, StartRefusal> {
    use std::os::unix::fs::PermissionsExt;
    let caller = std::env::current_dir().map_err(|_| "The original working directory is unavailable".to_string())?;
    let data_dir = caller.join(app.path().app_data_dir().map_err(|_| "The desktop data directory is unavailable".to_string())?);
    std::fs::create_dir_all(&data_dir).map_err(|_| "The desktop data directory is unavailable".to_string())?;
    std::fs::set_permissions(&data_dir, std::fs::Permissions::from_mode(0o700)).map_err(|_| "The desktop data directory is unavailable".to_string())?;
    enter_data_directory(&data_dir)?;
    let socket = Path::new(DAEMON_SOCKET_NAME);
    if std::os::unix::net::UnixStream::connect(socket).is_err() {
        // Mirrors desktop/daemon.ts planRuntimeStart's unpackaged rule: without a managed
        // runtime directory the developer must name the database explicitly.
        if cfg!(debug_assertions) && std::env::var("MASSION_SURREAL_RPC").is_err() {
            return Err("Set MASSION_SURREAL_RPC before starting the desktop daemon".to_string().into());
        }
        let runner = supervisor_script(app);
        if !runner.is_file() {
            return Err("The supervisor script is missing".to_string().into());
        }
        let node = massion_carrier::daemon::node_binary()?;
        #[cfg(not(debug_assertions))]
        let (entry, origin, runtime_directory) = {
            let resources = app.path().resource_dir().map_err(|_| "The app resources are unavailable".to_string())?;
            let runtime = std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(|dir| dir.to_path_buf()))
                .ok_or_else(|| "The app bundle layout is unavailable".to_string())?;
            (
                resources.join("src").join("server.ts").to_string_lossy().to_string(),
                "http://127.0.0.1:8765".to_string(),
                runtime.to_string_lossy().to_string(),
            )
        };
        #[cfg(debug_assertions)]
        let (entry, origin, runtime_directory): (String, String, String) = (String::new(), String::new(), String::new());
        let args = supervisor_args(
            &runner.to_string_lossy(),
            &entry,
            &origin,
            &runtime_directory,
        );
        // Stale-socket removal and the start happen under ONE exclusive lock beside the
        // socket, and the winner re-checks whether the socket already answers, so two
        // starters cannot delete each other's live socket.
        massion_carrier::daemon::ensure_supervisor(
            socket,
            &node,
            &args,
            &data_dir.join("daemon.log"),
            Duration::from_secs(20),
            Some(SupervisorDirectories { caller: &caller, data: &data_dir }),
        )?;
    }
    if !massion_carrier::daemon::socket_is_private(socket).unwrap_or(false) {
        return Err("A private daemon socket is required".to_string().into());
    }
    let handle = app.clone();
    let client = LineClient::connect(socket, move |line| route_event(&handle, line))
        .map_err(|_| "The daemon socket is unavailable".to_string())?;
    Ok(client)
}

fn bare_response(status: u16) -> http::Response<Vec<u8>> {
    http::Response::builder().status(status).body(Vec::new()).unwrap()
}

/// Turns one scheme request into one line on the socket and the reply into the
/// scheme response, copying status, headers and body without interpretation.
/// Origin attribution happens by host form: the massion handler serves only the
/// app origin's hosts, the massion-app handler serves published documents only
/// and can never reach the relay's API paths.
fn scheme_response(app: &AppHandle, scheme: &str, request: http::Request<Vec<u8>>) -> http::Response<Vec<u8>> {
    let Some(client) = wait_client(app) else {
        return bare_response(503);
    };
    let method = request.method().as_str().to_string();
    let uri = request.uri().clone();
    let host = uri.host().unwrap_or_default().to_string();
    if scheme == "massion-app" {
        if !matches!(host.as_str(), "document" | "localhost") || !is_document_path(uri.path()) {
            return bare_response(404);
        }
    } else if !matches!(host.as_str(), "app" | "localhost") {
        return bare_response(404);
    }
    let path = match uri.query() {
        Some(query) => format!("{}?{}", uri.path(), query),
        None => uri.path().to_string(),
    };
    let body = match String::from_utf8(request.into_body()) {
        Ok(body) if body.is_empty() => None,
        Ok(body) => Some(body),
        Err(_) => return bare_response(400),
    };
    match client.request(&method, &path, None, body.as_deref()) {
        Ok(reply) => {
            let mut builder = http::Response::builder().status(reply.status);
            for (name, value) in reply.headers {
                builder = builder.header(name.as_str(), value.as_str());
            }
            builder.body(reply.body.unwrap_or_default().into_bytes()).unwrap_or_else(|_| bare_response(503))
        }
        Err(_) => bare_response(503),
    }
}

async fn relay_request(app: &AppHandle, method: &str, path: &str, body: Option<&str>) -> Result<String, String> {
    let app = app.clone();
    let method = method.to_string();
    let path = path.to_string();
    let body = body.map(str::to_string);
    tauri::async_runtime::spawn_blocking(move || {
        let Some(client) = wait_client(&app) else {
            return Err("The desktop relay is unavailable".to_string());
        };
        match client.request(&method, &path, None, body.as_deref()) {
            Ok(reply) => Ok(reply.body.unwrap_or_default()),
            Err(_) => Err("The desktop relay is unavailable".to_string()),
        }
    })
    .await
    .map_err(|_| "The desktop relay is unavailable".to_string())?
}

#[tauri::command]
async fn desktop_settings(app: AppHandle) -> Result<String, String> {
    relay_request(&app, "GET", "/desktop/settings", None).await
}

#[tauri::command]
async fn desktop_save_notifications(app: AppHandle, value: bool) -> Result<String, String> {
    relay_request(&app, "POST", "/desktop/notifications", Some(if value { "true" } else { "false" })).await
}

#[tauri::command]
async fn desktop_restart(app: AppHandle) -> Result<String, String> {
    relay_request(&app, "POST", "/desktop/restart", None).await
}

#[tauri::command]
async fn desktop_ready(app: AppHandle) -> Result<(), String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(client) = wait_client(&app) {
            let _ = client.send_event(&serde_json::json!({"event":"ready"}).to_string());
        }
        Ok(())
    })
    .await
    .map_err(|_| "The desktop relay is unavailable".to_string())?
}

#[tauri::command]
async fn desktop_events_subscribe(
    app: AppHandle,
    subscription: String,
    path: String,
    last_event_id: Option<String>,
    channel: tauri::ipc::Channel<serde_json::Value>,
) -> Result<String, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // The client generates the id and registers its source BEFORE this
        // invoke resolves, so an event can never precede registration on the
        // JavaScript side. A duplicate id would hijack another channel.
        let valid = subscription.len() <= 32
            && subscription.starts_with("sub-")
            && subscription[4..].bytes().all(|byte| byte.is_ascii_digit());
        let state = app.state::<HostState>();
        let mut subscriptions = state.subscriptions.lock().unwrap();
        if !valid || subscriptions.contains_key(&subscription) {
            return Err("Refused desktop sender".to_string());
        }
        subscriptions.insert(subscription.clone(), Subscription { channel });
        drop(subscriptions);
        let Some(client) = wait_client(&app) else {
            app.state::<HostState>().subscriptions.lock().unwrap().remove(&subscription);
            return Err("The desktop relay is unavailable".to_string());
        };
        // The same id travels the whole path: channel registry, socket request, events, close.
        match client.request_as_timed(&subscription, "GET", &path, last_event_id.as_deref(), None, massion_carrier::socket::REQUEST_TIMEOUT) {
            Ok(reply) if (200..300).contains(&reply.status) => Ok(subscription),
            _ => {
                app.state::<HostState>().subscriptions.lock().unwrap().remove(&subscription);
                Err("The feed refused the subscription".to_string())
            }
        }
    })
    .await
    .map_err(|_| "The desktop relay is unavailable".to_string())?
}

#[tauri::command]
async fn desktop_events_close(app: AppHandle, subscription: String) -> Result<(), String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<HostState>().subscriptions.lock().unwrap().remove(&subscription);
        if let Some(client) = wait_client(&app) {
            let _ = client.send_close(&subscription);
        }
        Ok(())
    })
    .await
    .map_err(|_| "The desktop relay is unavailable".to_string())?
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .manage(HostState::default())
        .invoke_handler(guarded_invoke)
        .register_asynchronous_uri_scheme_protocol(SCHEMES[0], |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                let response = scheme_response(&app, SCHEMES[0], request);
                let _ = responder.respond(response);
            });
        })
        .register_asynchronous_uri_scheme_protocol(SCHEMES[1], |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                let response = scheme_response(&app, SCHEMES[1], request);
                let _ = responder.respond(response);
            });
        })
        .setup(|app| {
            let handle = app.handle().clone();
            register_notification_clicks(&handle);
            match connect_or_start(&handle) {
                Ok(client) => {
                    *app.state::<HostState>().client.lock().unwrap() = Some(client);
                }
                Err(error) => eprintln!("{}", error),
            }
            let window = tauri::WebviewWindowBuilder::new(
                app,
                WINDOW_LABEL,
                tauri::WebviewUrl::External(APP_URL.parse().expect("the app URL parses")),
            )
            .title("Massion")
            .inner_size(WINDOW_WIDTH, WINDOW_HEIGHT)
            .min_inner_size(WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT)
            .visible(false)
            .on_navigation(is_app_navigation)
            .on_new_window(|_url, _features| tauri::webview::NewWindowResponse::Deny)
            .on_permission_request(|_webview, _kind| tauri::webview::PermissionResponse::Deny)
            .on_download(|_webview, _event| false)
            .build()?;
            let _ = window.show();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Tauri application");
}

fn register_notification_clicks(handle: &AppHandle) {
    use tauri_plugin_notification::{ActionPerformed, NotificationExt};
    let handle = handle.clone();
    let notifier = handle.clone();
    let _ = notifier.notification().on_action(move |action: &ActionPerformed| {
        let state = handle.state::<HostState>();
        let notification_id = action.notification().map(|notification| notification.id());
        let key = notification_id.and_then(|id| state.notification_keys.lock().unwrap().get(&id).cloned());
        let Some(key) = key else { return };
        if let Some(client) = handle.state::<HostState>().client.lock().unwrap().clone() {
            let _ = client.send_event(&serde_json::json!({"event":"notification-clicked","key":key}).to_string());
        }
        if let Some(window) = handle.get_webview_window(WINDOW_LABEL) {
            let _ = window.set_focus();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The configuration regression test: the capability lists exactly what
    /// the client needs, the window keeps today's size rules and navigation
    /// allows only the app origin and published app documents.
    #[test]
    fn capability_list_and_window_rules_are_pinned() {
        let capability: Value = serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
        assert_eq!(capability["identifier"], "main");
        assert_eq!(capability["windows"], serde_json::json!(["main"]));
        let mut permissions: Vec<&str> = capability["permissions"].as_array().unwrap().iter().map(|value| value.as_str().unwrap()).collect();
        permissions.sort_unstable();
        assert_eq!(
            permissions,
            vec![
                "allow-desktop-events-close",
                "allow-desktop-events-subscribe",
                "allow-desktop-ready",
                "allow-desktop-restart",
                "allow-desktop-save-notifications",
                "allow-desktop-settings",
                "core:event:allow-listen",
                "core:event:allow-unlisten"
            ]
        );
        assert!(capability.get("remote").is_none());
        assert!(!capability.to_string().contains("shell:"));
        assert!(!capability.to_string().to_string().contains("fs:"));
        let configuration: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(configuration["app"]["security"]["csp"], Value::Null);
        assert_eq!(configuration["app"]["security"]["capabilities"], serde_json::json!(["main"]));
        assert_eq!(configuration["app"]["withGlobalTauri"], true);
        assert_eq!(configuration["mainBinaryName"], "Massion");
        assert_eq!(configuration["bundle"]["active"], true);
        assert_eq!(configuration["bundle"]["targets"], serde_json::json!(["app"]));
        assert_eq!(configuration["bundle"]["icon"], serde_json::json!([]));
        // The sidecars and the staged resources live in the CI overlay
        // (packaged.conf.json) because tauri-build validates externalBin and
        // resources on every cargo build: a plain build or test must not need
        // staged binaries or a staged package tree.
        assert!(configuration["bundle"].get("externalBin").is_none());
        assert!(configuration["bundle"].get("resources").is_none());
        let packaged: Value = serde_json::from_str(include_str!("../packaged.conf.json")).unwrap();
        assert_eq!(packaged["bundle"]["externalBin"], serde_json::json!(["binaries/node", "binaries/surreal"]));
        assert_eq!(packaged["bundle"]["resources"], serde_json::json!({ "package/": "" }));
        assert_eq!(SCHEMES, ["massion", "massion-app"]);
        assert_eq!((WINDOW_WIDTH, WINDOW_HEIGHT, WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT), (1440.0, 960.0, 650.0, 600.0));
        let document = "massion-app://document/".to_string() + &"a".repeat(64);
        let localhost = "massion-app://localhost/document/".to_string() + &"b".repeat(64);
        let short = "massion-app://document/".to_string() + &"g".repeat(63);
        assert!(is_app_navigation(&"massion://app/".parse().unwrap()));
        assert!(is_app_navigation(&"massion://localhost/#mission=one".parse().unwrap()));
        for url in [
            "https://example.org/",
            "http://127.0.0.1:8765/",
            "file:///etc/passwd",
            "data:text/html,hello",
            "about:blank",
            "massion://app/other",
            "massion://app/?q=1",
            "massion://evil/",
            document.as_str(),
            localhost.as_str(),
            "massion-app://document/short",
            short.as_str(),
        ] {
            assert!(!is_app_navigation(&url.parse().unwrap()), "refused: {}", url);
        }
    }

    #[test]
    fn supervisor_args_use_the_relative_socket_name_in_both_modes() {
        let dev = supervisor_args("runner.mjs", "", "", "");
        assert_eq!(dev, vec!["runner.mjs".to_string(), "daemon.sock".to_string()]);
        let packaged = supervisor_args("runner.mjs", "/r/src/server.ts", "http://127.0.0.1:8765", "/r");
        assert_eq!(packaged.len(), 5);
        assert_eq!(packaged[1], "daemon.sock");
        assert_eq!(Path::new(DAEMON_SOCKET_NAME), Path::new("daemon.sock"));
    }

    #[test]
    fn supervisor_command_uses_data_directory_and_keeps_caller_html() {
        use massion_carrier::daemon::{caller_html_path, supervisor_command};
        let caller = Path::new("/checkout");
        let data_dir = Path::new("/data");
        let directories = SupervisorDirectories { caller, data: data_dir };
        let command = supervisor_command("node", Some(directories)).unwrap();
        assert_eq!(command.get_current_dir(), Some(data_dir), "the supervisor uses the data directory in both modes");

        for (input, expected) in [
            (Some("assets/index.html"), Some("/checkout/assets/index.html")),
            (Some("/other/index.html"), Some("/other/index.html")),
            (None, None),
            (Some(""), Some("")),
        ] {
            assert_eq!(caller_html_path(caller, input.map(std::ffi::OsStr::new)), expected.map(PathBuf::from));
        }
    }

    #[test]
    fn failure_to_enter_the_data_directory_returns_a_closed_refusal() {
        assert_eq!(
            enter_data_directory(Path::new("/dev/null/daemon-data")),
            Err(StartRefusal::DataDirectoryEnterFailed)
        );
    }

    /// The command guard table: a fake published-document top-level URL is
    /// refused for every command (the wrapper applies it to all six); only the
    /// app origin (both host forms) passes, and nothing the caller sends in
    /// the message is consulted.
    #[test]
    fn command_guard_is_pinned() {
        let document = "massion-app://document/".to_string() + &"a".repeat(64);
        let document_local = "massion-app://localhost/document/".to_string() + &"b".repeat(64);
        assert!(sender_allowed("massion://app/"));
        assert!(sender_allowed("massion://localhost/"));
        assert!(sender_allowed("massion://app/#mission=one"));
        assert!(!sender_allowed(&document), "a published top-level page is refused for every command");
        assert!(!sender_allowed(document_local.as_str()));
        assert!(!sender_allowed(""));
        assert!(!sender_allowed("about:blank"));
        assert!(!sender_allowed("https://example.org/"));
        let source = include_str!("lib.rs");
        assert!(source.contains(".invoke_handler(guarded_invoke)"), "the wrapper cannot be bypassed");
        assert!(source.contains("fn guarded_invoke") && source.contains("if !sender_allowed(&top_level) {"), "one shared guard in the wrapper");
    }

    /// The massion-app handler serves published documents only; its path gate
    /// can never reach the relay's API paths.
    #[test]
    fn document_path_gate_is_pinned() {
        let document = "a".repeat(64);
        assert!(is_document_path(&("/".to_string() + &document)));
        assert!(is_document_path(&("/document/".to_string() + &document)));
        for path in ["/", "/protocol/connect", "/protocol/request", "/protocol/events", "/desktop/settings", "/desktop/notifications", "/desktop/restart", "/document/short", "/other"] {
            assert!(!is_document_path(path), "refused: {}", path);
        }
    }
}
