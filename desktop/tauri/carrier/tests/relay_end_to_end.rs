use massion_carrier::LineClient;
use std::io;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// The real relay, through the real supervisor (daemon-runner.mjs), with the
/// fake core shared with the JS tests (desktop/tests/fixtures/feed-core.mjs),
/// connected through the real carrier: one subscription id travels the whole
/// path in the exact message shape desktop/tauri-client.js parses, close
/// really unsubscribes, and five subscribe/close cycles stay under the
/// four-subscription limit.
#[test]
fn subscription_id_and_shape_travel_the_whole_path() {
    let mut supervisor = Supervisor::start("drain");
    let socket = supervisor.root.join("daemon.sock");
    assert!(
        massion_carrier::daemon::socket_is_private(&socket).unwrap(),
        "the socket must stay user-private"
    );
    let core = supervisor.wait_for_records("start", 0)[0]["pid"]
        .as_i64()
        .unwrap() as i32;

    let (events, receiver) = mpsc::channel::<String>();
    let client = LineClient::connect(&socket, move |line| {
        let _ = events.send(line.to_string());
    })
    .expect("client connection");

    let events_path = "/protocol/events?version=1&requestId=r&generation=1&after=0";
    let reply = client
        .request_as_timed(
            "s-1",
            "GET",
            events_path,
            None,
            None,
            Duration::from_secs(10),
        )
        .expect("subscribe reply");
    assert!(
        (200..300).contains(&reply.status),
        "subscribe refused: {}",
        reply.status
    );

    let line = receiver
        .recv_timeout(Duration::from_secs(10))
        .expect("a feed event");
    let value: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(value["event"], "message");
    assert_eq!(
        value["subscription"], "s-1",
        "the event carries the id the client registered"
    );
    assert_eq!(value["lastEventId"], "[\"feed\",0]");
    assert_eq!(value["data"], "{\"connected\":true}");

    client.send_close("s-1").expect("close sent");
    supervisor.wait_for_records("closed", 0);

    for cycle in 1..=5u32 {
        let id = format!("sub-{}", cycle);
        let reply = client
            .request_as_timed(&id, "GET", events_path, None, None, Duration::from_secs(10))
            .unwrap_or_else(|error| panic!("cycle {} failed: {:?}", cycle, error));
        assert!(
            (200..300).contains(&reply.status),
            "cycle {} hit the subscription limit: {}",
            cycle,
            reply.status
        );
        let closed = supervisor.records("closed").len();
        client.send_close(&id).expect("close sent");
        supervisor.wait_for_records("closed", closed);
    }

    let drained = massion_carrier::control::drain(&socket);
    drop(client);
    assert_eq!(
        drained,
        Ok(()),
        "the real supervisor acknowledges drain beside the relay"
    );
    supervisor.assert_exited_and_reaped_core(core);
}

#[test]
fn direct_sigterm_still_reaps_the_core() {
    let mut supervisor = Supervisor::start("term");
    let core = supervisor.wait_for_records("start", 0)[0]["pid"]
        .as_i64()
        .unwrap() as i32;
    assert_eq!(
        unsafe { libc::kill(supervisor.pid.unwrap(), libc::SIGTERM) },
        0,
        "signal the supervisor directly"
    );
    supervisor.assert_exited_and_reaped_core(core);
}

struct Supervisor {
    root: PathBuf,
    pid: Option<i32>,
}

impl Supervisor {
    fn start(name: &str) -> Self {
        use std::os::unix::fs::DirBuilderExt;
        let root =
            std::env::temp_dir().join(format!("massion-relay-{}-{name}", std::process::id()));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&root)
            .unwrap();
        let mut supervisor = Self { root, pid: None };
        let socket = supervisor.root.join("daemon.sock");
        let log = supervisor.root.join("daemon.log");
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let args = [
            manifest.join("tests/relay_supervisor.mjs"),
            manifest.join("../../daemon-runner.mjs"),
            socket.clone(),
            manifest.join("../../tests/fixtures/feed-core.mjs"),
        ]
        .map(|path| path.into_os_string().into_string().unwrap());
        let node = massion_carrier::daemon::node_binary().expect("node resolves in a debug build");
        let pid =
            massion_carrier::daemon::start_detached(&node, &args, &log, Some(&supervisor.root))
                .expect("supervisor starts detached");
        supervisor.pid = Some(pid as i32);
        assert!(
            massion_carrier::daemon::wait_for_socket(&socket, Duration::from_secs(20)),
            "socket never answered: {}",
            std::fs::read_to_string(log).unwrap_or_default()
        );
        supervisor
    }

    fn records(&self, kind: &str) -> Vec<serde_json::Value> {
        let state = self.root.join("feed-core-state.log");
        let text = match std::fs::read_to_string(&state) {
            Ok(text) => text,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Vec::new(),
            Err(error) => panic!("could not read {}: {error}", state.display()),
        };
        text.split_inclusive('\n')
            .filter(|line| line.ends_with('\n'))
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .filter(|record| record["kind"] == kind)
            .collect()
    }

    fn wait_for_records(&self, kind: &str, previous: usize) -> Vec<serde_json::Value> {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let records = self.records(kind);
            if records.len() > previous {
                return records;
            }
            assert!(
                Instant::now() < deadline,
                "fixture never recorded another {kind}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn reap(&mut self, timeout: Duration) -> io::Result<Option<i32>> {
        let pid = self.pid.unwrap();
        let deadline = Instant::now() + timeout;
        loop {
            let mut status = 0;
            match unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) } {
                reaped if reaped == pid => {
                    self.pid = None;
                    return Ok(Some(status));
                }
                0 => {}
                _ => {
                    let error = io::Error::last_os_error();
                    if error.kind() != io::ErrorKind::Interrupted {
                        return Err(error);
                    }
                }
            }
            if Instant::now() >= deadline {
                return Ok(None);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn assert_exited_and_reaped_core(&mut self, core: i32) {
        let status = self
            .reap(Duration::from_secs(20))
            .unwrap()
            .expect("supervisor did not exit");
        assert!(libc::WIFEXITED(status));
        assert_eq!(
            libc::WEXITSTATUS(status),
            0,
            "supervisor exited unsuccessfully"
        );
        let exists = unsafe { libc::kill(core, 0) };
        assert_eq!(exists, -1, "fixture core still exists");
        assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        if let Some(pid) = self.pid {
            // The detached supervisor leads a process group containing its fixture core.
            unsafe { libc::kill(-pid, libc::SIGKILL) };
            let _ = self.reap(Duration::from_secs(1));
        }
        if std::thread::panicking() {
            eprintln!(
                "{}",
                std::fs::read_to_string(self.root.join("daemon.log")).unwrap_or_default()
            );
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
