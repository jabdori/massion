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
fn relay_replies_pass_through_except_refused_header_stays_empty_503() {
    let relay = MockRelay::new();
    let (client, peer) = relay.connect_client();
    let server = std::thread::spawn(move || {
        let mut reader = BufReader::new(peer.try_clone().unwrap());
        let mut writer = peer;
        for (expected_path, status, headers, body) in [
            ("/", 503u16, serde_json::json!({"Content-Type": "text/plain"}), Some("relay busy")),
            ("/?q=1", 200, serde_json::json!({"Content-Type": "text/html"}), Some("body")),
            ("/", 500, serde_json::json!({"Content-Type": "text/plain"}), Some("body")),
            ("/", 404, serde_json::json!({"Content-Type": "text/plain"}), Some("body")),
            ("/", 302, serde_json::json!({"Location": "/other"}), Some("body")),
            ("/", 200, serde_json::json!({"X-Bad": "bad\nheader"}), Some("body")),
            ("/", 200, serde_json::json!({"Content-Type": "text/html; charset=utf-8"}), None),
            ("/", 200, serde_json::json!({"Content-Type": "text/html; charset=utf-8"}), Some("")),
            ("/", 201, serde_json::json!({"Content-Type": "text/html; charset=utf-8"}), Some("<!doctype html>")),
        ] {
            let req = MockRelay::read_request(&mut reader);
            assert_eq!(req["path"], expected_path);
            MockRelay::write_reply(&mut writer, req["id"].as_str().unwrap(), status, headers, body);
        }
        let last = MockRelay::read_request(&mut reader);
        MockRelay::write_error(&mut writer, last["id"].as_str().unwrap(), "upstream");
    });

    let state = HostState::default();
    *state.client.lock().unwrap() = Some(client);

    let relay_503 =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert_eq!(relay_503.status(), 503);
    assert_eq!(relay_503.body(), b"relay busy");

    // 쿼리가 붙은 경로는 그대로 중계로 전달되고 상태는 되돌아온다.
    assert_eq!(
        scheme_response_for_state(&state, "massion", get_request("massion://app/?q=1"), CLIENT_WAIT)
            .status(),
        200
    );
    for expected_status in [500u16, 404, 302] {
        assert_eq!(
            scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT)
                .status(),
            expected_status
        );
    }
    // 줄바꿈이 든 문자열 헤더는 HTTP 응답 생성 단계에서 거절돼 빈 503이 된다.
    let refused_header =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert_empty_503(&refused_header);
    // 본문이 없거나 빈 유효한 200과 201은 상태 그대로 전달된다.
    for expected_status in [200u16, 200, 201] {
        assert_eq!(
            scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT)
                .status(),
            expected_status
        );
    }

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
    // The product shuts the socket down when the reader thread ends, so the
    // server's blocked write returns while the host state still owns the
    // connection (no drop in the test).
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

fn read_control_line(peer: &mut UnixStream) -> String {
    peer.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(peer, &mut bytes).unwrap();
    String::from_utf8(bytes).unwrap()
}

fn bind_private_socket(dir: &Path) -> (PathBuf, UnixListener) {
    use std::os::unix::fs::PermissionsExt;
    let socket = dir.join(DAEMON_SOCKET_NAME);
    let listener = UnixListener::bind(&socket).unwrap();
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600)).unwrap();
    (socket, listener)
}

fn read_client_handshake(peer: &mut UnixStream) {
    peer.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut reader = BufReader::new(peer);
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    assert_eq!(line, "client\n");
}

