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
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime};

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
mod recovery;
use recovery::{watch_supervisor, Recovery, RecoveryPhase, RootReplyState};
mod root_document;
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
    recovery: Mutex<Recovery>,
    recovery_changed: Condvar,
    first_document_served: AtomicBool,
    initial_handoff_retried: AtomicBool,
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
    #[cfg(test)]
    fn quit_in_progress(&self) -> bool {
        self.quit.lock().unwrap_or_else(PoisonError::into_inner).in_progress()
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
    wait_client_with(state, wait, std::thread::sleep)
}

fn wait_client_with(
    state: &HostState,
    wait: Duration,
    mut wait_again: impl FnMut(Duration),
) -> Option<LineClient> {
    let deadline = std::time::Instant::now() + wait;
    while std::time::Instant::now() < deadline {
        if let Some(client) = state.client.lock().unwrap().clone() {
            if !client.is_closed() {
                return Some(client);
            }
        }
        wait_again(Duration::from_millis(50));
    }
    None
}

fn wait_initial_quit_client(state: &HostState, deadline: Instant) -> Option<LineClient> {
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return None;
        }
        let stored = match state.client.try_lock() {
            Ok(client) => Some(client),
            Err(std::sync::TryLockError::Poisoned(error)) => Some(error.into_inner()),
            Err(std::sync::TryLockError::WouldBlock) => None,
        };
        if let Some(client) = stored.and_then(|client| client.clone()).filter(|client| !client.is_closed()) {
            return Some(client);
        }
        std::thread::sleep(remaining.min(Duration::from_millis(50)));
    }
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

/// The one line the host appends to the daemon log when the start is refused,
/// in the supervisor's own one-line JSON style (the core's hostSettings and
/// hostShutdown lines): a time in epoch milliseconds like the supervisor's
/// startedAt, the closed reason code the document shows for that refusal and
/// the validated supervisor cause when there is one. A data directory that
/// could not be entered has no place to write in, so that refusal has no line.
fn refusal_log_line(error: &StartRefusal, time_unix_ms: u64) -> Option<Value> {
    let cause = match error {
        StartRefusal::DataDirectoryEnterFailed => return None,
        StartRefusal::SupervisorFailed(cause) => cause.as_deref(),
        StartRefusal::Other(_) => None,
    };
    let entry = match cause {
        Some(cause) => serde_json::json!({
            "time": time_unix_ms,
            "reason": CannotStartReason::ConnectionUnavailable.code(),
            "cause": cause,
        }),
        None => serde_json::json!({
            "time": time_unix_ms,
            "reason": CannotStartReason::ConnectionUnavailable.code(),
        }),
    };
    Some(serde_json::json!({ "hostStartRefused": entry }))
}

/// Appends a host result line to the daemon log the document points to. The
/// open keeps the supervisor's own rules (start_detached: create when
/// missing, append, never truncate, 0600 at creation) and adds O_NOFOLLOW
/// and O_NONBLOCK: the supervisor's stdio open would follow a symbolic link
/// at the log path and would block on a FIFO, this write does neither. What
/// may be written is decided from the metadata of the OPENED descriptor -
/// only a regular file - so a FIFO that opened because a reader was attached
/// still gets nothing, and no gap remains between the check and the open.
/// The whole line leaves as one write call, so a line the supervisor or the
/// core appends at the same moment cannot land inside ours. No lock another
/// path waits on is held; a failure goes to standard error only and never
/// changes the start outcome or the document.
fn append_daemon_log_line(path: &Path, line: Value) {
    use std::os::unix::fs::OpenOptionsExt;
    let write = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .and_then(|file| {
            if !file.metadata().map(|meta| meta.is_file()).unwrap_or(false) {
                return Ok(());
            }
            write_refusal_line(file, &line)
        });
    if let Err(error) = write {
        eprintln!("the host result could not be appended to the daemon log: {error}");
    }
}

/// Renders the line once (the JSON object and the trailing newline) and hands
/// the whole of it to one write call: a writer that receives it in fragments
/// fails the one-write test.
fn write_refusal_line<W: Write>(mut writer: W, line: &Value) -> std::io::Result<()> {
    let bytes = format!("{line}\n");
    writer.write_all(bytes.as_bytes())
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}

