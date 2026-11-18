use super::*;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::AtomicU64;

static NEXT_TEST_ID: AtomicU64 = AtomicU64::new(0);

struct TestDir {
    path: PathBuf,
}

impl TestDir {
    fn new(tag: &str) -> Self {
        use std::os::unix::fs::DirBuilderExt;
        let id = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
        let dir_name = if tag.is_empty() {
            format!("mcs-{}-{id}", std::process::id())
        } else {
            format!("mcs-{}-{id}-{tag}", std::process::id())
        };
        let path = std::env::temp_dir().join(dir_name);
        std::fs::DirBuilder::new().mode(0o700).create(&path).unwrap();
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

struct MockRelay {
    _dir: TestDir,
    socket: PathBuf,
    listener: UnixListener,
}

impl MockRelay {
    fn new() -> Self {
        use std::os::unix::fs::PermissionsExt;
        let dir = TestDir::new("");
        let socket = dir.path().join("d.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600)).unwrap();
        Self {
            _dir: dir,
            socket,
            listener,
        }
    }

    fn connect_client(&self) -> (LineClient, UnixStream) {
        let client = LineClient::connect(&self.socket, |_| {}).unwrap();
        let (peer, _) = self.listener.accept().unwrap();
        let mut reader = BufReader::new(peer.try_clone().unwrap());
        let mut kind = String::new();
        reader.read_line(&mut kind).unwrap();
        assert_eq!(kind, "client\n");
        (client, peer)
    }

    fn read_request(reader: &mut BufReader<UnixStream>) -> Value {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        serde_json::from_str(line.trim_end()).unwrap()
    }

    fn write_reply(
        peer: &mut UnixStream,
        id: &str,
        status: u16,
        headers: Value,
        body: Option<&str>,
    ) {
        let payload = serde_json::json!({
            "id": id,
            "status": status,
            "headers": headers,
            "body": body,
        });
        writeln!(peer, "{}", payload).unwrap();
        peer.flush().unwrap();
    }

    fn write_error(peer: &mut UnixStream, id: &str, code: &str) {
        let payload = serde_json::json!({
            "id": id,
            "error": { "code": code, "message": "failed" }
        });
        writeln!(peer, "{}", payload).unwrap();
        peer.flush().unwrap();
    }
}

fn get_request(url: &str) -> http::Request<Vec<u8>> {
    http::Request::builder()
        .method("GET")
        .uri(url)
        .body(Vec::new())
        .unwrap()
}

fn post_request(url: &str, body: &str) -> http::Request<Vec<u8>> {
    http::Request::builder()
        .method("POST")
        .uri(url)
        .body(body.as_bytes().to_vec())
        .unwrap()
}

fn assert_empty_503(response: &http::Response<Vec<u8>>) {
    assert_eq!(response.status(), 503);
    assert!(response.body().is_empty(), "expected empty 503 body");
    assert!(
        response.headers().get("Content-Type").is_none(),
        "empty 503 must not carry a document Content-Type"
    );
}

fn assert_cannot_start_response(
    response: &http::Response<Vec<u8>>,
    expected_code: &str,
    expected_log_escaped: Option<&str>,
) {
    assert_eq!(response.status(), 503);
    assert_eq!(
        response
            .headers()
            .get("Content-Type")
            .and_then(|v| v.to_str().ok()),
        Some("text/html; charset=utf-8")
    );
    assert_eq!(
        response
            .headers()
            .get("Cache-Control")
            .and_then(|v| v.to_str().ok()),
        Some("no-store")
    );
    assert_eq!(
        response
            .headers()
            .get("X-Content-Type-Options")
            .and_then(|v| v.to_str().ok()),
        Some("nosniff")
    );
    assert_eq!(
        response
            .headers()
            .get("Content-Security-Policy")
            .and_then(|v| v.to_str().ok()),
        Some(cannot_start::CONTENT_SECURITY_POLICY)
    );
    let body = String::from_utf8(response.body().clone()).unwrap();
    assert!(body.contains(cannot_start::TITLE), "missing title");
    assert!(body.contains(cannot_start::MESSAGE), "missing message");
    assert!(
        body.contains(cannot_start::DETAILS_LABEL),
        "missing details label"
    );
    assert!(
        body.contains(cannot_start::COPY_LABEL),
        "missing copy label"
    );
    assert!(
        body.contains(expected_code),
        "missing reason code {expected_code}"
    );
    assert!(!body.contains("다시 시도"));
    assert!(!body.contains("문제 신고"));
    assert!(!body.contains("http://"));
    assert!(!body.contains("https://"));
    match expected_log_escaped {
        Some(path) => assert!(body.contains(path), "missing log path {path}"),
        None => assert!(
            !body.contains("daemon.log"),
            "unexpected daemon.log path when file does not exist"
        ),
    }
}

fn wait_until_closed(client: &LineClient) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !client.is_closed() {
        assert!(
            Instant::now() < deadline,
            "client did not observe peer close"
        );
        std::thread::yield_now();
    }
}

#[test]
fn decide_root_failure_table_covers_every_combination() {
    let mut rows = 0usize;
    for is_root_app_get in [false, true] {
        for quit_in_progress in [false, true] {
            for failure in [
                SchemeFailure::NoClient,
                SchemeFailure::ClientClosed,
                SchemeFailure::Other,
            ] {
                for data_directory_enter_failed in [false, true] {
                    rows += 1;
                    let actual = decide_root_failure(
                        is_root_app_get,
                        quit_in_progress,
                        failure,
                        data_directory_enter_failed,
                    );
                    let expected = if !is_root_app_get || quit_in_progress {
                        RootFailureAction::Empty503
                    } else {
                        match failure {
                            SchemeFailure::NoClient => RootFailureAction::CannotStart(
                                if data_directory_enter_failed {
                                    CannotStartReason::DataDirectoryEnterFailed
                                } else {
                                    CannotStartReason::ConnectionUnavailable
                                },
                            ),
                            SchemeFailure::ClientClosed => {
                                RootFailureAction::CannotStart(CannotStartReason::ConnectionClosed)
                            }
                            SchemeFailure::Other => RootFailureAction::Empty503,
                        }
                    };
                    assert_eq!(
                        actual, expected,
                        "mismatch for ({is_root_app_get}, {quit_in_progress}, {failure:?}, {data_directory_enter_failed})"
                    );
                }
            }
        }
    }
    assert_eq!(rows, 24);
}

#[test]
fn no_stored_connection_serves_cannot_start_with_unavailable_code() {
    let state = HostState::default();
    for url in ["massion://app/", "massion://localhost/"] {
        let started = Instant::now();
        let response = scheme_response_for_state(&state, "massion", get_request(url), CLIENT_WAIT);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "cannot-start path must not wait 30 seconds"
        );
        assert_cannot_start_response(&response, "start-connection-unavailable", None);
    }
}

#[test]
fn already_closed_connection_serves_cannot_start_at_once() {
    let relay = MockRelay::new();
    let (client, peer) = relay.connect_client();
    drop(peer);
    wait_until_closed(&client);

    let state = HostState::default();
    *state.client.lock().unwrap() = Some(client);

    let started = Instant::now();
    let response = scheme_response_for_state(
        &state,
        "massion",
        get_request("massion://app/"),
        CLIENT_WAIT,
    );
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "already-closed root GET must not poll for 30 seconds"
    );
    assert_cannot_start_response(&response, "start-connection-closed", None);
}