#[test]
fn decide_status_table_covers_every_combination() {
    let mut rows = 0usize;
    for origin in [
        Some(DEFAULT_DAEMON_ORIGIN),
        Some("http://127.0.0.1:9999"),
        None,
    ] {
        for status in ["running", "starting", "failed", "drained", "unknown"] {
            for draining in [false, true] {
                for cause in [None, Some("database-start"), Some("bad\ncause")] {
                    rows += 1;
                    let reply = StatusReply {
                        status: status.to_string(),
                        pid: Some(1),
                        origin: origin.map(str::to_string),
                        draining,
                        cause: cause.map(str::to_string),
                        detail: None,
                    };
                    let actual = decide_status(&reply, DEFAULT_DAEMON_ORIGIN);
                    let expected = if origin != Some(DEFAULT_DAEMON_ORIGIN) {
                        StatusDecision::Refuse(None)
                    } else {
                        match status {
                            "failed" => StatusDecision::Refuse(match cause {
                                Some("database-start") => Some("database-start".to_string()),
                                _ => None,
                            }),
                            "running" | "starting" if draining => StatusDecision::RetryDraining,
                            "starting" => StatusDecision::RetryStarting,
                            "running" => StatusDecision::Attach,
                            _ => StatusDecision::Refuse(None),
                        }
                    };
                    assert_eq!(
                        actual, expected,
                        "mismatch for ({origin:?}, {status}, {draining}, {cause:?})"
                    );
                }
            }
        }
    }
    assert_eq!(rows, 90);
    assert_eq!(expected_daemon_origin_from(None), DEFAULT_DAEMON_ORIGIN);
    assert_eq!(
        expected_daemon_origin_from(Some("http://127.0.0.1:9000/")),
        "http://127.0.0.1:9000"
    );
}

#[test]
fn status_running_with_missing_draining_field_attaches_and_serves() {
    let dir = TestDir::new("status-running");
    let (_socket, listener) = bind_private_socket(dir.path());
    let server = std::thread::spawn(move || {
        let (mut status_peer, _) = listener.accept().unwrap();
        assert_eq!(read_control_line(&mut status_peer), "status\n");
        // Older supervisor: no "draining" field in the JSON object.
        writeln!(
            status_peer,
            "{}",
            serde_json::json!({
                "status": "running",
                "pid": 100,
                "origin": DEFAULT_DAEMON_ORIGIN,
            })
        )
        .unwrap();
        drop(status_peer);

        let (mut relay_peer, _) = listener.accept().unwrap();
        read_client_handshake(&mut relay_peer);
        let mut reader = BufReader::new(relay_peer.try_clone().unwrap());
        let req = MockRelay::read_request(&mut reader);
        assert_eq!(req["path"], "/");
        MockRelay::write_reply(
            &mut relay_peer,
            req["id"].as_str().unwrap(),
            200,
            serde_json::json!({"Content-Type": "text/html; charset=utf-8"}),
            Some("<!doctype html><html><body>ok</body></html>"),
        );
    });

    let state = HostState::default();
    let outcome = connect_supervisor_within(
        dir.path(),
        false,
        DEFAULT_DAEMON_ORIGIN,
        START_WAIT,
        &state.supervisor_socket,
        |_| panic!("running supervisor must not launch a second one"),
        |_| {},
    );
    record_connect_outcome(&state, outcome);
    let response =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert_eq!(response.status(), 200);
    assert_eq!(response.body(), b"<!doctype html><html><body>ok</body></html>");
    drop(state);
    server.join().unwrap();
}

#[test]
fn status_starting_polls_within_wait_and_attaches_when_running() {
    let dir = TestDir::new("status-starting-ok");
    let (_socket, listener) = bind_private_socket(dir.path());
    let server = std::thread::spawn(move || {
        for _ in 0..2 {
            let (mut peer, _) = listener.accept().unwrap();
            assert_eq!(read_control_line(&mut peer), "status\n");
            writeln!(
                peer,
                "{}",
                serde_json::json!({
                    "status": "starting",
                    "pid": 101,
                    "origin": DEFAULT_DAEMON_ORIGIN,
                })
            )
            .unwrap();
        }
        let (mut peer, _) = listener.accept().unwrap();
        assert_eq!(read_control_line(&mut peer), "status\n");
        writeln!(
            peer,
            "{}",
            serde_json::json!({
                "status": "running",
                "pid": 101,
                "origin": DEFAULT_DAEMON_ORIGIN,
            })
        )
        .unwrap();
        drop(peer);

        let (mut relay_peer, _) = listener.accept().unwrap();
        read_client_handshake(&mut relay_peer);
        let mut reader = BufReader::new(relay_peer.try_clone().unwrap());
        let req = MockRelay::read_request(&mut reader);
        MockRelay::write_reply(
            &mut relay_peer,
            req["id"].as_str().unwrap(),
            200,
            serde_json::json!({"Content-Type": "text/html; charset=utf-8"}),
            Some("ready"),
        );
    });

    let state = HostState::default();
    let outcome = connect_supervisor_within(
        dir.path(),
        false,
        DEFAULT_DAEMON_ORIGIN,
        Duration::from_secs(5),
        &state.supervisor_socket,
        |_| panic!("starting supervisor must not launch a second one"),
        |_| {},
    );
    record_connect_outcome(&state, outcome);
    let response =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert_eq!(response.status(), 200);
    assert_eq!(response.body(), b"ready");
    drop(state);
    server.join().unwrap();
}

