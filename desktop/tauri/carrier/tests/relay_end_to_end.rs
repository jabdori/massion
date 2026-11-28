use massion_carrier::LineClient;
use std::cell::Cell;
use std::io::{self, Read};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::rc::Rc;
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
    let supervisor = Supervisor::start("drain");
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
    let supervisor = Supervisor::start("term");
    let core = supervisor.wait_for_records("start", 0)[0]["pid"]
        .as_i64()
        .unwrap() as i32;
    assert_eq!(
        unsafe { libc::kill(supervisor.process.pid.get().unwrap(), libc::SIGTERM) },
        0,
        "signal the supervisor directly"
    );
    supervisor.assert_exited_and_reaped_core(core);
}

#[test]
fn fixture_cleans_up_the_core_after_supervisor_only_exit() {
    let supervisor = Supervisor::start("orphan");
    let core = supervisor.wait_for_records("start", 0)[0]["pid"]
        .as_i64()
        .unwrap() as i32;
    // Keep an independent guard through the assertion so a regression still cleans up.
    let process = supervisor.process.clone();
    let group = process.pid.get().unwrap();
    let mut peer = UnixStream::connect(supervisor.root.join("core.sock")).unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    assert_eq!(unsafe { libc::kill(group, libc::SIGKILL) }, 0);
    let status = process
        .observe_exit(Duration::from_secs(5))
        .unwrap()
        .unwrap();
    assert_eq!(status.si_code, libc::CLD_KILLED);
    assert_eq!(unsafe { status.si_status() }, libc::SIGKILL);
    let failure = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        supervisor.assert_exited_and_reaped_core(core);
    }));
    drop(supervisor);
    assert_eq!(
        peer.read(&mut [0]).ok(),
        Some(0),
        "dropping the fixture stops its core"
    );
    let failure = failure.expect_err("a live core must fail the fixture check");
    assert!(failure
        .downcast_ref::<String>()
        .unwrap()
        .contains("fixture core still exists"));
    process
        .reap(Duration::from_secs(1))
        .unwrap()
        .expect("supervisor was not reaped");
}

struct Supervisor {
    root: PathBuf,
    process: Rc<SupervisorProcess>,
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
        let supervisor = Self {
            root,
            process: Rc::new(SupervisorProcess::default()),
        };
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
        supervisor.process.pid.set(Some(pid as i32));
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

    fn assert_exited_and_reaped_core(&self, core: i32) {
        let observed = self
            .process
            .observe_exit(Duration::from_secs(20))
            .unwrap()
            .expect("supervisor did not exit");
        assert_eq!(
            self.process.pid.get(),
            Some(unsafe { observed.si_pid() }),
            "the supervisor must still anchor its process group during the core check"
        );
        let exists = unsafe { libc::kill(core, 0) };
        assert_eq!(exists, -1, "fixture core still exists");
        assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
        let status = self
            .process
            .reap(Duration::from_secs(1))
            .unwrap()
            .expect("supervisor was not reaped");
        assert!(libc::WIFEXITED(status));
        assert_eq!(
            libc::WEXITSTATUS(status),
            0,
            "supervisor exited unsuccessfully"
        );
    }
}

#[derive(Default)]
struct SupervisorProcess {
    pid: Cell<Option<i32>>,
}

impl SupervisorProcess {
    fn observe_exit(&self, timeout: Duration) -> io::Result<Option<libc::siginfo_t>> {
        let pid = self.pid.get().unwrap();
        poll_exit(timeout, || {
            let mut status: libc::siginfo_t = unsafe { std::mem::zeroed() };
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    pid as libc::id_t,
                    &mut status,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            };
            if result != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok((unsafe { status.si_pid() } == pid).then_some(status))
        })
    }

    fn reap(&self, timeout: Duration) -> io::Result<Option<i32>> {
        let Some(pid) = self.pid.get() else {
            return Ok(None);
        };
        poll_exit(timeout, || {
            let mut status = 0;
            match unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) } {
                reaped if reaped == pid => {
                    self.pid.set(None);
                    Ok(Some(status))
                }
                0 => Ok(None),
                _ => Err(io::Error::last_os_error()),
            }
        })
    }
}

fn poll_exit<T>(
    timeout: Duration,
    mut poll: impl FnMut() -> io::Result<Option<T>>,
) -> io::Result<Option<T>> {
    let deadline = Instant::now() + timeout;
    loop {
        match poll() {
            Ok(Some(status)) => return Ok(Some(status)),
            Ok(None) => {}
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

impl Drop for SupervisorProcess {
    fn drop(&mut self) {
        if let Some(pid) = self.pid.get() {
            // Also stop the group if the fixture's own cleanup failed its assertion.
            unsafe { libc::kill(-pid, libc::SIGKILL) };
            let _ = self.reap(Duration::from_secs(1));
        }
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        if let Some(pid) = self.process.pid.get() {
            // The unreaped supervisor anchors the process group ID.
            unsafe { libc::kill(-pid, libc::SIGKILL) };
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