#[test]
fn closed_while_pending_serves_cannot_start() {
    let relay = MockRelay::new();
    let (client, peer) = relay.connect_client();
    let server = std::thread::spawn(move || {
        let mut reader = BufReader::new(peer);
        let request = MockRelay::read_request(&mut reader);
        assert_eq!(request["path"], "/");
        // 회신 없이 소켓을 닫아 대기 중인 요청이 Closed를 받게 한다.
    });

    let state = HostState::default();
    *state.client.lock().unwrap() = Some(client);

    let response = scheme_response_for_state(
        &state,
        "massion",
        get_request("massion://app/"),
        CLIENT_WAIT,
    );
    server.join().unwrap();
    assert_cannot_start_response(&response, "start-connection-closed", None);
}

#[test]
fn closed_connection_after_normal_document_serves_cannot_start() {
    let relay = MockRelay::new();
    let (client, peer) = relay.connect_client();
    let server = std::thread::spawn(move || {
        let mut reader = BufReader::new(peer.try_clone().unwrap());
        let mut writer = peer;
        let first = MockRelay::read_request(&mut reader);
        assert_eq!(first["path"], "/");
        MockRelay::write_reply(
            &mut writer,
            first["id"].as_str().unwrap(),
            200,
            serde_json::json!({"Content-Type": "text/html; charset=utf-8"}),
            Some("<!doctype html><html><body>app</body></html>"),
        );
        let second = MockRelay::read_request(&mut reader);
        assert_eq!(second["path"], "/");
        // 두 번째 요청 도중 연결을 닫아 정상 문서 인도 뒤의 단절을 재현한다.
    });

    let state = HostState::default();
    *state.client.lock().unwrap() = Some(client);

    // 정상 문서를 한 번 넘긴 뒤에도 판정은 상태 없이 조건만 본다(수용된 한계).
    let first = scheme_response_for_state(
        &state,
        "massion",
        get_request("massion://app/"),
        CLIENT_WAIT,
    );
    assert_eq!(first.status(), 200);

    let second = scheme_response_for_state(
        &state,
        "massion",
        get_request("massion://app/"),
        Duration::from_millis(1),
    );
    server.join().unwrap();
    assert_cannot_start_response(&second, "start-connection-closed", None);

    let third = scheme_response_for_state(
        &state,
        "massion",
        get_request("massion://app/"),
        Duration::from_millis(1),
    );
    assert_cannot_start_response(&third, "start-connection-closed", None);
}

