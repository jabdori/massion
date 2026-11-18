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
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use massion_carrier::{
    control::{
        DrainConnection, DrainFailure, StatusError, StatusReply, DRAIN_TIMEOUT, STATUS_TIMEOUT,
    },
    socket::CarrierError,
    LineClient,
};
use serde_json::Value;
use tauri::http;
use tauri::{AppHandle, Emitter, Manager};

mod cannot_start;
use cannot_start::CannotStartReason;
#[cfg(target_os = "macos")]
mod quit_menu;

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
const START_WAIT: Duration = Duration::from_secs(20);
const STATUS_POLL_INTERVAL: Duration = Duration::from_millis(100);
const DEFAULT_DAEMON_ORIGIN: &str = "http://127.0.0.1:8765";
const DAEMON_SOCKET_NAME: &str = "daemon.sock";

struct Subscription {
    channel: tauri::ipc::Channel<serde_json::Value>,
}

#[derive(Default)]
pub struct HostState {
    client: Mutex<Option<LineClient>>,
    supervisor_socket: Mutex<Option<PathBuf>>,
    daemon_log: Mutex<Option<PathBuf>>,
    data_directory_enter_failed: AtomicBool,
    start_failure_cause: Mutex<Option<String>>,
    quit: Arc<Mutex<QuitState>>,
    subscriptions: Mutex<HashMap<String, Subscription>>,
    notification_keys: Mutex<HashMap<i32, String>>,
    next_notification_id: AtomicI32,
}

impl HostState {
    fn quit_in_progress(&self) -> bool {
        matches!(
            *self.quit.lock().unwrap_or_else(PoisonError::into_inner),
            QuitState::Waiting(_)
        )
    }

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
        desktop_relaunch,
        desktop_ready,
        desktop_events_subscribe,
        desktop_events_close
        ]);
        commands
    };
    commands(invoke)
}

fn wait_client(app: &AppHandle) -> Option<LineClient> {
    wait_client_in_state(&app.state::<HostState>(), CLIENT_WAIT)
}