fn record_connect_outcome(state: &HostState, outcome: Result<LineClient, StartRefusal>) {
    match outcome {
        Ok(client) => {
            state.install_initial_client(client, Instant::now());
        }
        Err(error) => {
            eprintln!("{}", error);
            // One line in the daemon log the document points to, built from
            // the same refusal the document's reason code and cause come
            // from. The write runs before any window exists, so the document
            // (rendered on the first scheme request) is always built after
            // it.
            let log_path = state
                .daemon_log
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
            if let (Some(log_path), Some(line)) = (log_path, refusal_log_line(&error, unix_time_ms())) {
                append_daemon_log_line(&log_path, line);
            }
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
fn connect_or_start(app: &AppHandle, recovering: bool) -> Result<LineClient, StartRefusal> {
    use std::os::unix::fs::PermissionsExt;
    let state = app.state::<HostState>();
    let packaged = cfg!(not(debug_assertions));
    let data_dir = app.path().app_data_dir().map_err(|_| "The desktop data directory is unavailable".to_string())?;
    let socket = if recovering {
        // The process-wide working directory was set before the window opened.
        state.supervisor_socket.lock().unwrap().clone()
            .ok_or_else(|| "The daemon socket is unavailable".to_string())?
    } else {
        std::fs::create_dir_all(&data_dir).map_err(|_| "The desktop data directory is unavailable".to_string())?;
        std::fs::set_permissions(&data_dir, std::fs::Permissions::from_mode(0o700)).map_err(|_| "The desktop data directory is unavailable".to_string())?;
        *state.daemon_log.lock().unwrap_or_else(PoisonError::into_inner) = Some(data_dir.join("daemon.log"));
        prepare_supervisor_socket(&data_dir, packaged, &state.supervisor_socket)?
    };
    let handle = app.clone();
    let expected_origin = expected_daemon_origin();
    connect_supervisor_at(&socket, &supervisor_log(&data_dir, packaged), &expected_origin, START_WAIT, |socket| {
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
    }, move |line| route_event(&handle, line), recovering.then_some(&*state))
}

#[cfg(test)]
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

fn prepare_supervisor_socket(
    data_dir: &Path,
    packaged: bool,
    socket_path: &Mutex<Option<PathBuf>>,
) -> Result<PathBuf, StartRefusal> {
    let socket = if packaged {
        enter_data_directory(data_dir)?;
        PathBuf::from(DAEMON_SOCKET_NAME)
    } else {
        data_dir.join(DAEMON_SOCKET_NAME)
    };
    // Stored and dropped before any connect, status read, start lock or wait.
    *socket_path.lock().unwrap() = Some(socket.clone());
    Ok(socket)
}

fn supervisor_log(data_dir: &Path, packaged: bool) -> PathBuf {
    if packaged { PathBuf::from("daemon.log") } else { data_dir.join("daemon.log") }
}

#[cfg(test)]
fn connect_supervisor_within(
    data_dir: &Path,
    packaged: bool,
    expected_origin: &str,
    start_wait: Duration,
    socket_path: &Mutex<Option<PathBuf>>,
    launch: impl FnOnce(&Path) -> Result<(String, Vec<String>), StartRefusal>,
    on_event: impl Fn(&str) + Send + Sync + 'static,
) -> Result<LineClient, StartRefusal> {
    let socket = prepare_supervisor_socket(data_dir, packaged, socket_path)?;
    connect_supervisor_at(
        &socket, &supervisor_log(data_dir, packaged), expected_origin, start_wait,
        launch, on_event, None,
    )
}

fn connect_supervisor_at(
    socket: &Path,
    log: &Path,
    expected_origin: &str,
    start_wait: Duration,
    launch: impl FnOnce(&Path) -> Result<(String, Vec<String>), StartRefusal>,
    on_event: impl Fn(&str) + Send + Sync + 'static,
    recovering: Option<&HostState>,
) -> Result<LineClient, StartRefusal> {
    let check_recovering = || {
        recovering.map_or(Ok(()), HostState::check_recovering)
            .map_err(|_| StartRefusal::from("The supervisor start was cancelled".to_string()))
    };
    check_recovering()?;
    // Step 1: classify a supervisor that is already there with one status
    // question.
    let attach = match ask_status(socket, expected_origin, start_wait) {
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
                check_recovering()?;
                match ask_status(socket, expected_origin, STATUS_TIMEOUT) {
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
        check_recovering()?;
        let (node, args) = launch(socket)?;
        // Start under the existing start lock (no host lock held). The child inherits the host's working directory.
        if let Some(state) = recovering {
            state.start_recovery_supervisor(socket, start_wait, |authorize| {
                massion_carrier::daemon::start_detached_if(&node, &args, log, None, authorize)
            })?;
        } else {
            massion_carrier::daemon::ensure_supervisor(socket, &node, &args, log, start_wait, None)?;
        }
        // Even when the start spent almost its whole budget, the one question
        // that follows gets its own 1-second bound (STATUS_TIMEOUT).
        match ask_status(socket, expected_origin, STATUS_TIMEOUT) {
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

    check_recovering()?;
    if !massion_carrier::daemon::socket_is_private(socket).unwrap_or(false) {
        return Err("A private daemon socket is required".to_string().into());
    }
    LineClient::connect(socket, on_event).map_err(|_| "The daemon socket is unavailable".to_string().into())
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
        RootFailureAction::CannotStart(reason) => start_failure_response(state, reason),
    }
}

fn start_failure_response(
    state: &HostState,
    reason: CannotStartReason,
) -> http::Response<Vec<u8>> {
    let log_path = state
        .daemon_log
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    let cause = (reason == CannotStartReason::ConnectionUnavailable)
        .then(|| state.start_failure_cause.lock().unwrap_or_else(PoisonError::into_inner).clone())
        .flatten();
    cannot_start::response_with_cause(reason, cause.as_deref(), log_path.as_deref())
}

// Prepares and hands over one response; respond is called with no lock held.
#[cfg(test)]
fn respond_scheme_response(
    state: &HostState,
    scheme: &str,
    request: http::Request<Vec<u8>>,
    client_wait: Duration,
    respond: impl FnOnce(http::Response<Vec<u8>>),
) {
    let root = is_root_app_get(scheme, &request);
    let initial = root && root_document::is_initial(state);
    let deadline = initial.then(|| Instant::now() + client_wait);
    let response = prepare_scheme_response(state, scheme, request, client_wait, deadline);
    deliver_scheme_response(state, root, response, None, respond);
}

#[derive(Clone)]
enum RootReplySource {
    Relay(LineClient),
    QuitRelay(LineClient),
    Stopped(LineClient),
}

fn deliver_scheme_response(
    state: &HostState,
    root: bool,
    response: http::Response<Vec<u8>>,
    handoff: Option<(Instant, bool)>,
    respond: impl FnOnce(http::Response<Vec<u8>>),
) {
    let mut response = check_root_reply_at_delivery(state, response);
    let source = response.extensions_mut().remove::<RootReplySource>();
    let serves_document = root
        && !response.body().is_empty()
        && !response.status().is_redirection()
        && response
            .headers()
            .get(http::header::CONTENT_TYPE)
            .is_some_and(|value| {
                value.as_bytes().starts_with(b"text/html;") || value.as_bytes() == b"text/html"
            });
    if handoff.is_some_and(|(deadline, _)| Instant::now() >= deadline) {
        return;
    }
    respond(response);
    if serves_document && root_document::is_initial(state) {
        state.record_first_document_handoff(
            source.as_ref(),
            handoff.is_some_and(|(_, retry)| retry),
        );
    }
}

fn check_root_reply_at_delivery(
    state: &HostState,
    response: http::Response<Vec<u8>>,
) -> http::Response<Vec<u8>> {
    let Some(source) = response.extensions().get::<RootReplySource>() else {
        return response;
    };
    let status = match source {
        RootReplySource::Relay(client) | RootReplySource::QuitRelay(client) | RootReplySource::Stopped(client) => {
            state.root_reply_state(client)
        }
    };
    match (source, status) {
        (RootReplySource::Relay(_) | RootReplySource::QuitRelay(_), RootReplyState::Open)
        | (RootReplySource::Stopped(_), RootReplyState::Stopped) => response,
        (RootReplySource::Relay(client), RootReplyState::Stopped) if root_document::is_initial(state) => {
            let mut closed = start_failure_response(state, CannotStartReason::ConnectionClosed);
            closed.extensions_mut().insert(RootReplySource::Stopped(client.clone()));
            closed
        }
        _ => bare_response(503),
    }
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
    let root = is_root_app_get(scheme, &request);
    let response = prepare_scheme_response(&state, scheme, request, CLIENT_WAIT, None);
    deliver_scheme_response(&state, root, response, None, respond);
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
    initial_deadline: Option<Instant>,
) -> http::Response<Vec<u8>> {
    let is_root_app_get = is_root_app_get(scheme, &request);
    // The quit state is read ONCE per request (lock taken, value copied,
    // lock released); every later use, including the failure decision, goes
    // through this copy, so a quit that starts afterwards can only make the
    // response slightly stale, never block.
    let quit = state.quit.lock().unwrap_or_else(PoisonError::into_inner);
    let quit_in_progress = quit.in_progress();
    // With no quit in progress, the root document uses the stored client and
    // recovery phase immediately instead of waiting for a client.
    let client = if is_root_app_get && !quit_in_progress {
        let (stored, terminal_recovery) = {
            let recovery = state.recovery.lock().unwrap_or_else(PoisonError::into_inner);
            let stored = state.client.lock().unwrap_or_else(PoisonError::into_inner).clone();
            let terminal = recovery.phase == RecoveryPhase::Exhausted
                || (recovery.phase == RecoveryPhase::Cancelled && matches!(*quit, QuitState::Failed(_)));
            (stored, terminal)
        };
        drop(quit);
        match stored {
            Some(client) if !client.is_closed() => client,
            Some(_) if terminal_recovery => {
                return prepare_root_failure(
                    state,
                    is_root_app_get,
                    quit_in_progress,
                    SchemeFailure::ClientClosed,
                );
            }
            Some(client) if client.closed_without_eof() => {
                let mut response = start_failure_response(state, CannotStartReason::ConnectionClosed);
                if initial_deadline.is_some() {
                    response.extensions_mut().insert(RootReplySource::Stopped(client));
                }
                return response;
            }
            Some(_) => return bare_response(503),
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
        drop(quit);
        let stored = match initial_deadline {
            Some(deadline) => wait_initial_quit_client(state, deadline),
            None => wait_client_in_state(state, client_wait),
        };
        let Some(client) = stored else {
            if initial_deadline.is_some() {
                return bare_response(503);
            }
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

    if let Some(deadline) = initial_deadline {
        if !quit_in_progress {
            return root_document::relay(state, client, deadline);
        }
        let mut response = client.request_root_until(deadline)
            .ok()
            .and_then(|reply| scheme_reply(reply).ok())
            .unwrap_or_else(|| bare_response(503));
        response.extensions_mut().insert(RootReplySource::QuitRelay(client));
        return response;
    }

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
            let mut response = scheme_reply(reply).unwrap_or_else(|_| bare_response(503));
            if is_root_app_get {
                let source = if quit_in_progress {
                    RootReplySource::QuitRelay(client)
                } else {
                    RootReplySource::Relay(client)
                };
                response.extensions_mut().insert(source);
            }
            response
        }
        Err(error) => {
            scheme_request_failure(state, is_root_app_get, quit_in_progress, &client, error)
        }
    }
}

fn scheme_reply(reply: massion_carrier::socket::Reply) -> Result<http::Response<Vec<u8>>, http::Error> {
    let mut builder = http::Response::builder().status(reply.status);
    for (name, value) in reply.headers {
        builder = builder.header(name.as_str(), value.as_str());
    }
    builder.body(reply.body.unwrap_or_default().into_bytes())
}

fn scheme_request_failure(
    state: &HostState,
    root: bool,
    quit_in_progress: bool,
    client: &LineClient,
    error: CarrierError,
) -> http::Response<Vec<u8>> {
    let failure = if root
        && error == CarrierError::Closed
        && client.closed_without_eof()
        && state.is_current_client(client)
    {
        SchemeFailure::ClientClosed
    } else {
        SchemeFailure::Other
    };
    prepare_root_failure(state, root, quit_in_progress, failure)
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

/// Command argument bounds, each derived from the daemon side so a command
/// can never write a line the relay would close the connection for: the relay
/// (desktop/client-relay.ts) drops the whole connection when one line reaches
/// clientLimits.requestLineBytes = 65536 bytes including the newline, and the
/// requests already in flight on that connection fail (#293, #277).
///
/// - Subscription id: "sub-" plus ASCII digits, at most 32 bytes, the form
///   desktop/tauri-client.js generates ("sub-" plus a counter); inside a
///   close or request line it stays under 60 bytes.
/// - Events path: "/protocol/events" optionally followed by "?...", the only
///   form the relay itself subscribes, and at most 8192 bytes: the relay's own
///   path limit is 8192 UTF-16 units and a Rust byte count is never smaller
///   than the UTF-16 count of the same string.
/// - Last-Event-ID: a JSON array of [feedId, cursor], the exact form the feed
///   writes as the event id (src/protocol-feed.ts) and the server parses back
///   on resume (src/server.ts), and at most 4096 bytes: the relay's own
///   header-value limit is 4096 UTF-16 units.
///
/// The largest line these bounds allow, counted in bytes with the worst JSON
/// escaping serde_json performs on the raw argument bytes, is 57,365 of the
/// 65,536 the relay still accepts: 77 fixed envelope bytes + a 32-byte id
/// (ASCII digits, never escaped) + a path whose fixed 17 bytes pass through
/// and whose other 8,175 bytes each serialize as a six-byte \u00XX escape
/// (49,067) + a last-event id whose 4,092 doubling bytes (the array's own
/// quotes, backslashes, and raw tab/CR/LF whitespace) each become two and
/// whose remaining 4 bytes ([, comma, digit, ]) pass through (8,188) + the
/// newline: 77 + 32 + 49,067 + 8,188 + 1. Non-ASCII characters serialize
/// raw, so bytes in equals bytes out there. The one writer-side bound in the
/// carrier's write_line, which every written line passes, is the last guard.
fn valid_subscription_id(id: &str) -> bool {
    id.len() <= 32
        && id.starts_with("sub-")
        && id[4..].bytes().all(|byte| byte.is_ascii_digit())
}

fn valid_events_path(path: &str) -> bool {
    path.len() <= 8192 && (path == "/protocol/events" || path.starts_with("/protocol/events?"))
}

fn valid_last_event_id(value: &str) -> bool {
    if value.is_empty() || value.len() > 4096 {
        return false;
    }
    match serde_json::from_str::<Value>(value) {
        Ok(Value::Array(items)) => items.len() == 2 && items[0].is_string() && items[1].as_u64().is_some(),
        _ => false,
    }
}

/// The subscribe command's body, split from the Tauri wrapper so the bounds
/// and the write can run against a real socket: every argument is checked
/// before the id is stored or anything is written.
fn events_subscribe(
    state: &HostState,
    subscription: &str,
    path: &str,
    last_event_id: Option<&str>,
    channel: tauri::ipc::Channel<serde_json::Value>,
    wait: impl FnOnce() -> Option<LineClient>,
) -> Result<String, String> {
    // The client generates the id and registers its source BEFORE this
    // invoke resolves, so an event can never precede registration on the
    // JavaScript side. A duplicate id would hijack another channel.
    let valid = valid_subscription_id(subscription)
        && valid_events_path(path)
        && last_event_id.map(valid_last_event_id).unwrap_or(true);
    let mut subscriptions = state.subscriptions.lock().unwrap();
    if !valid || subscriptions.contains_key(subscription) {
        return Err("Refused desktop sender".to_string());
    }
    subscriptions.insert(subscription.to_string(), Subscription { channel });
    drop(subscriptions);
    let Some(client) = wait() else {
        state.subscriptions.lock().unwrap().remove(subscription);
        return Err("The desktop relay is unavailable".to_string());
    };
    // The same id travels the whole path: channel registry, socket request, events, close.
    match client.request_as_timed(subscription, "GET", path, last_event_id, None, massion_carrier::socket::REQUEST_TIMEOUT) {
        Ok(reply) if (200..300).contains(&reply.status) => Ok(subscription.to_string()),
        _ => {
            state.subscriptions.lock().unwrap().remove(subscription);
            Err("The feed refused the subscription".to_string())
        }
    }
}

/// The close command's body: a close for any id of the known form is
/// forwarded, whether or not the host still knows it. The host's map is not
/// the relay's truth: events_subscribe removes its entry when the subscribe
/// fails while the relay can still hold that subscription (its request race
/// times out, it answers an error but keeps the subscription,
/// desktop/client-relay.ts), and the page sends its close exactly then
/// (desktop/tauri-client.js); swallowing the close strands the relay slot
/// until the app restarts. The relay ignores a close for an id it does not
/// know, and a validated close line is at most 68 bytes. An id outside the
/// bound is refused before any state change.
fn events_close(state: &HostState, subscription: &str, wait: impl FnOnce() -> Option<LineClient>) -> Result<(), String> {
    if !valid_subscription_id(subscription) {
        return Err("Refused desktop sender".to_string());
    }
    state.subscriptions.lock().unwrap().remove(subscription);
    if let Some(client) = wait() {
        let _ = client.send_close(subscription);
    }
    Ok(())
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

// Evaluates whether a host relaunch may proceed. The guard cannot tell the
// cannot-start document from the normal app document (they share the
// top-level URL), so the decision refuses while a supervisor connection is
// live; once that connection has closed, the command stays callable from the
// same address. The quit state is judged under the quit-state lock that
// commits QuitState::Relaunching, so quit and relaunch never overlap.
fn decide_relaunch(
    state: &QuitState,
    live_connection: bool,
    binary_available: bool,
) -> RelaunchDecision {
    if live_connection {
        return RelaunchDecision::Refuse(RelaunchRefusal::LiveConnection);
    }
    match state {
        QuitState::Queued(_) | QuitState::Waiting(_) => RelaunchDecision::Refuse(RelaunchRefusal::QuitInProgress),
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

fn relaunch_command(
    state: &HostState,
    binary_available: bool,
    request_restart: impl FnOnce(),
    drain_then_restart: impl FnOnce(Arc<QuitAttempt>),
) -> Result<(), RelaunchRefusal> {
    let drain = {
        let mut quit = state.quit.lock().unwrap_or_else(PoisonError::into_inner);
        let launch_pending = match decide_relaunch(&quit, state.has_live_client(), binary_available) {
            RelaunchDecision::Relaunch => state.cancel_recovery(),
            RelaunchDecision::Refuse(reason) => return Err(reason),
        };
        if launch_pending || state.needs_drain_before_relaunch() {
            let attempt = QuitAttempt::new(true);
            *quit = attempt.state_for_launch(launch_pending);
            Some(attempt)
        } else {
            *quit = QuitState::Relaunching;
            None
        }
    };
    // Restart and quit effects can re-enter the run loop.
    if let Some(attempt) = drain {
        drain_then_restart(attempt);
    } else {
        request_restart();
    }
    Ok(())
}

#[tauri::command]
async fn desktop_relaunch(app: AppHandle) -> Result<(), String> {
    let state = app.state::<HostState>();
    let binary_available = tauri::process::current_binary(&app.env()).is_ok();
    let (completed, result) = std::sync::mpsc::channel();
    let mut deadline = None;
    relaunch_command(
        &state,
        binary_available,
        || app.request_restart(),
        |attempt| {
            deadline = Some(attempt.deadline);
            if start_quit(&app, &state, attempt.clone(), Some(completed.clone())).is_err() {
                finish_app_quit(&app, &state.quit, &attempt, Err(DrainFailure::StartFailed), Some(&completed));
            }
        },
    ).map_err(|reason| reason.message().to_string())?;
    let Some(deadline) = deadline else { return Ok(()); };
    drop(completed);
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        result.recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap_or(Err(DrainFailure::NoAnswer))
    }).await.map_err(|error| error.to_string())?;
    outcome.map_err(|reason| format!("The supervisor could not be drained ({reason:?})"))
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
        events_subscribe(
            &app.state::<HostState>(),
            &subscription,
            &path,
            last_event_id.as_deref(),
            channel,
            || wait_client(&app),
        )
    })
    .await
    .map_err(|_| "The desktop relay is unavailable".to_string())?
}

#[tauri::command]
async fn desktop_events_close(app: AppHandle, subscription: String) -> Result<(), String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        events_close(&app.state::<HostState>(), &subscription, || wait_client(&app))
    })
    .await
    .map_err(|_| "The desktop relay is unavailable".to_string())?
}

#[derive(Debug, Default, PartialEq, Eq)]
enum QuitState {
    #[default]
    Idle,
    Queued(Arc<QuitAttempt>),
    Waiting(Arc<QuitAttempt>),
    Failed(DrainFailure),
    Drained,
    Relaunching,
}

impl QuitState {
    fn in_progress(&self) -> bool {
        matches!(self, Self::Queued(_) | Self::Waiting(_))
    }
}

#[derive(Debug, PartialEq, Eq)]
struct QuitAttempt {
    deadline: Instant,
    restart: bool,
}

impl QuitAttempt {
    fn new(restart: bool) -> Arc<Self> {
        Arc::new(Self { deadline: Instant::now() + DRAIN_TIMEOUT, restart })
    }

    fn state_for_launch(self: &Arc<Self>, pending: bool) -> QuitState {
        if pending { QuitState::Queued(self.clone()) } else { QuitState::Waiting(self.clone()) }
    }
}

fn begin_quit(
    quit: &Mutex<QuitState>,
    cancel_recovery: impl FnOnce() -> bool,
    start: impl FnOnce(Arc<QuitAttempt>) -> std::io::Result<()>,
    on_start_failure: impl FnOnce(Arc<QuitAttempt>, DrainFailure),
) {
    let attempt = {
        let mut state = quit.lock().unwrap_or_else(PoisonError::into_inner);
        match *state {
            QuitState::Idle | QuitState::Failed(_) => {
                let attempt = QuitAttempt::new(false);
                *state = attempt.state_for_launch(cancel_recovery());
                attempt
            }
            QuitState::Queued(_) | QuitState::Waiting(_) | QuitState::Drained | QuitState::Relaunching => return,
        }
    };
    if start(attempt.clone()).is_err() {
        on_start_failure(attempt, DrainFailure::StartFailed);
    }
}

fn is_current_quit(state: &QuitState, attempt: &Arc<QuitAttempt>) -> bool {
    matches!(state, QuitState::Queued(current) | QuitState::Waiting(current) if Arc::ptr_eq(current, attempt))
}

fn current_quit<'a>(
    quit: &'a Mutex<QuitState>,
    attempt: &Arc<QuitAttempt>,
) -> Option<MutexGuard<'a, QuitState>> {
    let state = quit.lock().unwrap_or_else(PoisonError::into_inner);
    (matches!(*state, QuitState::Waiting(_))
        && is_current_quit(&state, attempt)
        && Instant::now() < attempt.deadline).then_some(state)
}

type QuitOutcome = Result<(), DrainFailure>;

fn run_quit_attempt(
    quit: &Mutex<QuitState>,
    attempt: &Arc<QuitAttempt>,
    connect: impl FnOnce() -> Result<Option<DrainConnection>, DrainFailure>,
    report: impl FnOnce(QuitOutcome),
) {
    let outcome = match connect() {
        // Nothing of ours to drain: the quit is confirmed without a supervisor.
        Ok(None) => Ok(()),
        Ok(Some(connection)) => connection.drain_if(|| current_quit(quit, attempt)),
        Err(reason) => Err(reason),
    };
    if current_quit(quit, attempt).is_some() {
        report(outcome);
    }
}

/// The quit's connect step, exactly as the spawned worker calls it. "Nothing
/// of ours to drain" is accepted only while no live supervisor connection is
/// stored: with a live connection the supervisor is still running even if the
/// socket file is gone (removed from outside, for example), so a None from
/// the path keeps today's NotConnected failure instead of an exit. A socket
/// path that was never stored (for example the data directory could not be
/// entered) has no supervisor of ours to drain either.
fn quit_connect(
    live_connection: bool,
    path: Option<&Path>,
) -> Result<Option<DrainConnection>, DrainFailure> {
    let connection = path.map_or(Ok(None), DrainConnection::connect)?;
    if connection.is_none() && live_connection {
        return Err(DrainFailure::NotConnected);
    }
    Ok(connection)
}

#[cfg(test)]
fn finish_quit(
    quit: &Mutex<QuitState>,
    attempt: &Arc<QuitAttempt>,
    outcome: QuitOutcome,
    exit: impl FnOnce(i32),
    report: impl FnOnce(Value),
    show: impl FnOnce(),
) {
    finish_quit_with(quit, attempt, outcome, |_| {}, exit, report, show);
}

fn finish_quit_with(
    quit: &Mutex<QuitState>,
    attempt: &Arc<QuitAttempt>,
    outcome: QuitOutcome,
    complete: impl FnOnce(QuitOutcome),
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
            *state = if attempt.restart { QuitState::Relaunching } else { QuitState::Drained };
            drop(state);
            complete(Ok(()));
            exit(0);
            return;
        }
        Err(reason) => reason,
    };
    *state = QuitState::Failed(reason);
    drop(state);
    complete(Err(reason));
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
        || state.cancel_recovery(),
        |attempt| start_quit(app, &state, attempt, None),
        |attempt, reason| finish_app_quit(app, &state.quit, &attempt, Err(reason), None),
    );
}