#[test]
fn non_root_api_and_published_document_requests_stay_empty_503() {
    let state = HostState::default();
    let doc_url = format!("massion-app://document/{}", "a".repeat(64));
    for (scheme, request) in [
        ("massion", get_request("massion://app/other")),
        ("massion", get_request("massion://app/?q=1")),
        ("massion", post_request("massion://app/", "")),
        ("massion", post_request("massion://app/protocol/connect", "{}")),
        ("massion", get_request("massion://app/desktop/settings")),
        ("massion-app", get_request(&doc_url)),
    ] {
        let response = scheme_response_for_state(&state, scheme, request, Duration::from_millis(1));
        assert_empty_503(&response);
    }
}

#[test]
fn relay_503_status_and_carrier_invalid_stay_as_today() {
    let relay = MockRelay::new();
    let (client, peer) = relay.connect_client();
    let server = std::thread::spawn(move || {
        let mut reader = BufReader::new(peer.try_clone().unwrap());
        let mut writer = peer;
        let first = MockRelay::read_request(&mut reader);
        MockRelay::write_reply(
            &mut writer,
            first["id"].as_str().unwrap(),
            503,
            serde_json::json!({"Content-Type": "text/plain"}),
            Some("relay busy"),
        );
        let second = MockRelay::read_request(&mut reader);
        MockRelay::write_error(&mut writer, second["id"].as_str().unwrap(), "upstream");
    });

    let state = HostState::default();
    *state.client.lock().unwrap() = Some(client);

    let relay_503 =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert_eq!(relay_503.status(), 503);
    assert_eq!(relay_503.body(), b"relay busy");

    let invalid =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert_empty_503(&invalid);

    server.join().unwrap();
}

#[test]
fn quit_in_progress_keeps_empty_503_and_failed_quit_serves_cannot_start() {
    let relay = MockRelay::new();
    let (client, peer) = relay.connect_client();
    let server = std::thread::spawn(move || {
        let mut reader = BufReader::new(peer);
        let req = MockRelay::read_request(&mut reader);
        assert_eq!(req["path"], "/");
        // 종료 시도가 진행 중일 때 요청 도중 연결을 닫아도 빈 503이어야 한다.
    });

    let state = HostState::default();
    *state.client.lock().unwrap() = Some(client.clone());
    let attempt = Arc::new(QuitAttempt {
        deadline: Instant::now() + DRAIN_TIMEOUT,
    });
    *state.quit.lock().unwrap() = QuitState::Waiting(attempt);

    let during_quit =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    server.join().unwrap();
    assert_empty_503(&during_quit);

    let no_client_state = HostState::default();
    let attempt2 = Arc::new(QuitAttempt {
        deadline: Instant::now() + DRAIN_TIMEOUT,
    });
    *no_client_state.quit.lock().unwrap() = QuitState::Waiting(attempt2);
    let during_quit_no_client = scheme_response_for_state(
        &no_client_state,
        "massion",
        get_request("massion://app/"),
        Duration::from_millis(1),
    );
    assert_empty_503(&during_quit_no_client);

    wait_until_closed(&client);
    *state.quit.lock().unwrap() = QuitState::Failed(DrainFailure::NoAnswer);
    let after_failed_quit =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert_cannot_start_response(&after_failed_quit, "start-connection-closed", None);
}

