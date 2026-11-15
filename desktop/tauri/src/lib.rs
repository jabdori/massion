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
use std::sync::atomic::{AtomicI32, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use massion_carrier::LineClient;
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
/// The two custom URI scheme protocols the daemon serves.
pub const SCHEMES: [&str; 2] = ["massion", "massion-app"];
const FOCUS_EVENT: &str = "desktop:focus";
const CLIENT_WAIT: Duration = Duration::from_secs(30);

struct Subscription {
    channel: tauri::ipc::Channel<String>,
    /// Events buffered until the subscribe command resolves; the JavaScript
    /// source registers itself only after the invoke resolves.
    pending: Option<Vec<String>>,
}

#[derive(Default)]
pub struct HostState {
    client: Mutex<Option<LineClient>>,
    subscriptions: Mutex<HashMap<String, Subscription>>,
    notification_keys: Mutex<HashMap<i32, String>>,
    next_notification_id: AtomicI32,
    next_subscription_id: AtomicU64,
}

/// Navigation is limited to the app origin and the published app documents.
/// Both host forms are allowed because the documented custom-scheme origin is
/// <scheme>://localhost/<path> on macOS/iOS/Linux (docs.rs Builder warning).
pub fn is_app_navigation(url: &tauri::Url) -> bool {
    let text = url.as_str();
    for base in ["massion://app", "massion://localhost"] {
        let with_slash = format!("{}/", base);
        let with_hash = format!("{}/#", base);
        if text == base || text == with_slash || text == with_hash || text.starts_with(&with_hash) {
            return true;
        }
    }
    for prefix in ["massion-app://document/", "massion-app://localhost/document/"] {
        if let Some(rest) = text.strip_prefix(prefix) {
            let document = rest.split('#').next().unwrap_or("");
            if document.len() == 64 && document.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return true;
            }
        }
    }
    false
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
                match &mut entry.pending {
                    Some(buffer) => buffer.push(line.to_string()),
                    None => {
                        let _ = entry.channel.send(line.to_string());
                    }
                }
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

fn supervisor_script() -> std::path::PathBuf {
    #[cfg(debug_assertions)]
    {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../daemon-runner.mjs")
    }
    #[cfg(not(debug_assertions))]
    {
        std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| dir.join("daemon-runner.mjs")))
            .unwrap_or_default()
    }
}

/// Tries the socket; if nothing answers it starts the supervisor detached,
/// then connects after the same privacy check desktop/daemon.ts applies.
fn connect_or_start(app: &AppHandle) -> Result<LineClient, String> {
    use std::os::unix::fs::{FileTypeExt, PermissionsExt};
    let data_dir = app.path().app_data_dir().map_err(|_| "The desktop data directory is unavailable".to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|_| "The desktop data directory is unavailable".to_string())?;
    std::fs::set_permissions(&data_dir, std::fs::Permissions::from_mode(0o700)).map_err(|_| "The desktop data directory is unavailable".to_string())?;
    let socket = data_dir.join("daemon.sock");
    if std::os::unix::net::UnixStream::connect(&socket).is_err() {
        if socket.exists() && std::fs::symlink_metadata(&socket).map(|meta| meta.file_type().is_socket()).unwrap_or(false) {
            if massion_carrier::daemon::socket_is_private(&socket).unwrap_or(false) {
                let _ = std::fs::remove_file(&socket);
            } else {
                return Err("Refusing an unowned or exposed daemon socket".to_string());
            }
        }
        let runner = supervisor_script();
        if !runner.is_file() {
            return Err("The supervisor script is missing".to_string());
        }
        let node = massion_carrier::daemon::node_binary();
        let args = vec![runner.to_string_lossy().to_string(), socket.to_string_lossy().to_string()];
        massion_carrier::daemon::start_detached(&node, &args, &data_dir.join("daemon.log"))
            .map_err(|_| "The supervisor could not start".to_string())?;
        if !massion_carrier::daemon::wait_for_socket(&socket, Duration::from_secs(20)) {
            return Err("The supervisor did not answer".to_string());
        }
    }
    if !massion_carrier::daemon::socket_is_private(&socket).unwrap_or(false) {
        return Err("A private daemon socket is required".to_string());
    }
    let handle = app.clone();
    LineClient::connect(&socket, move |line| route_event(&handle, line)).map_err(|_| "The daemon socket is unavailable".to_string())
}

