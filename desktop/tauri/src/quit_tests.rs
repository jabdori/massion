use super::*;
use std::cell::RefCell;

#[test]
fn quit_waits_once_and_exits_once_on_success() {
    let state = Mutex::new(QuitState::default());
    let mut requests = 0;
    let mut exits = Vec::new();
    begin_quit(&state, || requests += 1);
    begin_quit(&state, || requests += 1);
    assert_eq!(requests, 1, "duplicate selection cannot start a request");
    assert!(exits.is_empty(), "there is no exit while waiting");

    finish_quit(
        &state,
        Ok(()),
        |code| exits.push(code),
        |_| panic!("unexpected failure"),
        || panic!("unexpected show"),
    );
    assert_eq!(exits, [0], "success requests one normal exit");
    begin_quit(&state, || requests += 1);
    assert_eq!(
        requests, 1,
        "a queued selection cannot restart an accepted quit"
    );
}

#[test]
fn quit_failure_is_tagged_reported_and_shown_and_can_retry() {
    for (reason, code) in [
        (DrainFailure::NotConnected, "quit-not-connected"),
        (DrainFailure::NoAnswer, "quit-no-answer"),
        (DrainFailure::Disconnected, "quit-disconnected"),
        (DrainFailure::TransportError, "quit-transport-error"),
        (DrainFailure::Unsettled, "quit-unsettled"),
        (DrainFailure::UnexpectedStatus, "quit-unexpected-status"),
        (DrainFailure::TruncatedReply, "quit-truncated-reply"),
        (DrainFailure::InvalidReply, "quit-invalid-reply"),
    ] {
        let state = Mutex::new(QuitState::default());
        let mut requests = 0;
        let mut exits = 0;
        let mut shown = 0;
        let mut reported = Vec::new();
        begin_quit(&state, || requests += 1);
        finish_quit(
            &state,
            Err(reason),
            |_| exits += 1,
            |payload| reported.push(payload),
            || shown += 1,
        );
        assert_eq!(exits, 0, "{code}: keep the host running");
        assert_eq!(
            *state.lock().unwrap(),
            QuitState::Failed(reason),
            "{code}: store the reason"
        );
        assert_eq!(
            reported,
            [serde_json::json!({"quitFailure": code})],
            "{code}: report the reason to the screen"
        );
        assert_eq!(shown, 1, "{code}: show the window");
        begin_quit(&state, || requests += 1);
        assert_eq!(requests, 2, "{code}: retry sends a second request");
    }
}

#[test]
fn close_prevents_destruction_and_hides_the_window() {
    let actions = RefCell::new(Vec::new());
    hide_on_close(
        || actions.borrow_mut().push("prevent"),
        || {
            actions.borrow_mut().push("hide");
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(actions.into_inner(), ["prevent", "hide"]);
}

#[test]
fn reopen_and_second_launch_show_unminimize_and_focus_the_same_window() {
    let actions = RefCell::new(Vec::new());
    reveal_window(
        || {
            actions.borrow_mut().push("show");
            Ok(())
        },
        || {
            actions.borrow_mut().push("unminimize");
            Ok(())
        },
        || {
            actions.borrow_mut().push("focus");
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(actions.into_inner(), ["show", "unminimize", "focus"]);
}