#[test]
fn data_directory_refusal_serves_cannot_start_with_its_code() {
    let state = HostState::default();
    state
        .data_directory_enter_failed
        .store(true, Ordering::SeqCst);

    let response =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert_cannot_start_response(&response, "data-directory-enter-failed", None);
}

#[test]
fn daemon_log_path_is_shown_only_when_file_exists_and_is_html_escaped() {
    let dir = TestDir::new("log-&<\"'>");
    let log = dir.path().join("daemon.log");
    let state = HostState::default();
    *state.daemon_log.lock().unwrap() = Some(log.clone());

    let missing =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert_cannot_start_response(&missing, "start-connection-unavailable", None);

    std::fs::write(&log, "boom\n").unwrap();
    let present =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    let escaped = log
        .to_string_lossy()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;");
    assert_cannot_start_response(
        &present,
        "start-connection-unavailable",
        Some(escaped.as_str()),
    );

    std::fs::remove_file(&log).unwrap();
    let removed =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert_cannot_start_response(&removed, "start-connection-unavailable", None);
}

#[test]
fn cannot_start_document_matches_copy_table() {
    let table: Value =
        serde_json::from_str(include_str!("../../../docs/product/screens/copy.ko.json")).unwrap();
    assert_eq!(
        table["ui.desktop.cannot-start.title"]["ko"].as_str(),
        Some(cannot_start::TITLE)
    );
    assert_eq!(
        table["ui.desktop.cannot-start.message"]["ko"].as_str(),
        Some(cannot_start::MESSAGE)
    );
    assert_eq!(
        table["ui.desktop.cannot-start.details"]["ko"].as_str(),
        Some(cannot_start::DETAILS_LABEL)
    );
    assert_eq!(
        table["conversation.button.10"]["ko"].as_str(),
        Some(cannot_start::COPY_LABEL)
    );

    let html = cannot_start::render_html(CannotStartReason::ConnectionUnavailable, None);
    let title = table["ui.desktop.cannot-start.title"]["ko"].as_str().unwrap();
    let message = table["ui.desktop.cannot-start.message"]["ko"]
        .as_str()
        .unwrap();
    let details = table["ui.desktop.cannot-start.details"]["ko"]
        .as_str()
        .unwrap();
    let copy = table["conversation.button.10"]["ko"].as_str().unwrap();
    for expected in [
        format!("<title>{title}</title>"),
        format!("<h1>{title}</h1>"),
        format!("<p class=\"message\">{message}</p>"),
        format!("<summary>{details}</summary>"),
        format!("<button id=\"copy-details\" type=\"button\" class=\"copy-button\">{copy}</button>"),
    ] {
        assert!(html.contains(&expected), "document missing exact element {expected}");
    }
}

struct GateSlot {
    arrived: (Mutex<bool>, std::sync::Condvar),
    released: (Mutex<bool>, std::sync::Condvar),
    response: Mutex<Option<http::Response<Vec<u8>>>>,
}

impl GateSlot {
    fn new() -> Self {
        Self {
            arrived: (Mutex::new(false), std::sync::Condvar::new()),
            released: (Mutex::new(false), std::sync::Condvar::new()),
            response: Mutex::new(None),
        }
    }

    fn pause_before_handover(&self) {
        {
            let (lock, cv) = &self.arrived;
            *lock.lock().unwrap() = true;
            cv.notify_all();
        }
        let (lock, cv) = &self.released;
        let mut released = lock.lock().unwrap();
        while !*released {
            released = cv.wait(released).unwrap();
        }
    }

    fn wait_arrived(&self) {
        let (lock, cv) = &self.arrived;
        let mut arrived = lock.lock().unwrap();
        while !*arrived {
            arrived = cv.wait(arrived).unwrap();
        }
    }