#[test]
fn status_starting_past_wait_serves_cannot_start_unavailable() {
    let dir = TestDir::new("status-starting-timeout");
    let (_socket, listener) = bind_private_socket(dir.path());
    let polls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let server_polls = Arc::clone(&polls);
    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
    listener.set_nonblocking(true).unwrap();
    let server = std::thread::spawn(move || loop {
        if stop_rx.try_recv().is_ok() {
            break;
        }
        match listener.accept() {
            Ok((mut peer, _)) => {
                peer.set_nonblocking(false).unwrap();
                assert_eq!(read_control_line(&mut peer), "status\n");
                server_polls.fetch_add(1, Ordering::SeqCst);
                let _ = writeln!(
                    peer,
                    "{}",
                    serde_json::json!({
                        "status": "starting",
                        "pid": 102,
                        "origin": DEFAULT_DAEMON_ORIGIN,
                    })
                );
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(error) => panic!("accept failed: {error}"),
        }
    });

    let state = HostState::default();
    let started = Instant::now();
    let outcome = connect_supervisor_within(
        dir.path(),
        false,
        DEFAULT_DAEMON_ORIGIN,
        Duration::from_millis(250),
        &state.supervisor_socket,
        |_| panic!("must not launch while starting"),
        |_| {},
    );
    let elapsed = started.elapsed();
    let _ = stop_tx.send(());
    server.join().unwrap();

    assert!(outcome.is_err());
    assert!(
        elapsed < Duration::from_secs(2),
        "must stay within existing wait bound, took {elapsed:?}"
    );
    assert!(
        polls.load(Ordering::SeqCst) >= 2,
        "must ask status again within the wait"
    );
    record_connect_outcome(&state, outcome);
    let response =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert_cannot_start_response(&response, "start-connection-unavailable", None);
}

#[test]
fn status_failed_with_cause_refuses_immediately_and_shows_both_codes() {
    let dir = TestDir::new("status-failed");
    let log = dir.path().join("daemon.log");
    std::fs::write(&log, "failed\n").unwrap();
    let (_socket, listener) = bind_private_socket(dir.path());
    let polls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let server_polls = Arc::clone(&polls);
    let server = std::thread::spawn(move || {
        let (mut peer, _) = listener.accept().unwrap();
        assert_eq!(read_control_line(&mut peer), "status\n");
        server_polls.fetch_add(1, Ordering::SeqCst);
        writeln!(
            peer,
            "{}",
            serde_json::json!({
                "status": "failed",
                "pid": 103,
                "origin": DEFAULT_DAEMON_ORIGIN,
                "cause": "database-start",
                "detail": "the database exited",
            })
        )
        .unwrap();
        drop(peer);
        listener.set_nonblocking(true).unwrap();
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock,
            "failed start must not poll again or attach"
        );
    });

    let state = HostState::default();
    *state.daemon_log.lock().unwrap() = Some(log.clone());
    let started = Instant::now();
    let outcome = connect_supervisor_within(
        dir.path(),
        false,
        DEFAULT_DAEMON_ORIGIN,
        START_WAIT,
        &state.supervisor_socket,
        |_| panic!("failed supervisor must not trigger launch"),
        |_| {},
    );
    let elapsed = started.elapsed();
    server.join().unwrap();

    assert!(elapsed < Duration::from_secs(2));
    assert_eq!(polls.load(Ordering::SeqCst), 1);
    assert_eq!(
        outcome.as_ref().err(),
        Some(&StartRefusal::SupervisorFailed(Some(
            "database-start".to_string()
        )))
    );
    record_connect_outcome(&state, outcome);
    let response =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    let log_str = log.to_string_lossy().into_owned();
    assert_cannot_start_response(&response, "start-connection-unavailable", Some(&log_str));
    let body = String::from_utf8(response.body().clone()).unwrap();
    assert!(
        body.contains(&format!(
            "start-connection-unavailable\ndatabase-start\n{log_str}"
        )),
        "expected existing code, failed cause, and log path together in details, got: {body}"
    );
}

