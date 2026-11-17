use massion_carrier::{CarrierError, LineClient};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

fn spawn_fake_daemon() -> (PathBuf, std::thread::JoinHandle<()>) {
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos();
    let root = std::env::temp_dir().join(format!("massion-carrier-fake-{}-{}", std::process::id(), stamp));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("daemon.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let handle = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut writer = stream.try_clone().unwrap();
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        loop {
            line.clear();
            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                break;
            }
            let value: serde_json::Value = match serde_json::from_str(line.trim()) {
                Ok(value) => value,
                Err(_) => continue, // the "client" handshake line and noise
            };
            if value.get("event").is_some() {
                if value["event"] == "close" {
                    writer.write_all(b"{\"event\":\"error\",\"subscription\":\"s1\"}\n").unwrap();
                }
                continue;
            }
            let id = value["id"].as_str().unwrap().to_string();
            if value["path"] == "/hold" {
                continue;
            }
            let reply = serde_json::json!({"id": id, "status": 200, "headers": {"content-type": "application/json"}, "body": "{\"ok\":true}"});
            writer.write_all((reply.to_string() + "\n").as_bytes()).unwrap();
        }
    });
    (path, handle)
}

#[test]
fn requests_round_trip_and_events_reach_the_callback() {
    let (path, _server) = spawn_fake_daemon();
    let (events, receiver) = mpsc::channel::<String>();
    let client = LineClient::connect(&path, move |line| {
        let _ = events.send(line.to_string());
    })
    .unwrap();
    let reply = client.request("GET", "/", None, None).unwrap();
    assert_eq!(reply.status, 200);
    assert_eq!(reply.body.as_deref(), Some("{\"ok\":true}"));
    assert!(reply.headers.iter().any(|(name, value)| name == "content-type" && value == "application/json"));

    let _ = client.send_close("s1").unwrap();
    let event = receiver.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(event.contains("\"error\""));
    assert!(client.request("GET", "/", None, None).is_ok());
    let _ = std::fs::remove_file(&path);
}

#[test]
fn a_stalled_reply_times_out_and_a_closed_daemon_fails_fast() {
    let (path, _server) = spawn_fake_daemon();
    let client = LineClient::connect(&path, |_| {}).unwrap();
    let started = std::time::Instant::now();
    assert_eq!(client.request_timed("POST", "/hold", None, Some("{}"), Duration::from_millis(300)), Err(CarrierError::Timeout));
    assert!(started.elapsed() >= Duration::from_millis(290));
    drop(client);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn an_oversized_response_line_fails_before_any_newline_arrives() {
    let root = std::env::temp_dir().join(format!("massion-carrier-overflow-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("daemon.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut writer = stream.try_clone().unwrap();
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        let _ = reader.read_line(&mut line); // the "client" handshake
        let chunk = vec![b'x'; 1024 * 1024];
        for _ in 0..5 {
            writer.write_all(&chunk).unwrap(); // five mebibytes and never a newline
        }
        std::thread::sleep(Duration::from_secs(10));
    });
    let client = LineClient::connect(&path, |_| {}).unwrap();
    let started = std::time::Instant::now();
    let error = client.request_timed("GET", "/", None, None, Duration::from_secs(5)).unwrap_err();
    assert_eq!(error, CarrierError::Closed, "the bounded read must fail the connection, not time out");
    assert!(started.elapsed() < Duration::from_secs(4), "the failure must be immediate");
    drop(client);
    let _ = server.join();
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn exact_limit_lines_are_accepted_and_one_byte_more_is_refused() {
    // The same fixture the JS relay tests use pins both limits.
    let fixture: serde_json::Value = serde_json::from_str(include_str!("../../../tests/fixtures/line-limits.json")).unwrap();
    let request_limit = fixture["requestLineLimit"].as_u64().unwrap() as usize;
    let response_limit = fixture["responseLineLimit"].as_u64().unwrap() as usize;
    assert_eq!(request_limit, massion_carrier::socket::MAX_REQUEST_LINE, "the shared fixture pins the request line limit");
    assert_eq!(response_limit, massion_carrier::socket::MAX_RESPONSE_LINE, "the shared fixture pins the response line limit");

    let (path, _server) = spawn_fake_daemon();
    let client = LineClient::connect(&path, |_| {}).unwrap();
    let skeleton = |id: &str| serde_json::json!({"id":id,"method":"GET","path":"/","headers":{},"body":""}).to_string();
    let pad = request_limit - 1 - skeleton("exact").len();
    let body = "x".repeat(pad);
    let accepted = client.request_as_timed("exact", "GET", "/", None, Some(&body), Duration::from_secs(5));
    assert!(accepted.is_ok(), "a request line of exactly the limit (newline included) is accepted: {:?}", accepted.err());
    // With the shorter id, this body makes the line exactly the limit, so the
    // appended newline is one byte past it.
    let one_byte_more = "x".repeat(request_limit - skeleton("over").len());
    let refused = client.request_as_timed("over", "GET", "/", None, Some(&one_byte_more), Duration::from_secs(5));
    assert_eq!(refused.err(), Some(CarrierError::Invalid), "one byte more than the limit is refused before anything is sent");
    drop(client);
    let _ = std::fs::remove_file(&path);
}