    fn release(&self) {
        let (lock, cv) = &self.released;
        *lock.lock().unwrap() = true;
        cv.notify_all();
    }

    fn respond(&self, response: http::Response<Vec<u8>>) {
        *self.response.lock().unwrap() = Some(response);
    }

    fn take(&self) -> http::Response<Vec<u8>> {
        self.response
            .lock()
            .unwrap()
            .take()
            .expect("responder slot must have received a response")
    }
}

struct ReleaseOnDrop<'a>(&'a GateSlot);

impl Drop for ReleaseOnDrop<'_> {
    fn drop(&mut self) {
        self.0.release();
    }
}

#[test]
fn blocked_responder_does_not_wait_on_the_quit_lock() {
    // 저장된 연결 없음: 즉시 시작 실패 문서가 나오는 경로로 응답기를 막는다.
    let state = HostState::default();
    let gate = GateSlot::new();

    std::thread::scope(|scope| {
        let _release_all = ReleaseOnDrop(&gate);
        let handle = scope.spawn(|| {
            respond_scheme_response(
                &state,
                "massion",
                get_request("massion://app/"),
                CLIENT_WAIT,
                |response| {
                    gate.pause_before_handover();
                    gate.respond(response);
                },
            );
        });

        // 응답기 안에 들어왔다는 신호: 이 시점에 종료 잠금을 잡아도 인도 경로가
        // 그 잠금을 기다리거나 쥐고 있어서는 안 된다.
        gate.wait_arrived();
        let quit_guard = state
            .quit
            .try_lock()
            .expect("respond must not be called while the quit lock is held");
        gate.release();
        handle
            .join()
            .unwrap_or_else(|_| panic!("hand-over must not wait on the quit lock"));
        drop(quit_guard);
        assert_cannot_start_response(&gate.take(), "start-connection-unavailable", None);
    });
}

#[test]
fn app_host_with_port_userinfo_or_other_scheme_never_serves_cannot_start() {
    let doc_path = format!("/{}", "a".repeat(64));
    let doc_url = format!("massion-app://localhost{doc_path}");
    let no_client = HostState::default();
    for (scheme, url) in [
        ("massion", "massion://app:8080/"),
        ("massion", "massion://localhost:3000/"),
        ("massion", "massion://user@app/"),
        ("massion", "massion://user@localhost/"),
        ("massion", "http://app/"),
        ("massion-app", doc_url.as_str()),
    ] {
        let response =
            scheme_response_for_state(&no_client, scheme, get_request(url), Duration::from_millis(1));
        assert_empty_503(&response);
    }

    let relay = MockRelay::new();
    let (client, peer) = relay.connect_client();
    let server = std::thread::spawn(move || {
        let mut reader = BufReader::new(peer.try_clone().unwrap());
        let mut writer = peer;
        for expected_path in ["/", "/", "/", doc_path.as_str()] {
            let req = MockRelay::read_request(&mut reader);
            assert_eq!(req["path"], expected_path);
            MockRelay::write_reply(
                &mut writer,
                req["id"].as_str().unwrap(),
                200,
                serde_json::json!({"Content-Type": "text/html; charset=utf-8"}),
                Some("<!doctype html><html><body>app</body></html>"),
            );
        }
    });

    let state = HostState::default();
    *state.client.lock().unwrap() = Some(client.clone());
    for (scheme, url) in [
        ("massion", "massion://app:8080/"),
        ("massion", "massion://user@app/"),
        ("massion", "http://app/"),
        ("massion-app", doc_url.as_str()),
    ] {
        let response =
            scheme_response_for_state(&state, scheme, get_request(url), CLIENT_WAIT);
        assert_eq!(response.status(), 200);
    }

    server.join().unwrap();
    wait_until_closed(&client);
    for (scheme, url) in [
        ("massion", "massion://app:8080/"),
        ("massion", "massion://user@app/"),
        ("massion", "http://app/"),
    ] {
        let response =
            scheme_response_for_state(&state, scheme, get_request(url), Duration::from_millis(1));
        assert_empty_503(&response);
    }
    let real_root =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert_cannot_start_response(&real_root, "start-connection-closed", None);
}