fn wait_client_in_state(state: &HostState, wait: Duration) -> Option<LineClient> {
    let deadline = std::time::Instant::now() + wait;
    while std::time::Instant::now() < deadline {
        if let Some(client) = state.client.lock().unwrap().clone() {
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

fn supervisor_script(app: &AppHandle) -> std::path::PathBuf {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../daemon-runner.mjs")
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
fn supervisor_args(runner: &str, socket: &str, entry: &str, origin: &str, runtime_directory: &str) -> Vec<String> {
    let mut args = vec![runner.to_string(), socket.to_string()];
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
    SupervisorFailed(Option<String>),
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
            Self::SupervisorFailed(Some(cause)) => {
                write!(formatter, "The supervisor failed to start ({cause})")
            }
            Self::SupervisorFailed(None) => {
                formatter.write_str("The supervisor failed to start")
            }
            Self::Other(message) => formatter.write_str(message),
        }
    }
}

fn enter_data_directory(data_dir: &Path) -> Result<(), StartRefusal> {
    std::env::set_current_dir(data_dir).map_err(|_| StartRefusal::DataDirectoryEnterFailed)
}

#[cfg(any(debug_assertions, test))]
fn expected_daemon_origin_from(override_value: Option<&str>) -> String {
    override_value
        .unwrap_or(DEFAULT_DAEMON_ORIGIN)
        .trim_end_matches('/')
        .to_string()
}

fn expected_daemon_origin() -> String {
    #[cfg(not(debug_assertions))]
    {
        DEFAULT_DAEMON_ORIGIN.to_string()
    }
    #[cfg(debug_assertions)]
    {
        expected_daemon_origin_from(std::env::var("MASSION_DAEMON_ORIGIN").ok().as_deref())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum StatusDecision {
    Attach,
    RetryDraining,
    Refuse(Option<String>),
}

fn valid_failure_cause(cause: Option<&str>) -> Option<String> {
    let cause = cause?;
    let valid = !cause.is_empty()
        && cause.len() <= 64
        && cause
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    valid.then(|| cause.to_string())
}

fn decide_status(reply: &StatusReply, expected_origin: &str) -> StatusDecision {
    if reply.origin.as_deref() != Some(expected_origin) {
        return StatusDecision::Refuse(None);
    }
    match reply.status.as_str() {
        "failed" => StatusDecision::Refuse(valid_failure_cause(reply.cause.as_deref())),
        "running" | "starting" if reply.draining => StatusDecision::RetryDraining,
        "running" | "starting" => StatusDecision::Attach,
        _ => StatusDecision::Refuse(None),
    }
}

fn record_connect_outcome(state: &HostState, outcome: Result<LineClient, StartRefusal>) {
    match outcome {
        Ok(client) => {
            *state.client.lock().unwrap() = Some(client);
        }
        Err(error) => {
            eprintln!("{}", error);
            state.data_directory_enter_failed.store(
                matches!(error, StartRefusal::DataDirectoryEnterFailed),
                Ordering::SeqCst,
            );
            *state
                .start_failure_cause
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = match error {
                StartRefusal::SupervisorFailed(cause) => cause,
                _ => None,
            };
        }
    }
}

/// Asks the supervisor's status once (a starting supervisor is attached to, as
/// on main), waits for a draining supervisor to be gone within its own bound,
/// and — when nothing listens — starts the supervisor detached under the start
/// lock exactly once with its own bound and asks once more.
fn connect_or_start(app: &AppHandle) -> Result<LineClient, StartRefusal> {
    use std::os::unix::fs::PermissionsExt;
    let data_dir = app.path().app_data_dir().map_err(|_| "The desktop data directory is unavailable".to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|_| "The desktop data directory is unavailable".to_string())?;
    std::fs::set_permissions(&data_dir, std::fs::Permissions::from_mode(0o700)).map_err(|_| "The desktop data directory is unavailable".to_string())?;
    *app.state::<HostState>()
        .daemon_log
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = Some(data_dir.join("daemon.log"));
    let handle = app.clone();
    let expected_origin = expected_daemon_origin();
    connect_supervisor(&data_dir, cfg!(not(debug_assertions)), &expected_origin, &app.state::<HostState>().supervisor_socket, |socket| {
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
                DEFAULT_DAEMON_ORIGIN.to_string(),
                runtime.to_string_lossy().to_string(),
            )
        };
        #[cfg(debug_assertions)]
        let (entry, origin, runtime_directory): (String, String, String) = (String::new(), String::new(), String::new());
        let args = supervisor_args(
            &runner.to_string_lossy(),
            &socket.to_string_lossy(),
            &entry,
            &origin,
            &runtime_directory,
        );
        Ok((node, args))
    }, move |line| route_event(&handle, line))
}

fn connect_supervisor(
    data_dir: &Path,
    packaged: bool,
    expected_origin: &str,
    socket_path: &Mutex<Option<PathBuf>>,
    launch: impl FnOnce(&Path) -> Result<(String, Vec<String>), StartRefusal>,
    on_event: impl Fn(&str) + Send + Sync + 'static,
) -> Result<LineClient, StartRefusal> {
    connect_supervisor_within(
        data_dir,
        packaged,
        expected_origin,
        START_WAIT,
        socket_path,
        launch,
        on_event,
    )
}

enum AskStatus {
    Attach,
    Draining,
    NotListening,
    /// The connection was made but no answer came (NoAnswer, Disconnected,
    /// TransportError). During the draining wait this means "going away";
    /// anywhere else it is a refusal.
    Going,
    Refused(StartRefusal),
}

fn refusal_from_cause(cause: Option<String>) -> StartRefusal {
    match cause {
        Some(cause) => StartRefusal::SupervisorFailed(Some(cause)),
        None => StartRefusal::Other("The supervisor is not ready".to_string()),
    }
}

/// Asks the supervisor's status once under the given timeout and maps the
/// answer (or the failure) onto the straight-line start flow.
fn ask_status(socket: &Path, expected_origin: &str, timeout: Duration) -> AskStatus {
    match massion_carrier::control::query_status(socket, timeout) {
        Ok(reply) => match decide_status(&reply, expected_origin) {
            StatusDecision::Attach => AskStatus::Attach,
            StatusDecision::RetryDraining => AskStatus::Draining,
            StatusDecision::Refuse(cause) => AskStatus::Refused(refusal_from_cause(cause)),
        },
        Err(StatusError::NotListening) => AskStatus::NotListening,
        Err(StatusError::NotPrivate) => AskStatus::Refused(
            "A private daemon socket is required".to_string().into(),
        ),
        Err(
            StatusError::NoAnswer
            | StatusError::Disconnected
            | StatusError::TransportError,
        ) => AskStatus::Going,
        Err(StatusError::TruncatedReply | StatusError::InvalidReply) => AskStatus::Refused(
            "The supervisor did not answer status".to_string().into(),
        ),
    }
}

fn connect_supervisor_within(
    data_dir: &Path,
    packaged: bool,
    expected_origin: &str,
    start_wait: Duration,
    socket_path: &Mutex<Option<PathBuf>>,
    launch: impl FnOnce(&Path) -> Result<(String, Vec<String>), StartRefusal>,
    on_event: impl Fn(&str) + Send + Sync + 'static,
) -> Result<LineClient, StartRefusal> {
    let socket = if packaged {
        enter_data_directory(data_dir)?;
        PathBuf::from(DAEMON_SOCKET_NAME)
    } else {
        data_dir.join(DAEMON_SOCKET_NAME)
    };
    // Stored and dropped before any connect, status read, start lock or wait.
    *socket_path.lock().unwrap() = Some(socket.clone());

    // Step 1: classify a supervisor that is already there with one status
    // question.
    let attach = match ask_status(&socket, expected_origin, start_wait) {
        AskStatus::Attach => true,
        AskStatus::Refused(refusal) => return Err(refusal),
        AskStatus::NotListening => false,
        AskStatus::Going => {
            return Err("The supervisor did not answer status".to_string().into())
        }
        AskStatus::Draining => {
            // Step 2: ask again within the same bound until the old supervisor
            // is gone. A dropped or silent connection during this wait
            // (AskStatus::Going) means it is going away; when the bound
            // expires, the document ends it.
            let drain_deadline = Instant::now() + start_wait;
            loop {
                let now = Instant::now();
                if now >= drain_deadline {
                    return Err("The supervisor did not become ready".to_string().into());
                }
                std::thread::sleep(STATUS_POLL_INTERVAL.min(drain_deadline - now));
                match ask_status(&socket, expected_origin, STATUS_TIMEOUT) {
                    AskStatus::Draining | AskStatus::Going => {}
                    AskStatus::Attach => break true,
                    AskStatus::NotListening => break false,
                    AskStatus::Refused(refusal) => return Err(refusal),
                }
            }
        }
    };

    // Step 3, when nothing listens: the ordinary start — main's
    // ensure_supervisor, once per call, with its own bound. A draining answer
    // here is a refusal; nothing goes back to step 2.
    if !attach {
        let (node, args) = launch(&socket)?;
        let log = if packaged {
            PathBuf::from("daemon.log")
        } else {
            data_dir.join("daemon.log")
        };
        // Start under the existing start lock (no host lock held). The child inherits the host's working directory.
        massion_carrier::daemon::ensure_supervisor(&socket, &node, &args, &log, start_wait, None)?;
        // Even when the start spent almost its whole budget, the one question
        // that follows gets its own 1-second bound (STATUS_TIMEOUT).
        match ask_status(&socket, expected_origin, STATUS_TIMEOUT) {
            AskStatus::Attach => {}
            AskStatus::Draining => {
                return Err("The supervisor is not ready".to_string().into())
            }
            AskStatus::NotListening => {
                return Err("The supervisor stopped before becoming ready".to_string().into())
            }
            AskStatus::Going => {
                return Err("The supervisor did not answer status".to_string().into())
            }
            AskStatus::Refused(refusal) => return Err(refusal),
        }
    }

    if !massion_carrier::daemon::socket_is_private(&socket).unwrap_or(false) {
        return Err("A private daemon socket is required".to_string().into());
    }
    LineClient::connect(&socket, on_event).map_err(|_| "The daemon socket is unavailable".to_string().into())
}

fn bare_response(status: u16) -> http::Response<Vec<u8>> {
    http::Response::builder().status(status).body(Vec::new()).unwrap()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SchemeFailure {
    NoClient,
    ClientClosed,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RootFailureAction {
    Empty503,
    CannotStart(CannotStartReason),
}

// 루트 문서 실패 시 호스트 자체 문서를 줄지 빈 503을 유지할지 결정하는 순수 판별 함수.
// 상태 없는 판정이다: 종료 상태는 호출자가 요청마다 한 번만 읽어 전달한다.
fn decide_root_failure(
    is_root_app_get: bool,
    quit_in_progress: bool,
    failure: SchemeFailure,
    data_directory_enter_failed: bool,
) -> RootFailureAction {
    if !is_root_app_get || quit_in_progress {
        return RootFailureAction::Empty503;
    }
    match failure {
        SchemeFailure::NoClient => RootFailureAction::CannotStart(if data_directory_enter_failed {
            CannotStartReason::DataDirectoryEnterFailed
        } else {
            CannotStartReason::ConnectionUnavailable
        }),
        SchemeFailure::ClientClosed => {
            RootFailureAction::CannotStart(CannotStartReason::ConnectionClosed)
        }
        SchemeFailure::Other => RootFailureAction::Empty503,
    }
}

fn prepare_root_failure(
    state: &HostState,
    is_root_app_get: bool,
    quit_in_progress: bool,
    failure: SchemeFailure,
) -> http::Response<Vec<u8>> {
    let data_dir_failed = state.data_directory_enter_failed.load(Ordering::SeqCst);
    match decide_root_failure(
        is_root_app_get,
        quit_in_progress,
        failure,
        data_dir_failed,
    ) {
        RootFailureAction::Empty503 => bare_response(503),
        RootFailureAction::CannotStart(reason) => {
            let log_path = state
                .daemon_log
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
            let cause = (reason == CannotStartReason::ConnectionUnavailable)
                .then(|| {
                    state
                        .start_failure_cause
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .clone()
                })
                .flatten();
            cannot_start::response_with_cause(reason, cause.as_deref(), log_path.as_deref())
        }
    }
}

// Prepares and hands over one response; respond is called with no lock held.
fn respond_scheme_response(
    state: &HostState,
    scheme: &str,
    request: http::Request<Vec<u8>>,
    client_wait: Duration,
    respond: impl FnOnce(http::Response<Vec<u8>>),
) {
    let response = prepare_scheme_response(state, scheme, request, client_wait);
    respond(response);
}

/// Turns one scheme request into one line on the socket and the reply into the
/// scheme response, copying status, headers and body without interpretation.
/// Origin attribution happens by host form: the massion handler serves only the
/// app origin's hosts, the massion-app handler serves published documents only
/// and can never reach the relay's API paths.
fn scheme_response(
    app: &AppHandle,
    scheme: &str,
    request: http::Request<Vec<u8>>,
    respond: impl FnOnce(http::Response<Vec<u8>>),
) {
    let state = app.state::<HostState>();
    respond_scheme_response(&state, scheme, request, CLIENT_WAIT, respond);
}

#[cfg(test)]
fn scheme_response_for_state(
    state: &HostState,
    scheme: &str,
    request: http::Request<Vec<u8>>,
    client_wait: Duration,
) -> http::Response<Vec<u8>> {
    let mut delivered = None;
    respond_scheme_response(state, scheme, request, client_wait, |response| {
        delivered = Some(response);
    });
    delivered.expect("scheme handler must respond once")
}

fn is_root_app_get(scheme: &str, request: &http::Request<Vec<u8>>) -> bool {
    let uri = request.uri();
    let authority = uri.authority().map(http::uri::Authority::as_str);
    let allowed_authority = APP_ORIGINS
        .iter()
        .filter_map(|origin| origin.strip_prefix("massion://"))
        .any(|allowed| authority == Some(allowed));
    scheme == "massion"
        && uri.scheme_str() == Some("massion")
        && allowed_authority
        && request.method() == http::Method::GET
        && uri.path() == "/"
        && uri.query().is_none()
        && request.body().is_empty()
}

fn prepare_scheme_response(
    state: &HostState,
    scheme: &str,
    request: http::Request<Vec<u8>>,
    client_wait: Duration,
) -> http::Response<Vec<u8>> {
    let is_root_app_get = is_root_app_get(scheme, &request);

    // The quit state is read ONCE per request (lock taken, value copied,
    // lock released); every later use, including the failure decision, goes
    // through this copy, so a quit that starts afterwards can only make the
    // response slightly stale, never block.
    let quit_in_progress = state.quit_in_progress();
    // The stateless root-document decision skips the 30-second wait only when
    // no quit attempt was in progress at the moment the state was read.
    let client = if is_root_app_get && !quit_in_progress {
        // Cloned in its own statement so the client-lock guard cannot live on
        // into the failure branches (their log-file check takes other locks).
        let stored = state
            .client
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        match stored {
            Some(client) if !client.is_closed() => client,
            Some(_) => {
                return prepare_root_failure(
                    state,
                    is_root_app_get,
                    quit_in_progress,
                    SchemeFailure::ClientClosed,
                );
            }
            None => {
                return prepare_root_failure(
                    state,
                    is_root_app_get,
                    quit_in_progress,
                    SchemeFailure::NoClient,
                );
            }
        }
    } else {
        let Some(client) = wait_client_in_state(state, client_wait) else {
            let has_client = state
                .client
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .is_some();
            let failure = if has_client {
                SchemeFailure::ClientClosed
            } else {
                SchemeFailure::NoClient
            };
            return prepare_root_failure(state, is_root_app_get, quit_in_progress, failure);
        };
        client
    };

    let method = request.method().as_str().to_string();
    let uri = request.uri().clone();
    let host = uri.host().unwrap_or_default().to_string();
    if scheme == "massion-app" {
        if !matches!(host.as_str(), "document" | "localhost") || !is_document_path(uri.path()) {
            return bare_response(404);
        }
    } else if scheme == "massion" {
        if !matches!(host.as_str(), "app" | "localhost") {
            return bare_response(404);
        }
    } else {
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
            let status = reply.status;
            let mut builder = http::Response::builder().status(status);
            for (name, value) in reply.headers {
                builder = builder.header(name.as_str(), value.as_str());
            }
            let reply_body = reply.body;
            let body_bytes = reply_body
                .as_deref()
                .map(str::as_bytes)
                .unwrap_or_default()
                .to_vec();
            builder
                .body(body_bytes)
                .unwrap_or_else(|_| bare_response(503))
        }
        Err(CarrierError::Closed) => {
            prepare_root_failure(state, is_root_app_get, quit_in_progress, SchemeFailure::ClientClosed)
        }
        Err(CarrierError::Timeout | CarrierError::Busy | CarrierError::Invalid) => {
            prepare_root_failure(state, is_root_app_get, quit_in_progress, SchemeFailure::Other)
        }
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RelaunchRefusal {
    LiveConnection,
    QuitInProgress,
    AlreadyDrained,
    AlreadyRequested,
    BinaryUnavailable,
}

impl RelaunchRefusal {
    const fn message(self) -> &'static str {
        match self {
            Self::LiveConnection => "A supervisor connection is live",
            Self::QuitInProgress => "A quit attempt is in progress",
            Self::AlreadyDrained => "The application is already exiting",
            Self::AlreadyRequested => "A relaunch has already been requested",
            Self::BinaryUnavailable => "The application executable path is unavailable",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RelaunchDecision {
    Relaunch,
    Refuse(RelaunchRefusal),
}

// Evaluates whether a host relaunch may proceed. The command exists for the
// cannot-start state, so a live supervisor connection refuses it outright: the
// normal app document shares the guard's URL with the cannot-start document,
// and a script there must not be able to relaunch the host. The quit state is
// judged under the quit-state lock that commits QuitState::Relaunching, so
// quit and relaunch never overlap.
fn decide_relaunch(
    state: &QuitState,
    live_connection: bool,
    binary_available: bool,
) -> RelaunchDecision {
    if live_connection {
        return RelaunchDecision::Refuse(RelaunchRefusal::LiveConnection);
    }
    match state {
        QuitState::Waiting(_) => RelaunchDecision::Refuse(RelaunchRefusal::QuitInProgress),
        QuitState::Drained => RelaunchDecision::Refuse(RelaunchRefusal::AlreadyDrained),
        QuitState::Relaunching => RelaunchDecision::Refuse(RelaunchRefusal::AlreadyRequested),
        QuitState::Idle | QuitState::Failed(_) => {
            if binary_available {
                RelaunchDecision::Relaunch
            } else {
                RelaunchDecision::Refuse(RelaunchRefusal::BinaryUnavailable)
            }
        }
    }
}

fn request_relaunch(
    quit: &Mutex<QuitState>,
    live_connection: bool,
    binary_available: bool,
    request_restart: impl FnOnce(),
    schedule_take_back: impl FnOnce(),
) -> Result<(), RelaunchRefusal> {
    {
        let mut state = quit.lock().unwrap_or_else(PoisonError::into_inner);
        match decide_relaunch(&state, live_connection, binary_available) {
            RelaunchDecision::Relaunch => {
                *state = QuitState::Relaunching;
            }
            RelaunchDecision::Refuse(reason) => return Err(reason),
        }
    }
    // The quit lock is released before calling request_restart, which can run
    // cleanup_before_exit or re-enter the run loop. The take-back is armed
    // only when the restart request returned: its failing branch restarts and
    // exits inside the framework and never comes back here.
    request_restart();
    schedule_take_back();
    Ok(())
}

/// Runs the relaunch command body against the real host state: reads the
/// supervisor connection once, exactly as the root-document decision does,
/// then decides under the quit lock. The restart and the take-back are
/// injected effects; the command passes the framework calls.
fn relaunch_command(
    state: &HostState,
    binary_available: bool,
    request_restart: impl FnOnce(),
    schedule_take_back: impl FnOnce(),
) -> Result<(), RelaunchRefusal> {
    // Cloned in its own statement so the client-lock guard is released before
    // the quit lock is taken (the same read as the root-document decision).
    let stored = state
        .client
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    let live_connection = matches!(&stored, Some(client) if !client.is_closed());
    request_relaunch(
        &state.quit,
        live_connection,
        binary_available,
        request_restart,
        schedule_take_back,
    )
}

#[tauri::command]
fn desktop_relaunch(app: AppHandle) -> Result<(), String> {
    let state = app.state::<HostState>();
    let quit = state.quit.clone();
    let binary_available = tauri::process::current_binary(&app.env()).is_ok();
    relaunch_command(
        &state,
        binary_available,
        || app.request_restart(),
        || schedule_relaunch_take_back(&quit),
    )
    .map_err(|reason| reason.message().to_string())
}

/// Takes an accepted relaunch back when the framework's exit never arrived,
/// so a quit and a new press work again. Only the relaunch state is rewritten:
/// an attempt already waiting on a drain or a confirmed exit is never touched.
fn take_back_relaunch(quit: &Mutex<QuitState>) {
    let mut state = quit.lock().unwrap_or_else(PoisonError::into_inner);
    if matches!(*state, QuitState::Relaunching) {
        *state = QuitState::Idle;
    }
}

#[cfg(target_os = "macos")]
fn schedule_relaunch_take_back(quit: &Arc<Mutex<QuitState>>) {
    use dispatch2::{DispatchQueue, DispatchTime};

    let quit = Arc::clone(quit);
    // The quit attempt's own main-queue expiry, reused for the relaunch: if
    // the exit the restart requested does not arrive within the drain bound,
    // the state returns to Idle.
    let when = match DispatchTime::try_from(DRAIN_TIMEOUT) {
        Ok(when) if when != DispatchTime::FOREVER => when,
        _ => return,
    };
    if let Err(error) = DispatchQueue::main().after(when, move || take_back_relaunch(&quit)) {
        let _ = writeln!(std::io::stderr(), "schedule relaunch take-back: {error:?}");
    }
}

#[cfg(not(target_os = "macos"))]
fn schedule_relaunch_take_back(_quit: &Arc<Mutex<QuitState>>) {}

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

#[derive(Debug, Default, PartialEq, Eq)]
enum QuitState {
    #[default]
    Idle,
    Waiting(Arc<QuitAttempt>),
    Failed(DrainFailure),
    Drained,
    Relaunching,
}

#[derive(Debug, PartialEq, Eq)]
struct QuitAttempt {
    deadline: Instant,
}

fn begin_quit(
    quit: &Mutex<QuitState>,
    start: impl FnOnce(Arc<QuitAttempt>) -> std::io::Result<()>,
    on_start_failure: impl FnOnce(Arc<QuitAttempt>, DrainFailure),
) {
    let (attempt, deadline) = {
        let mut state = quit.lock().unwrap_or_else(PoisonError::into_inner);
        match *state {
            QuitState::Idle | QuitState::Failed(_) => {
                let now = Instant::now();
                let deadline = now.checked_add(DRAIN_TIMEOUT);
                let attempt = Arc::new(QuitAttempt {
                    deadline: deadline.unwrap_or(now),
                });
                *state = QuitState::Waiting(attempt.clone());
                (attempt, deadline)
            }
            QuitState::Waiting(_) | QuitState::Drained | QuitState::Relaunching => return,
        }
    };
    if let Err(reason) = deadline
        .ok_or(DrainFailure::StartFailed)
        .and_then(|_| start(attempt.clone()).map_err(|_| DrainFailure::StartFailed))
    {
        on_start_failure(attempt, reason);
    }
}

fn is_current_quit(state: &QuitState, attempt: &Arc<QuitAttempt>) -> bool {
    matches!(state, QuitState::Waiting(current) if Arc::ptr_eq(current, attempt))
}

fn current_quit<'a>(
    quit: &'a Mutex<QuitState>,
    attempt: &Arc<QuitAttempt>,
) -> Option<MutexGuard<'a, QuitState>> {
    let state = quit.lock().unwrap_or_else(PoisonError::into_inner);
    (is_current_quit(&state, attempt) && Instant::now() < attempt.deadline).then_some(state)
}

type QuitOutcome = Result<(), DrainFailure>;

fn run_quit_attempt(
    quit: &Mutex<QuitState>,
    attempt: &Arc<QuitAttempt>,
    connect: impl FnOnce() -> Result<DrainConnection, DrainFailure>,
    report: impl FnOnce(QuitOutcome),
) {
    let outcome =
        connect().and_then(|connection| connection.drain_if(|| current_quit(quit, attempt)));
    if let Some(_current) = current_quit(quit, attempt) {
        report(outcome);
    }
}

fn finish_quit(
    quit: &Mutex<QuitState>,
    attempt: &Arc<QuitAttempt>,
    outcome: QuitOutcome,
    exit: impl FnOnce(i32),
    report: impl FnOnce(Value),
    show: impl FnOnce(),
) {
    let mut state = quit.lock().unwrap_or_else(PoisonError::into_inner);
    if !is_current_quit(&state, attempt) {
        return;
    }
    let outcome = if outcome == Err(DrainFailure::StartFailed) || Instant::now() < attempt.deadline
    {
        outcome
    } else {
        Err(DrainFailure::NoAnswer)
    };
    let reason = match outcome {
        Ok(()) => {
            *state = QuitState::Drained;
            drop(state);
            exit(0);
            return;
        }
        Err(reason) => reason,
    };
    *state = QuitState::Failed(reason);
    drop(state);
    let code = match reason {
        DrainFailure::StartFailed => "quit-start-failed",
        DrainFailure::NotConnected => "quit-not-connected",
        DrainFailure::NoAnswer => "quit-no-answer",
        DrainFailure::Disconnected => "quit-disconnected",
        DrainFailure::TransportError => "quit-transport-error",
        DrainFailure::Unsettled => "quit-unsettled",
        DrainFailure::UnexpectedStatus => "quit-unexpected-status",
        DrainFailure::TruncatedReply => "quit-truncated-reply",
        DrainFailure::InvalidReply => "quit-invalid-reply",
    };
    report(serde_json::json!({"quitFailure": code}));
    show();
}

#[cfg(target_os = "macos")]
fn quit_from_menu(app: &AppHandle, event: tauri::menu::MenuEvent) {
    if event.id() != quit_menu::QUIT_ITEM_ID {
        return;
    }
    let Some(state) = app.try_state::<HostState>() else {
        return;
    };
    begin_quit(
        &state.quit,
        |attempt| start_quit(app, &state, attempt),
        |attempt, reason| finish_app_quit(app, &state.quit, &attempt, Err(reason)),
    );
}

#[cfg(target_os = "macos")]
fn start_quit(
    app: &AppHandle,
    state: &HostState,
    attempt: Arc<QuitAttempt>,
) -> std::io::Result<()> {
    use dispatch2::{DispatchQueue, DispatchTime};
    use std::io::ErrorKind;

    let path = state
        .supervisor_socket
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    let timeout_app = app.clone();
    let timeout_quit = state.quit.clone();
    let timeout_attempt = attempt.clone();
    // The main queue expires the attempt even if the socket connect never returns.
    let remaining = attempt.deadline.saturating_duration_since(Instant::now());
    let when = DispatchTime::try_from(remaining).map_err(|_| ErrorKind::InvalidInput)?;
    if when == DispatchTime::FOREVER {
        return Err(ErrorKind::InvalidInput.into());
    }
    DispatchQueue::main()
        .after(when, move || {
            finish_app_quit(
                &timeout_app,
                &timeout_quit,
                &timeout_attempt,
                Err(DrainFailure::NoAnswer),
            );
        })
        .map_err(|_| ErrorKind::InvalidInput)?;

    let app = app.clone();
    let quit = state.quit.clone();
    std::thread::Builder::new()
        .spawn(move || {
            run_quit_attempt(
                &quit,
                &attempt,
                || {
                    path.as_deref()
                        .ok_or(DrainFailure::NotConnected)
                        .and_then(DrainConnection::connect)
                },
                |outcome| {
                    let handle = app.clone();
                    let quit = quit.clone();
                    let attempt = attempt.clone();
                    if let Err(error) = app.run_on_main_thread(move || {
                        finish_app_quit(&handle, &quit, &attempt, outcome);
                    }) {
                        let _ = writeln!(std::io::stderr(), "{error}");
                    }
                },
            );
        })
        .map(drop)
}

#[cfg(target_os = "macos")]
fn finish_app_quit(
    app: &AppHandle,
    quit: &Mutex<QuitState>,
    attempt: &Arc<QuitAttempt>,
    outcome: QuitOutcome,
) {
    finish_quit(
        quit,
        attempt,
        outcome,
        |code| {
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| app.exit(code))).is_err() {
                // Preserve the confirmed exit if Tauri's exit request or cleanup unwinds.
                std::process::exit(code);
            }
        },
        |payload| window_effect("emit quit failure", || app.emit(FOCUS_EVENT, payload)),
        || show_main_window(app),
    );
}

fn hide_on_close(
    prevent: impl FnOnce(),
    hide: impl FnOnce() -> tauri::Result<()>,
) -> tauri::Result<()> {
    prevent();
    hide()
}

fn reveal_window(
    show: impl FnOnce() -> tauri::Result<()>,
    unminimize: impl FnOnce() -> tauri::Result<()>,
    focus: impl FnOnce() -> tauri::Result<()>,
) -> tauri::Result<()> {
    show()?;
    unminimize()?;
    focus()
}

fn show_main_window(app: &AppHandle) {
    window_effect("show window", || {
        if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
            reveal_window(
                || window.show(),
                || window.unminimize(),
                || window.set_focus(),
            )?;
        }
        Ok(())
    });
}

fn window_effect(action: &str, effect: impl FnOnce() -> tauri::Result<()>) {
    // Tauri UI effects can unwind, for example on a poisoned framework lock.
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(effect)) {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            let _ = writeln!(std::io::stderr(), "{action}: {error}");
        }
        Err(_) => {
            let _ = writeln!(std::io::stderr(), "{action} panicked");
        }
    }
}

pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(quit_menu::application_menu).on_menu_event(quit_from_menu);

    let app = builder
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .on_window_event(|window, event| {
            if window.label() == WINDOW_LABEL {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    window_effect("hide window", || {
                        hide_on_close(|| api.prevent_close(), || window.hide())
                    });
                }
            }
        })
        .plugin(tauri_plugin_notification::init())
        .manage(HostState::default())
        .invoke_handler(guarded_invoke)
        .register_asynchronous_uri_scheme_protocol(SCHEMES[0], |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                scheme_response(&app, SCHEMES[0], request, |response| {
                    let _ = responder.respond(response);
                });
            });
        })
        .register_asynchronous_uri_scheme_protocol(SCHEMES[1], |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                scheme_response(&app, SCHEMES[1], request, |response| {
                    let _ = responder.respond(response);
                });
            });
        })
        .setup(|app| {
            let handle = app.handle().clone();
            register_notification_clicks(&handle);
            let outcome = connect_or_start(&handle);
            record_connect_outcome(&app.state::<HostState>(), outcome);
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
        .build(tauri::generate_context!())
        .expect("error while building the Tauri application");
    app.run(|_app, _event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = _event {
            show_main_window(_app);
        }
    });
}

fn register_notification_clicks(handle: &AppHandle) {
    use tauri_plugin_notification::{ActionPerformed, NotificationExt};
    let handle = handle.clone();
    let notifier = handle.clone();
    let _ = notifier.notification().on_action(move |action: &ActionPerformed| {
        let notification_id = action.notification().map(|notification| notification.id());
        notification_clicked(&handle.state::<HostState>(), notification_id, || show_main_window(&handle));
    });
}