struct DrainSocketOnDrop(PathBuf);
impl Drop for DrainSocketOnDrop {
    fn drop(&mut self) {
        let _ = massion_carrier::control::drain(&self.0);
    }
}

#[test]
fn status_draining_polls_again_and_starts_once_old_supervisor_is_gone() {
    for unlink_old_socket in [false, true] {
        let dir = TestDir::new(if unlink_old_socket {
            "draining-enoent"
        } else {
            "draining-econnrefused"
        });
        let (socket, listener) = bind_private_socket(dir.path());
        let _drain_guard = DrainSocketOnDrop(socket.clone());
        let runner = dir.path().join("runner.cjs");
        std::fs::write(
            &runner,
            r#"
            process.umask(0o077);
            const server = require('node:net').createServer(peer => {
                peer.on('error', () => {});
                let buf = '';
                let clientMode = false;
                peer.on('data', chunk => {
                    buf += chunk;
                    for (;;) {
                        const nl = buf.indexOf('\n');
                        if (nl === -1) break;
                        const line = buf.slice(0, nl);
                        buf = buf.slice(nl + 1);
                        if (!clientMode) {
                            if (line === 'status') {
                                peer.end(JSON.stringify({status:'running', pid:process.pid, origin:'http://127.0.0.1:8765'}));
                                return;
                            }
                            if (line === 'drain') {
                                server.close();
                                peer.end('{"status":"drained"}', () => process.exit(0));
                                return;
                            }
                            if (line === 'client') {
                                clientMode = true;
                                continue;
                            }
                            peer.destroy();
                            return;
                        }
                        if (!line) continue;
                        const req = JSON.parse(line);
                        peer.write(JSON.stringify({
                            id: req.id,
                            status: 200,
                            headers: {'Content-Type': 'text/html; charset=utf-8'},
                            body: 'fresh',
                        }) + '\n');
                    }
                });
            });
            server.listen(process.argv[2]);
            setTimeout(() => process.exit(1), 10000).unref();
            "#,
        )
        .unwrap();

        let old_socket = socket.clone();
        let old_supervisor = std::thread::spawn(move || {
            let (mut peer, _) = listener.accept().unwrap();
            assert_eq!(read_control_line(&mut peer), "status\n");
            // Drop the listener (and optionally unlink) before sending the reply so
            // the next status poll deterministically observes ECONNREFUSED or ENOENT.
            drop(listener);
            if unlink_old_socket {
                std::fs::remove_file(&old_socket).unwrap();
            }
            writeln!(
                peer,
                "{}",
                serde_json::json!({
                    "status": "running",
                    "pid": 104,
                    "origin": DEFAULT_DAEMON_ORIGIN,
                    "draining": true,
                })
            )
            .unwrap();
        });

        let state = HostState::default();
        let launches = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let launch_count = Arc::clone(&launches);
        let outcome = connect_supervisor_within(
            dir.path(),
            false,
            DEFAULT_DAEMON_ORIGIN,
            START_WAIT,
            &state.supervisor_socket,
            |sock| {
                launch_count.fetch_add(1, Ordering::SeqCst);
                let node = massion_carrier::daemon::node_binary()?;
                Ok((
                    node,
                    vec![
                        runner.to_string_lossy().to_string(),
                        sock.to_string_lossy().to_string(),
                    ],
                ))
            },
            |_| {},
        );
        old_supervisor.join().unwrap();
        assert_eq!(launches.load(Ordering::SeqCst), 1);
        record_connect_outcome(&state, outcome);
        let response =
            scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
        assert_eq!(response.status(), 200);
        assert_eq!(response.body(), b"fresh");
    }
}