fn bare_response(status: u16) -> http::Response<Vec<u8>> {
    http::Response::builder().status(status).body(Vec::new()).unwrap()
}

/// Turns one scheme request into one line on the socket and the reply into the
/// scheme response, copying status, headers and body without interpretation.
fn scheme_response(app: &AppHandle, request: http::Request<Vec<u8>>) -> http::Response<Vec<u8>> {
    let Some(client) = wait_client(app) else {
        return bare_response(503);
    };
    let method = request.method().as_str().to_string();
    let uri = request.uri().clone();
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
    path: String,
    last_event_id: Option<String>,
    channel: tauri::ipc::Channel<String>,
) -> Result<String, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let id = format!("sub-{}", app.state::<HostState>().next_subscription_id.fetch_add(1, Ordering::SeqCst));
        app.state::<HostState>()
            .subscriptions
            .lock()
            .unwrap()
            .insert(id.clone(), Subscription { channel, pending: Some(Vec::new()) });
        let Some(client) = wait_client(&app) else {
            app.state::<HostState>().subscriptions.lock().unwrap().remove(&id);
            return Err("The desktop relay is unavailable".to_string());
        };
        match client.request("GET", &path, last_event_id.as_deref(), None) {
            Ok(reply) if (200..300).contains(&reply.status) => {
                let state = app.state::<HostState>();
                let mut subscriptions = state.subscriptions.lock().unwrap();
                if let Some(entry) = subscriptions.get_mut(&id) {
                    if let Some(buffer) = entry.pending.take() {
                        for line in buffer {
                            let _ = entry.channel.send(line);
                        }
                    }
                }
                Ok(id)
            }
            _ => {
                app.state::<HostState>().subscriptions.lock().unwrap().remove(&id);
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
        .invoke_handler(tauri::generate_handler![
            desktop_settings,
            desktop_save_notifications,
            desktop_restart,
            desktop_ready,
            desktop_events_subscribe,
            desktop_events_close
        ])
        .register_asynchronous_uri_scheme_protocol(SCHEMES[0], |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                let response = scheme_response(&app, request);
                let _ = responder.respond(response);
            });
        })
        .register_asynchronous_uri_scheme_protocol(SCHEMES[1], |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                let response = scheme_response(&app, request);
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
        assert_eq!(configuration["bundle"]["active"], false);
        assert_eq!(SCHEMES, ["massion", "massion-app"]);
        assert_eq!((WINDOW_WIDTH, WINDOW_HEIGHT, WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT), (1440.0, 960.0, 650.0, 600.0));
        let document = "massion-app://document/".to_string() + &"a".repeat(64);
        let localhost = "massion-app://localhost/document/".to_string() + &"b".repeat(64);
        assert!(is_app_navigation(&"massion://app/".parse().unwrap()));
        assert!(is_app_navigation(&"massion://localhost/#mission=one".parse().unwrap()));
        assert!(is_app_navigation(&document.parse().unwrap()));
        assert!(is_app_navigation(&localhost.parse().unwrap()));
        for url in [
            "https://example.org/",
            "file:///etc/passwd",
            "massion://app/other",
            "massion://app/?q=1",
            "massion://evil/",
            "massion-app://document/short",
            &("massion-app://document/".to_string() + &"g".repeat(63)),
        ] {
            assert!(!is_app_navigation(&url.parse().unwrap()), "refused: {}", url);
        }
    }
}