fn start_quit(
    app: &AppHandle,
    state: &HostState,
    attempt: Arc<QuitAttempt>,
    complete: Option<std::sync::mpsc::Sender<QuitOutcome>>,
) -> std::io::Result<()> {
    let live_connection = state.has_live_client();
    let timeout_app = app.clone();
    let timeout_quit = state.quit.clone();
    let timeout_attempt = attempt.clone();
    let timeout_complete = complete.clone();
    // The main queue expires the attempt even if the socket connect never returns.
    let remaining = attempt.deadline.saturating_duration_since(Instant::now());
    let timeout = move || {
        finish_app_quit(&timeout_app, &timeout_quit, &timeout_attempt, Err(DrainFailure::NoAnswer), timeout_complete.as_ref());
    };
    #[cfg(target_os = "macos")]
    {
        use dispatch2::{DispatchQueue, DispatchTime};
        use std::io::ErrorKind;
        let when = DispatchTime::try_from(remaining).map_err(|_| ErrorKind::InvalidInput)?;
        if when == DispatchTime::FOREVER {
            return Err(ErrorKind::InvalidInput.into());
        }
        DispatchQueue::main().after(when, timeout).map_err(|_| ErrorKind::InvalidInput)?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let app = app.clone();
        std::thread::Builder::new().spawn(move || {
            std::thread::sleep(remaining);
            if let Err(error) = app.run_on_main_thread(timeout) {
                eprintln!("{error}");
            }
        })?;
    }

    let app = app.clone();
    let quit = state.quit.clone();
    std::thread::Builder::new()
        .spawn(move || {
            let state = app.state::<HostState>();
            run_quit_attempt(
                &quit,
                &attempt,
                || state.quit_connect_after_recovery(&attempt, live_connection),
                |outcome| {
                    let handle = app.clone();
                    let quit = quit.clone();
                    let attempt = attempt.clone();
                    if let Err(error) = app.run_on_main_thread(move || {
                        finish_app_quit(&handle, &quit, &attempt, outcome, complete.as_ref());
                    }) {
                        let _ = writeln!(std::io::stderr(), "{error}");
                    }
                },
            );
        })
        .map(drop)
}