fn notification_clicked(state: &HostState, id: Option<i32>, show: impl FnOnce()) {
    let key = id.and_then(|id| state.notification_keys.lock().unwrap().get(&id).cloned());
    let Some(key) = key else { return };
    show();
    if let Some(client) = state.client.lock().unwrap().clone() {
        let _ = client.send_event(&serde_json::json!({"event":"notification-clicked","key":key}).to_string());
    }
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
                "allow-desktop-relaunch",
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

    /// The packaged start's extra arguments reach the supervisor's argument
    /// line; a dev start keeps the merged two arguments.
    #[test]
    fn supervisor_args_stay_two_in_dev_and_five_packaged() {
        let dev = supervisor_args("runner.mjs", "/tmp/daemon.sock", "", "", "");
        assert_eq!(dev, vec!["runner.mjs".to_string(), "/tmp/daemon.sock".to_string()]);
        let packaged = supervisor_args("runner.mjs", "daemon.sock", "/r/src/server.ts", "http://127.0.0.1:8765", "/r");
        assert_eq!(packaged.len(), 5);
        assert_eq!(packaged[1], "daemon.sock");
    }

    #[test]
    fn development_start_inherits_caller_and_uses_absolute_socket() {
        check_supervisor_start(false);
    }

    #[test]
    fn packaged_start_inherits_entered_directory_and_attaches_without_caller() {
        check_supervisor_start(true);
    }

    fn check_supervisor_start(packaged: bool) {
        let root = std::env::temp_dir().join(format!("massion-start-{}-{packaged}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        std::fs::create_dir(root.join("caller")).unwrap();
        std::fs::create_dir(root.join("data")).unwrap();
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "tests::supervisor_start_in_child"])
            .current_dir(root.join("caller"))
            .env("MASSION_TEST_START_DIR", &root)
            .env("MASSION_TEST_PACKAGED", if packaged { "1" } else { "0" })
            .output();
        std::fs::remove_dir_all(root).unwrap();
        let result = result.unwrap();
        let stdout = String::from_utf8_lossy(&result.stdout);
        assert!(
            result.status.success() && stdout.contains("tests::supervisor_start_in_child ... ok"),
            "{stdout}\n{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }

    #[test]
    #[ignore = "run in a separate process because packaged startup changes the working directory"]
    fn supervisor_start_in_child() {
        let root = PathBuf::from(std::env::var_os("MASSION_TEST_START_DIR").unwrap());
        let packaged = std::env::var("MASSION_TEST_PACKAGED").unwrap() == "1";
        let caller = root.join("caller");
        let data_dir = root.join("data");
        let moved = root.join("moved");
        let runner = root.join("runner.cjs");
        std::fs::write(&runner, r#"
            process.umask(0o077);
            console.log(process.cwd());
            let clients = Number(process.argv[3]) || 1;
            const server = require('node:net').createServer(peer => {
                peer.on('error', () => {});
                let buf = '';
                peer.on('data', chunk => {
                    buf += chunk;
                    if (!buf.includes('\n')) return;
                    if (buf === 'status\n') {
                        peer.end(JSON.stringify({status: 'running', pid: process.pid, origin: 'http://127.0.0.1:8765'}));
                    } else {
                        peer.end();
                        if (--clients === 0) server.close();
                    }
                });
            });
            server.listen(process.argv[2]);
            setTimeout(() => process.exit(1), 10000).unref();
        "#).unwrap();

        let stored_socket = Mutex::default();
        let expected = if packaged { PathBuf::from("daemon.sock") } else { data_dir.join("daemon.sock") };
        connect_supervisor(&data_dir, packaged, DEFAULT_DAEMON_ORIGIN, &stored_socket, |socket| {
            assert_eq!(socket, expected, "supervisor socket argument");
            // Replace the old name after directory selection so it cannot stand in for inheritance.
            let inherited = if packaged { &data_dir } else { &caller };
            std::fs::rename(inherited, &moved).unwrap();
            std::fs::create_dir(inherited).unwrap();
            let entry = if packaged { "2" } else { "" };
            let args = supervisor_args(runner.to_str().unwrap(), socket.to_str().unwrap(), entry, "", "");
            Ok(("node".to_string(), args))
        }, |_| {}).unwrap();
        assert_eq!(stored_socket.into_inner().unwrap(), Some(expected), "stored quit control socket");

        let log = if packaged { &moved } else { &data_dir }.join("daemon.log");
        assert_eq!(std::fs::read_to_string(log).unwrap().trim_end(), moved.to_str().unwrap());
        if packaged {
            std::env::set_current_dir(&caller).unwrap();
            std::fs::remove_dir(&caller).unwrap();
            assert!(std::env::current_dir().is_err());
            let stored_socket = Mutex::default();
            connect_supervisor(&moved, true, DEFAULT_DAEMON_ORIGIN, &stored_socket, |_| panic!("a listening supervisor must be reused"), |_| {}).unwrap();
            assert_eq!(stored_socket.into_inner().unwrap(), Some(PathBuf::from("daemon.sock")), "stored quit control socket on attach");
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

#[cfg(test)]
mod quit_tests;

#[cfg(test)]
mod cannot_start_tests;