#[test]
fn oversized_and_non_utf8_replies_stay_empty_503_not_cannot_start() {
    let relay_over = MockRelay::new();
    let (client_over, peer_over) = relay_over.connect_client();
    let server_over = std::thread::spawn(move || {
        let mut reader = BufReader::new(peer_over.try_clone().unwrap());
        let mut writer = peer_over;
        let _ = MockRelay::read_request(&mut reader);
        let chunk = vec![b'x'; 1024 * 1024];
        for _ in 0..5 {
            let _ = writer.write_all(&chunk);
        }
        let _ = writer.flush();
    });

    let state_over = HostState::default();
    *state_over.client.lock().unwrap() = Some(client_over);
    let over_response =
        scheme_response_for_state(&state_over, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert_empty_503(&over_response);
    assert!(
        state_over
            .client
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .is_closed(),
        "oversized reply must tear down the damaged connection"
    );
    drop(state_over);
    server_over.join().unwrap();

    let relay_utf8 = MockRelay::new();
    let (client_utf8, peer_utf8) = relay_utf8.connect_client();
    let server_utf8 = std::thread::spawn(move || {
        let mut reader = BufReader::new(peer_utf8.try_clone().unwrap());
        let mut writer = peer_utf8;
        let _ = MockRelay::read_request(&mut reader);
        writer.write_all(b"{\"id\":\"c-0\",\"body\":\"\xff\"}\n").unwrap();
        writer.flush().unwrap();
    });

    let state_utf8 = HostState::default();
    *state_utf8.client.lock().unwrap() = Some(client_utf8);
    let utf8_response =
        scheme_response_for_state(&state_utf8, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert_empty_503(&utf8_response);
    server_utf8.join().unwrap();
}

#[test]
fn non_fast_path_validation_keeps_main_wait_order_and_statuses() {
    let wait = Duration::from_millis(120);
    let non_utf8 = || {
        http::Request::builder()
            .method("GET")
            .uri("massion://app/")
            .body(vec![0xff])
            .unwrap()
    };

    let no_client = HostState::default();
    for (scheme, request) in [
        ("massion", get_request("massion://evil/")),
        ("massion-app", get_request("massion-app://document/short")),
        ("massion", non_utf8()),
    ] {
        let started = Instant::now();
        let response = scheme_response_for_state(&no_client, scheme, request, wait);
        assert!(
            started.elapsed() >= wait,
            "non-fast-path request without client must enter wait_client_in_state"
        );
        assert_empty_503(&response);
    }

    let closed_relay = MockRelay::new();
    let (closed_client, closed_peer) = closed_relay.connect_client();
    drop(closed_peer);
    wait_until_closed(&closed_client);
    let closed_state = HostState::default();
    *closed_state.client.lock().unwrap() = Some(closed_client);
    for (scheme, request) in [
        ("massion", get_request("massion://evil/")),
        ("massion-app", get_request("massion-app://document/short")),
        ("massion", non_utf8()),
    ] {
        let started = Instant::now();
        let response = scheme_response_for_state(&closed_state, scheme, request, wait);
        assert!(
            started.elapsed() >= wait,
            "non-fast-path request with closed client must enter wait_client_in_state"
        );
        assert_empty_503(&response);
    }

    // 빠른 경로는 여전히 즉시 자체 문서를 반환한다.
    let fast_started = Instant::now();
    let fast_response =
        scheme_response_for_state(&closed_state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert!(fast_started.elapsed() < Duration::from_secs(2));
    assert_cannot_start_response(&fast_response, "start-connection-closed", None);

    // 열린 연결이 있으면 main과 똑같이 404/404/400을 반환한다.
    let open_relay = MockRelay::new();
    let (open_client, _open_peer) = open_relay.connect_client();
    let open_state = HostState::default();
    *open_state.client.lock().unwrap() = Some(open_client);
    assert_eq!(
        scheme_response_for_state(&open_state, "massion", get_request("massion://evil/"), CLIENT_WAIT)
            .status(),
        404
    );
    assert_eq!(
        scheme_response_for_state(
            &open_state,
            "massion-app",
            get_request("massion-app://document/short"),
            CLIENT_WAIT
        )
        .status(),
        404
    );
    assert_eq!(
        scheme_response_for_state(&open_state, "massion", non_utf8(), CLIENT_WAIT).status(),
        400
    );
}