#[test]
fn status_draining_past_wait_serves_cannot_start_unavailable() {
    let dir = TestDir::new("draining-timeout");
    let (_socket, listener) = bind_private_socket(dir.path());
    let polls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let server_polls = Arc::clone(&polls);
    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
    listener.set_nonblocking(true).unwrap();
    let server = std::thread::spawn(move || loop {
        if stop_rx.try_recv().is_ok() {
            break;
        }
        match listener.accept() {
            Ok((mut peer, _)) => {
                peer.set_nonblocking(false).unwrap();
                assert_eq!(read_control_line(&mut peer), "status\n");
                server_polls.fetch_add(1, Ordering::SeqCst);
                let _ = writeln!(
                    peer,
                    "{}",
                    serde_json::json!({
                        "status": "running",
                        "pid": 105,
                        "origin": DEFAULT_DAEMON_ORIGIN,
                        "draining": true,
                    })
                );
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(error) => panic!("accept failed: {error}"),
        }
    });

    let state = HostState::default();
    let started = Instant::now();
    let outcome = connect_supervisor_within(
        dir.path(),
        false,
        DEFAULT_DAEMON_ORIGIN,
        Duration::from_millis(250),
        &state.supervisor_socket,
        |_| panic!("must not launch while old supervisor is still draining"),
        |_| {},
    );
    let elapsed = started.elapsed();
    let _ = stop_tx.send(());
    server.join().unwrap();

    assert!(outcome.is_err());
    assert!(elapsed < Duration::from_secs(2));
    assert!(polls.load(Ordering::SeqCst) >= 2);
    record_connect_outcome(&state, outcome);
    let response =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert_cannot_start_response(&response, "start-connection-unavailable", None);
}

#[test]
fn status_no_answer_or_malformed_refuses_immediately_with_cannot_start() {
    for (tag, reply_bytes) in [
        ("eof", &b""[..]),
        ("malformed-json", &b"not-json"[..]),
        ("missing-status", &br#"{"origin":"http://127.0.0.1:8765"}"#[..]),
        (
            "bad-draining-type",
            &br#"{"status":"running","draining":"yes","origin":"http://127.0.0.1:8765"}"#[..],
        ),
        (
            "unknown-status",
            &br#"{"status":"paused","origin":"http://127.0.0.1:8765"}"#[..],
        ),
    ] {
        let dir = TestDir::new(tag);
        let (_socket, listener) = bind_private_socket(dir.path());
        let payload = reply_bytes.to_vec();
        let server = std::thread::spawn(move || {
            let (mut peer, _) = listener.accept().unwrap();
            assert_eq!(read_control_line(&mut peer), "status\n");
            let _ = peer.write_all(&payload);
            drop(peer);
            listener.set_nonblocking(true).unwrap();
            assert_eq!(
                listener.accept().unwrap_err().kind(),
                std::io::ErrorKind::WouldBlock,
                "{tag}: must not ask again or attach"
            );
        });

        let state = HostState::default();
        let outcome = connect_supervisor_within(
            dir.path(),
            false,
            DEFAULT_DAEMON_ORIGIN,
            START_WAIT,
            &state.supervisor_socket,
            |_| panic!("{tag}: must not launch"),
            |_| {},
        );
        server.join().unwrap();
        assert!(outcome.is_err(), "{tag}: expected refusal");
        record_connect_outcome(&state, outcome);
        let response =
            scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
        assert_cannot_start_response(&response, "start-connection-unavailable", None);
    }

    // Silent hang (no answer within remaining wait): fails inside bound without attaching.
    let dir = TestDir::new("silent-timeout");
    let (_socket, listener) = bind_private_socket(dir.path());
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    let server = std::thread::spawn(move || {
        let (mut peer, _) = listener.accept().unwrap();
        assert_eq!(read_control_line(&mut peer), "status\n");
        let _ = done_rx.recv_timeout(Duration::from_secs(5));
    });
    let state = HostState::default();
    let started = Instant::now();
    let outcome = connect_supervisor_within(
        dir.path(),
        false,
        DEFAULT_DAEMON_ORIGIN,
        Duration::from_millis(120),
        &state.supervisor_socket,
        |_| panic!("silent-timeout: must not launch"),
        |_| {},
    );
    let elapsed = started.elapsed();
    let _ = done_tx.send(());
    server.join().unwrap();
    assert!(outcome.is_err());
    assert!(elapsed < Duration::from_secs(2));
    record_connect_outcome(&state, outcome);
    let response =
        scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
    assert_cannot_start_response(&response, "start-connection-unavailable", None);
}

#[test]
fn status_wrong_or_missing_origin_refuses_immediately_with_cannot_start() {
    for (tag, reply) in [
        (
            "wrong-origin",
            serde_json::json!({"status": "running", "pid": 106, "origin": "http://127.0.0.1:9999"}),
        ),
        (
            "missing-origin",
            serde_json::json!({"status": "running", "pid": 106}),
        ),
    ] {
        let dir = TestDir::new(tag);
        let (_socket, listener) = bind_private_socket(dir.path());
        let server = std::thread::spawn(move || {
            let (mut peer, _) = listener.accept().unwrap();
            assert_eq!(read_control_line(&mut peer), "status\n");
            writeln!(peer, "{}", reply).unwrap();
            drop(peer);
            listener.set_nonblocking(true).unwrap();
            assert_eq!(
                listener.accept().unwrap_err().kind(),
                std::io::ErrorKind::WouldBlock,
                "{tag}: must not ask again or attach"
            );
        });

        let state = HostState::default();
        let outcome = connect_supervisor_within(
            dir.path(),
            false,
            DEFAULT_DAEMON_ORIGIN,
            START_WAIT,
            &state.supervisor_socket,
            |_| panic!("{tag}: must not launch"),
            |_| {},
        );
        server.join().unwrap();
        assert!(outcome.is_err(), "{tag}: expected refusal");
        record_connect_outcome(&state, outcome);
        let response =
            scheme_response_for_state(&state, "massion", get_request("massion://app/"), CLIENT_WAIT);
        assert_cannot_start_response(&response, "start-connection-unavailable", None);
    }
}

#[test]
fn status_query_holds_no_host_or_start_lock_while_waiting() {
    let dir = TestDir::new("status-locks");
    let (socket, listener) = bind_private_socket(dir.path());
    let state = HostState::default();
    let gate = GateSlot::new();
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();

    std::thread::scope(|scope| {
        let _release = ReleaseOnDrop(&gate);
        let server = scope.spawn(|| {
            let (mut status_peer, _) = listener.accept().unwrap();
            assert_eq!(read_control_line(&mut status_peer), "status\n");
            gate.pause_before_handover();
            writeln!(
                status_peer,
                "{}",
                serde_json::json!({
                    "status": "running",
                    "pid": 107,
                    "origin": DEFAULT_DAEMON_ORIGIN,
                })
            )
            .unwrap();
            drop(status_peer);
            let (mut relay_peer, _) = listener.accept().unwrap();
            read_client_handshake(&mut relay_peer);
            let _ = done_rx.recv_timeout(Duration::from_secs(5));
        });

        let caller = scope.spawn(|| {
            connect_supervisor_within(
                dir.path(),
                false,
                DEFAULT_DAEMON_ORIGIN,
                Duration::from_secs(5),
                &state.supervisor_socket,
                |_| panic!("must not launch"),
                |_| {},
            )
        });

        gate.wait_arrived();
        assert!(
            state.supervisor_socket.try_lock().is_ok(),
            "supervisor_socket lock must not be held across status query"
        );
        assert!(
            state.daemon_log.try_lock().is_ok(),
            "daemon_log lock must not be held across status query"
        );
        assert!(
            state.client.try_lock().is_ok(),
            "client lock must not be held across status query"
        );
        assert!(
            state.quit.try_lock().is_ok(),
            "quit lock must not be held across status query"
        );
        assert!(
            state.start_failure_cause.try_lock().is_ok(),
            "start_failure_cause lock must not be held across status query"
        );
        let start_lock = massion_carrier::daemon::acquire_start_lock(&socket)
            .expect("start lock must not be held across status query");
        drop(start_lock);

        gate.release();
        let client = caller.join().unwrap().expect("status running attaches");
        drop(client);
        let _ = done_tx.send(());
        server.join().unwrap();
    });
}