fn finish_app_quit(
    app: &AppHandle,
    quit: &Mutex<QuitState>,
    attempt: &Arc<QuitAttempt>,
    outcome: QuitOutcome,
    complete: Option<&std::sync::mpsc::Sender<QuitOutcome>>,
) {
    finish_quit_with(
        quit,
        attempt,
        outcome,
        |outcome| {
            if let Some(sender) = complete {
                let _ = sender.send(outcome);
            }
        },
        |code| {
            if attempt.restart {
                app.request_restart();
                return;
            }
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
            root_document::dispatch(
                ctx.app_handle().clone(),
                |app| app.state::<HostState>().inner(),
                request,
                CLIENT_WAIT,
                |work| { tauri::async_runtime::spawn_blocking(work); },
                |response| responder.respond(response),
                recovery::retry_initial_handoff,
            );
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
            let outcome = connect_or_start(&handle, false);
            let connected = outcome.as_ref().ok().cloned();
            record_connect_outcome(&app.state::<HostState>(), outcome);
            if let Some(client) = connected {
                watch_supervisor(&handle, client);
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
    let client = state.client.lock().unwrap().clone();
    if let Some(client) = client {
        let _ = client.send_event(&serde_json::json!({"event":"notification-clicked","key":key}).to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::{UnixListener, UnixStream};

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

    /// A private temporary directory per test, removed on drop and named
    /// uniquely, so parallel tests in this binary never share a log path.
    struct RefusalDir {
        path: PathBuf,
    }

    impl RefusalDir {
        fn new(tag: &str) -> Self {
            use std::os::unix::fs::DirBuilderExt;
            let path = std::env::temp_dir().join(format!("massion-refusal-{}-{tag}", std::process::id()));
            std::fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
            Self { path }
        }

        fn log(&self) -> PathBuf {
            self.path.join("daemon.log")
        }
    }

    impl Drop for RefusalDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn refusal_state(log: &Path) -> HostState {
        let state = HostState::default();
        *state.daemon_log.lock().unwrap() = Some(log.to_path_buf());
        state
    }

    /// Runs one refused start on a thread and waits with a bound, so a
    /// blocking open or write at the log path fails this helper instead of
    /// hanging the suite. The state comes back for the caller's assertions.
    fn record_refusal_bounded(log: &Path, refusal: StartRefusal) -> Arc<HostState> {
        let state = Arc::new(refusal_state(log));
        let worker = state.clone();
        let (sender, receiver) = std::sync::mpsc::channel::<()>();
        std::thread::spawn(move || {
            record_connect_outcome(&worker, Err(refusal));
            let _ = sender.send(());
        });
        receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("a refused start must not block on the log path");
        state
    }

    /// Creates a FIFO with the permissions a log file would get.
    fn make_fifo(path: &Path) {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let c_path = CString::new(path.as_os_str().as_bytes()).unwrap();
        let result = unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) };
        assert_eq!(result, 0, "the test FIFO must exist");
    }

    /// Records every write call that reaches it, so a line the writer
    /// receives in fragments fails the one-write assertion.
    struct CountingWriter {
        chunks: Vec<String>,
    }

    impl Write for CountingWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.chunks.push(String::from_utf8_lossy(buf).into_owned());
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// Pins the whole shape of the appended line: one top-level key, exactly
    /// the allowed keys inside, the document's closed reason code and the
    /// cause only when the document shows one. A path or a sentence added
    /// later fails here.
    fn assert_refusal_line(text: &str, expected_cause: Option<&str>) {
        let value: Value = serde_json::from_str(text).expect("one JSON object on one line");
        let object = value.as_object().expect("a JSON object");
        assert_eq!(object.len(), 1, "exactly one top-level key: {object:?}");
        let entry = object["hostStartRefused"].as_object().expect("the host entry");
        let mut keys: Vec<&str> = entry.keys().map(String::as_str).collect();
        keys.sort_unstable();
        let mut allowed = vec!["reason", "time"];
        if expected_cause.is_some() {
            allowed.push("cause");
        }
        allowed.sort_unstable();
        assert_eq!(keys, allowed, "nothing beyond time, reason and cause");
        assert_eq!(entry["reason"], "start-connection-unavailable");
        assert!(entry["time"].as_u64().is_some(), "a time in epoch milliseconds");
        assert_eq!(entry.get("cause").and_then(Value::as_str), expected_cause);
    }

    /// One line per refused start, appended once after existing content, with
    /// exactly the allowed keys. The table covers every StartRefusal variant
    /// that has a place to write.
    #[test]
    fn refused_start_appends_one_line_per_refusal_variant() {
        let cases = vec![
            (
                "cause",
                StartRefusal::SupervisorFailed(Some("database-start".to_string())),
                Some("database-start"),
            ),
            ("no-cause", StartRefusal::SupervisorFailed(None), None),
            (
                "other",
                StartRefusal::Other("A private daemon socket is required".to_string()),
                None,
            ),
        ];
        for (tag, refusal, expected_cause) in cases {
            let dir = RefusalDir::new(tag);
            let log = dir.log();
            std::fs::write(&log, "{\"hostSettings\":{\"revision\":1}}\n").unwrap();
            let state = refusal_state(&log);
            record_connect_outcome(&state, Err(refusal));
            let content = std::fs::read_to_string(&log).unwrap();
            let mut lines = content.lines();
            assert_eq!(
                lines.next(),
                Some("{\"hostSettings\":{\"revision\":1}}"),
                "existing content is kept"
            );
            let appended = lines.next().expect("exactly one appended line");
            assert_eq!(lines.next(), None, "the refusal is recorded once");
            assert_refusal_line(appended, expected_cause);
            assert!(state.client.lock().unwrap().is_none(), "no client for a refused start");
            assert_eq!(
                *state.start_failure_cause.lock().unwrap(),
                expected_cause.map(str::to_string)
            );
        }
    }

    /// A missing log is created with the same permissions the supervisor's
    /// own open gives the file (start_detached: 0600 at creation).
    #[test]
    fn refused_start_creates_a_missing_log_with_the_supervisors_permissions() {
        let dir = RefusalDir::new("create-missing");
        let log = dir.log();
        let state = refusal_state(&log);
        record_connect_outcome(
            &state,
            Err(StartRefusal::Other(
                "The supervisor did not answer status".to_string(),
            )),
        );
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&log).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_refusal_line(std::fs::read_to_string(&log).unwrap().trim_end(), None);
    }

    /// The whole line leaves as ONE write even at the cause bound (64
    /// bytes), so a line appended at the same moment by the supervisor or
    /// the core cannot land inside ours.
    #[test]
    fn the_whole_line_is_one_write_even_at_the_cause_bound() {
        let line = refusal_log_line(
            &StartRefusal::SupervisorFailed(Some("c".repeat(64))),
            1765536000000,
        )
        .unwrap();
        let mut writer = CountingWriter { chunks: Vec::new() };
        write_refusal_line(&mut writer, &line).unwrap();
        assert_eq!(writer.chunks.len(), 1, "one write for the whole line");
        let written = writer.chunks[0].as_str();
        assert_eq!(written.matches('\n').count(), 1, "exactly one newline");
        assert!(written.ends_with('\n'), "the newline is at the end");
        let value: Value = serde_json::from_str(written.trim_end()).unwrap();
        assert_eq!(value["hostStartRefused"]["cause"], "c".repeat(64));
    }

    /// A log that cannot be written (here: the path is a directory) changes
    /// nothing in the recorded outcome, and the directory is untouched.
    #[test]
    fn refused_start_with_an_unwritable_log_changes_nothing_in_the_outcome() {
        let dir = RefusalDir::new("unwritable");
        let log = dir.log();
        std::fs::create_dir(&log).unwrap();
        let state = record_refusal_bounded(
            &log,
            StartRefusal::SupervisorFailed(Some("core-start".to_string())),
        );
        assert_eq!(
            *state.start_failure_cause.lock().unwrap(),
            Some("core-start".to_string())
        );
        assert!(!state.data_directory_enter_failed.load(Ordering::SeqCst));
        assert!(state.client.lock().unwrap().is_none());
        assert_eq!(
            std::fs::read_dir(&log).unwrap().count(),
            0,
            "the directory at the log path is untouched"
        );
    }

    /// The host never writes through a symbolic link at the log path, unlike
    /// the supervisor's own stdio open.
    #[test]
    fn refused_start_never_writes_through_a_symbolic_link() {
        let dir = RefusalDir::new("symlink");
        let target = dir.path.join("elsewhere.log");
        std::fs::write(&target, "kept\n").unwrap();
        std::os::unix::fs::symlink(&target, dir.log()).unwrap();
        record_refusal_bounded(
            &dir.log(),
            StartRefusal::Other("The supervisor is not ready".to_string()),
        );
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "kept\n",
            "the target of the link is untouched"
        );
    }

    /// A FIFO at the log path with no reader must not block the refused
    /// start: the bound in the helper fails the test if the open ever waits.
    #[test]
    fn refused_start_with_a_fifo_at_the_log_path_never_blocks() {
        let dir = RefusalDir::new("fifo-no-reader");
        let log = dir.log();
        make_fifo(&log);
        record_refusal_bounded(
            &log,
            StartRefusal::Other("The supervisor is not ready".to_string()),
        );
        use std::os::unix::fs::FileTypeExt;
        assert!(
            std::fs::metadata(&log).unwrap().file_type().is_fifo(),
            "the FIFO is left as it was"
        );
    }

    /// A FIFO at the log path with a reader attached opens without blocking;
    /// only the opened descriptor's metadata keeps it unwritten.
    #[test]
    fn refused_start_with_a_read_fifo_at_the_log_path_writes_nothing() {
        let dir = RefusalDir::new("fifo-reader");
        let log = dir.log();
        make_fifo(&log);
        use std::io::Read;
        use std::os::unix::fs::OpenOptionsExt;
        let mut reader = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(&log)
            .unwrap();
        record_refusal_bounded(
            &log,
            StartRefusal::Other("The supervisor is not ready".to_string()),
        );
        let mut seen = [0u8; 128];
        match reader.read(&mut seen) {
            Ok(0) => {}
            Ok(count) => panic!("the FIFO received {count} bytes"),
            Err(error) => assert_eq!(
                error.kind(),
                std::io::ErrorKind::WouldBlock,
                "no byte may sit in the FIFO"
            ),
        }
    }

    /// The data directory could not be entered: there may be no place to
    /// write, so nothing is written and no file appears.
    #[test]
    fn refused_data_directory_enter_failed_writes_nothing() {
        let missing = RefusalDir::new("enter-failed-missing");
        let state = refusal_state(&missing.log());
        record_connect_outcome(&state, Err(StartRefusal::DataDirectoryEnterFailed));
        assert!(!missing.log().exists(), "no log file is created");
        assert!(state.data_directory_enter_failed.load(Ordering::SeqCst));

        let existing = RefusalDir::new("enter-failed-existing");
        std::fs::write(existing.log(), "kept\n").unwrap();
        let state = refusal_state(&existing.log());
        record_connect_outcome(&state, Err(StartRefusal::DataDirectoryEnterFailed));
        assert_eq!(
            std::fs::read_to_string(existing.log()).unwrap(),
            "kept\n",
            "an existing log is left exactly as it was"
        );
    }

    /// When the data directory itself was unavailable the host holds no log
    /// path: no line is written and the document shows no path.
    #[test]
    fn refused_start_without_a_log_path_writes_nothing() {
        let state = HostState::default();
        record_connect_outcome(
            &state,
            Err(StartRefusal::Other(
                "The desktop data directory is unavailable".to_string(),
            )),
        );
        assert!(state.daemon_log.lock().unwrap().is_none());
        assert!(state.client.lock().unwrap().is_none());
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

    /// One supervisor socket per test, with the handshake read and everything
    /// after it through ONE reader: a second reader on the same peer would
    /// consume bytes the first has not seen yet.
    struct CommandRelay {
        directory: PathBuf,
        _listener: UnixListener,
    }

    impl CommandRelay {
        fn new(name: &str) -> (Self, LineClient, BufReader<UnixStream>) {
            use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
            let directory = std::env::temp_dir().join(format!("massion-cmd-{}-{name}", std::process::id()));
            std::fs::DirBuilder::new().mode(0o700).create(&directory).unwrap();
            let socket = directory.join("daemon.sock");
            let listener = UnixListener::bind(&socket).unwrap();
            std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600)).unwrap();
            let client = LineClient::connect(&socket, |_| {}).unwrap();
            let (peer, _) = listener.accept().unwrap();
            peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut reader = BufReader::new(peer);
            let mut handshake = String::new();
            reader.read_line(&mut handshake).unwrap();
            assert_eq!(handshake, "client\n");
            (Self { directory, _listener: listener }, client, reader)
        }
    }

    impl Drop for CommandRelay {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }

    fn test_channel() -> tauri::ipc::Channel<serde_json::Value> {
        tauri::ipc::Channel::new(|_| Ok(()))
    }

    /// Proves the host wrote nothing after the peer's handshake: with a read
    /// timeout set, only a timeout (WouldBlock) is acceptable.
    fn assert_no_line(reader: &mut BufReader<UnixStream>) {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => panic!("the fixture peer closed unexpectedly"),
            Ok(_) => panic!("the host wrote a line after refusing: {line}"),
            Err(error) => assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock, "expected silence"),
        }
    }

    fn registered_subscriptions(ids: &[&str]) -> HostState {
        let state = HostState::default();
        for id in ids {
            state.subscriptions.lock().unwrap().insert((*id).to_string(), Subscription { channel: test_channel() });
        }
        state
    }

    /// The argument-bound table: a value at each bound passes, and one byte
    /// or one form step outside it fails. Every number comes from the relay
    /// or the id's creator, as the doc on the three checks spells out.
    #[test]
    fn command_bounds_table() {
        assert!(valid_subscription_id(&format!("sub-{}", "9".repeat(28))));
        assert!(!valid_subscription_id(&format!("sub-{}", "9".repeat(29))));
        assert!(!valid_subscription_id("sub-1x"));
        assert!(!valid_subscription_id("events-1"));
        assert!(valid_events_path("/protocol/events"));
        let at_path_bound = format!("/protocol/events?{}", "a".repeat(8175));
        assert_eq!(at_path_bound.len(), 8192);
        assert!(valid_events_path(&at_path_bound));
        assert!(!valid_events_path(&format!("/protocol/events?{}", "a".repeat(8176))));
        assert!(!valid_events_path("/protocol/eventsX"));
        assert!(!valid_events_path("/desktop/settings"));
        let at_header_bound = format!("[\"{}\",42]", "f".repeat(4089));
        assert_eq!(at_header_bound.len(), 4096);
        assert!(valid_last_event_id(&at_header_bound));
        assert!(!valid_last_event_id(&format!("[\"{}\",42]", "f".repeat(4090))));
        assert!(!valid_last_event_id("[\"only\"]"));
        assert!(!valid_last_event_id("[\"f\",\"1\"]"));
        assert!(!valid_last_event_id("[\"f\",-1]"));
        assert!(!valid_last_event_id("[\"f\",42,\"x\"]"));
        assert!(!valid_last_event_id("42"));
        assert!(!valid_last_event_id(""));
    }

    #[test]
    fn command_bounds_close_registered_id() {
        let (relay, client, mut reader) = CommandRelay::new("close-registered");
        let state = registered_subscriptions(&["sub-1"]);
        events_close(&state, "sub-1", || Some(client.clone())).unwrap();
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let seen: Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(seen, serde_json::json!({"event": "close", "subscription": "sub-1"}));
        assert!(!state.subscriptions.lock().unwrap().contains_key("sub-1"));
        drop(reader);
        drop(relay);
    }

    #[test]
    fn command_bounds_close_oversized_id() {
        let (relay, client, mut reader) = CommandRelay::new("close-oversized");
        let state = registered_subscriptions(&["sub-1"]);
        let oversized = format!("sub-{}", "9".repeat(5000));
        assert_eq!(
            events_close(&state, &oversized, || panic!("a refused id must not wait for the client")),
            Err("Refused desktop sender".to_string())
        );
        assert_no_line(&mut reader);
        assert!(state.subscriptions.lock().unwrap().contains_key("sub-1"), "no state change");
        assert!(!client.is_closed(), "the connection is still open");
        // The same connection still carries the next, legitimate close.
        events_close(&state, "sub-1", || Some(client.clone())).unwrap();
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert!(line.contains("\"subscription\":\"sub-1\""), "close arrived: {line}");
        drop(reader);
        drop(relay);
    }

    #[test]
    fn command_bounds_close_unknown_id_is_forwarded() {
        let (relay, client, mut reader) = CommandRelay::new("close-unknown");
        let state = registered_subscriptions(&["sub-1"]);
        // The host no longer knows sub-2 (a failed subscribe removes its
        // entry) while the relay can still hold it, so the close must reach
        // the relay regardless of the host's own map.
        events_close(&state, "sub-2", || Some(client.clone())).unwrap();
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let seen: Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(seen, serde_json::json!({"event": "close", "subscription": "sub-2"}));
        assert!(state.subscriptions.lock().unwrap().contains_key("sub-1"), "no state change for another id");
        drop(reader);
        drop(relay);
    }

    #[test]
    fn command_bounds_close_after_failed_subscribe_is_forwarded() {
        // The fixture name stays short: the socket path must fit the macOS
        // sun_path limit like every other CommandRelay test.
        let (relay, client, mut reader) = CommandRelay::new("close-failed-sub");
        let close_client = client.clone();
        let state = Arc::new(HostState::default());
        let thread_state = state.clone();
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let result = events_subscribe(
                &thread_state,
                "sub-7",
                "/protocol/events",
                None,
                test_channel(),
                || Some(client),
            );
            sender.send(result).unwrap();
        });
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let reply = serde_json::json!({"id": "sub-7", "error": "stalled"});
        writeln!(reader.get_mut(), "{}", reply).unwrap();
        reader.get_mut().flush().unwrap();
        assert_eq!(
            receiver.recv_timeout(Duration::from_secs(5)).unwrap(),
            Err("The feed refused the subscription".to_string())
        );
        assert!(state.subscriptions.lock().unwrap().is_empty(), "the host removed its entry for the failed subscribe");
        // The relay answered the error but kept its own subscription, so the
        // page's close for the now-unknown id must still reach the relay.
        events_close(&state, "sub-7", || Some(close_client)).unwrap();
        let mut close_line = String::new();
        reader.read_line(&mut close_line).unwrap();
        let seen: Value = serde_json::from_str(close_line.trim_end()).unwrap();
        assert_eq!(seen, serde_json::json!({"event": "close", "subscription": "sub-7"}));
        drop(reader);
        drop(relay);
    }

    #[test]
    fn command_bounds_send_close_writer_bound() {
        let (relay, client, mut reader) = CommandRelay::new("close-writer");
        // The writer bound mirrors the relay's 65536-byte line limit, so the
        // id must make the serialized close line exceed it.
        let oversized = format!("sub-{}", "9".repeat(65500));
        assert_eq!(client.send_close(&oversized), Err(CarrierError::Invalid));
        assert_no_line(&mut reader);
        assert_eq!(client.send_close("sub-1"), Ok(()));
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert!(line.contains("\"subscription\":\"sub-1\""), "close arrived: {line}");
        drop(reader);
        drop(relay);
    }

    #[test]
    fn command_bounds_subscribe_at_bounds() {
        let (relay, client, mut reader) = CommandRelay::new("subscribe-at-bounds");
        let state = Arc::new(HostState::default());
        let thread_state = state.clone();
        let subscription = format!("sub-{}", "9".repeat(28));
        // The worst case the bounds allow: every byte serde_json can expand,
        // expands. The query is 8,175 U+0001 bytes (each a six-byte \u0001
        // escape when serialized) and the last-event id is 4,090 raw tabs
        // plus its framing (each byte doubles), so the line read below is
        // the largest one these bounds can produce.
        let path = format!("/protocol/events?{}", "\u{1}".repeat(8175));
        let last_event_id = format!("[{}\"\",0]", "\t".repeat(4090));
        let expected_subscription = subscription.clone();
        let expected_path = path.clone();
        let expected_last_event_id = last_event_id.clone();
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let result = events_subscribe(
                &thread_state,
                &subscription,
                &path,
                Some(&last_event_id),
                test_channel(),
                || Some(client),
            );
            sender.send(result).unwrap();
        });
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        // 77 fixed envelope bytes + 32-byte id + 49,067-byte worst-case path
        // + 8,188-byte worst-case header + newline, as the doc comment on
        // the bounds derives; the comparison must fail if a bound grows.
        assert_eq!(line.len(), 57_365, "the worst-case line the bounds allow, newline included");
        assert!(line.len() <= massion_carrier::socket::MAX_REQUEST_LINE, "the worst case stays within the relay limit");
        let request: Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(request["id"], serde_json::json!(&expected_subscription));
        assert_eq!(request["path"], serde_json::json!(&expected_path));
        assert_eq!(request["headers"]["Last-Event-ID"], serde_json::json!(&expected_last_event_id));
        let reply = serde_json::json!({"id": expected_subscription, "status": 200, "headers": {}, "body": null});
        writeln!(reader.get_mut(), "{}", reply).unwrap();
        reader.get_mut().flush().unwrap();
        let result = receiver.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
        assert_eq!(result, expected_subscription);
        assert!(state.subscriptions.lock().unwrap().contains_key(&expected_subscription));
        drop(reader);
        drop(relay);
    }

    #[test]
    fn command_bounds_subscribe_over_bounds() {
        let (relay, client, mut reader) = CommandRelay::new("subscribe-over-bounds");
        let state = HostState::default();
        let refused = |subscription: &str, path: &str, last_event_id: Option<&str>| {
            assert_eq!(
                events_subscribe(&state, subscription, path, last_event_id, test_channel(), || {
                    panic!("a refused argument must not wait for the client")
                }),
                Err("Refused desktop sender".to_string())
            );
            assert!(state.subscriptions.lock().unwrap().is_empty(), "nothing stored");
        };
        refused(&format!("sub-{}", "9".repeat(29)), "/protocol/events", None);
        refused("sub-1", &format!("/protocol/events?{}", "a".repeat(8176)), None);
        refused("sub-1", "/protocol/events", Some(&format!("[\"{}\",42]", "f".repeat(4090))));
        refused("sub-1", "/protocol/eventsX", None);
        refused("sub-1", "/protocol/events", Some("not-an-id"));
        assert_no_line(&mut reader);
        assert!(!client.is_closed(), "the connection is still open");
        // The same connection still accepts a subscribe at every bound.
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let result = events_subscribe(
                &state,
                "sub-1",
                &format!("/protocol/events?{}", "a".repeat(8175)),
                Some(&format!("[\"{}\",42]", "f".repeat(4089))),
                test_channel(),
                || Some(client),
            );
            sender.send(result).unwrap();
        });
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let reply = serde_json::json!({"id": "sub-1", "status": 200, "headers": {}, "body": null});
        writeln!(reader.get_mut(), "{}", reply).unwrap();
        reader.get_mut().flush().unwrap();
        receiver.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
        drop(reader);
        drop(relay);
    }
}

#[cfg(test)]
mod quit_tests;

#[cfg(test)]
mod cannot_start_tests;
