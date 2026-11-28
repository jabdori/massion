use super::*;
use objc2::rc::Retained;
use objc2::runtime::{Imp, Sel};
use objc2::{sel, ClassType, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSEventModifierFlags, NSMenu, NSMenuItem, NSStatusItem};
use std::cell::RefCell;
use std::future::Future;
use tauri::menu::MenuItemKind;
use tauri::test::{mock_context, noop_assets};

pub(super) struct Effects {
    pub(super) revealed: mpsc::Sender<()>,
    pub(super) draining: mpsc::Sender<Arc<QuitAttempt>>,
}

thread_local! {
    static ATTACHED: RefCell<Option<Retained<NSMenu>>> = const { RefCell::new(None) };
}

// Observe the menu that the real tray asks AppKit to pop up, without opening it.
fn attached_menu(app: &AppHandle) -> Option<Retained<NSMenu>> {
    unsafe extern "C-unwind" fn capture(_: &NSStatusItem, _: Sel, menu: *mut NSMenu) {
        if !menu.is_null() {
            ATTACHED.with(|slot| *slot.borrow_mut() = unsafe { Retained::retain(menu) });
        }
    }

    let tray = app.tray_by_id(menu_bar::TRAY_ID).unwrap();
    let method = NSStatusItem::class()
        .instance_method(sel!(setMenu:))
        .unwrap();
    struct Restore<'a>(&'a objc2::runtime::Method, Imp);
    impl Drop for Restore<'_> {
        fn drop(&mut self) {
            unsafe { self.0.set_implementation(self.1) };
        }
    }
    // The windowless harness owns the AppKit main thread and restores the method before dispatch.
    let original = unsafe {
        method.set_implementation(std::mem::transmute(
            capture as unsafe extern "C-unwind" fn(_, _, _),
        ))
    };
    let _restore = Restore(method, original);
    tray.with_inner_tray_icon(|tray| tray.show_menu()).unwrap();
    ATTACHED.with(|slot| slot.take())
}

fn until<T>(app: &mut tauri::App, what: &str, mut observe: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(value) = observe() {
            return value;
        }
        assert!(Instant::now() < deadline, "{what}");
        #[allow(deprecated)]
        app.run_iteration(|_, _| {});
    }
}

fn command<T: Send + 'static>(
    app: &mut tauri::App,
    request: impl Future<Output = T> + Send + 'static,
) -> T {
    let (send, receive) = mpsc::channel();
    tauri::async_runtime::spawn(async move {
        send.send(request.await).unwrap();
    });
    until(app, "native settings command did not return", || {
        receive.try_recv().ok()
    })
}

fn activate(app: &NSApplication, item: &NSMenuItem) {
    assert_eq!(item.action(), Some(sel!(customAction:)));
    assert!(unsafe {
        app.sendAction_to_from(item.action().unwrap(), item.target().as_deref(), Some(item))
    });
}

pub(crate) fn run() {
    let saved_off = std::env::args().any(|argument| argument == "--saved-off");
    if !saved_off {
        // Wry installs a process-wide menu event proxy. A separate harness process tests a cold start.
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--saved-off")
            .spawn()
            .unwrap();
        let mut exit = None;
        let status =
            recovery::wait_for_child_until(Instant::now() + Duration::from_secs(10), || {
                exit = child.try_wait()?;
                Ok(exit)
            });
        if status.is_err() {
            let _ = child.kill();
            let _ = recovery::wait_for_child_until(Instant::now() + Duration::from_secs(2), || {
                child.try_wait()
            });
        }
        status.expect("saved-off startup child must finish");
        assert!(exit.unwrap().success());
    }
    let mtm = MainThreadMarker::new().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let data_dir = directory.path().to_owned();
    let preference = data_dir.join("menu-bar-item.json");
    let notifications = data_dir.join("notifications.json");
    std::fs::write(&notifications, b"{\"notifications\":false}\n").unwrap();
    if saved_off {
        std::fs::write(&preference, b"false\n").unwrap();
    }
    let (reveal, revealed) = mpsc::channel();
    let (drain, draining) = mpsc::channel();
    let (dispatched, dispatch_state) = mpsc::channel();
    let revealed = Arc::new(Mutex::new(revealed));
    let reveal_at_dispatch = revealed.clone();
    let mut app = desktop_setup(
        tauri::Builder::default().manage(HostState {
            menu_test: Some(Effects {
                revealed: reveal,
                draining: drain,
            }),
            ..HostState::default()
        }),
        |_| Ok(()),
        move |_| Ok(data_dir),
    )
    .on_menu_event(move |_, event| {
        if event.id() == menu_bar::OPEN_ITEM_ID {
            dispatched
                .send(reveal_at_dispatch.lock().unwrap().try_recv().is_ok())
                .unwrap();
        }
    })
    .build(mock_context(noop_assets()))
    .unwrap();
    #[allow(deprecated)]
    app.run_iteration(|_, _| {});
    let handle = app.handle().clone();
    let old_supervisor = r#"{"installedVersion":"0.9.0","notifications":false,"restartRequired":false,"restartStatus":"idle","update":"unknown"}"#;
    let startup = command(&mut app, {
        let handle = handle.clone();
        async move { settings_with_menu_bar(&handle, old_supervisor).await }
    })
    .expect("desktop setup starts the native settings owner");
    let startup: Value = serde_json::from_str(&startup).unwrap();
    let present = || handle.tray_by_id(menu_bar::TRAY_ID).is_some();
    if saved_off {
        assert_eq!(
            startup["showMenuBarItem"], false,
            "saved off is reported by the host"
        );
        assert!(!present(), "a disabled startup does not build the item");
        return;
    }
    assert_eq!(
        startup["showMenuBarItem"], true,
        "missing menu preference defaults to on"
    );
    assert_eq!(startup["notifications"], false);
    assert_eq!(startup["restartRequired"], false);
    assert!(present(), "startup installs the tray");

    handle
        .tray_by_id(menu_bar::TRAY_ID)
        .unwrap()
        .with_inner_tray_icon(|tray| {
            let mtm = MainThreadMarker::new().unwrap();
            let image = tray
                .ns_status_item()
                .unwrap()
                .button(mtm)
                .unwrap()
                .image()
                .unwrap();
            assert!(image.isTemplate());
            assert_eq!(image.size(), objc2_foundation::NSSize::new(18.0, 18.0));
            let mut widths: Vec<_> = image
                .representations()
                .iter()
                .map(|rep| rep.pixelsWide())
                .collect();
            widths.sort_unstable();
            assert_eq!(
                widths,
                [18, 36],
                "the status item image contains both raster scales"
            );
        })
        .unwrap();

    let native = NSApplication::sharedApplication(mtm);
    let app_quit = application_menu(&app, &native);
    let menu = attached_menu(&handle).expect("tray builder attaches a menu to the status item");
    let items = menu.itemArray();
    assert_eq!(items.len(), 3);
    let open = items.objectAtIndex(0);
    let separator = items.objectAtIndex(1);
    let quit = items.objectAtIndex(2);
    let copy: Value =
        serde_json::from_str(include_str!("../../../docs/product/screens/copy.ko.json")).unwrap();
    assert_eq!(
        open.title().to_string(),
        copy["ui.desktop.menu-bar.open"]["ko"].as_str().unwrap()
    );
    assert!(separator.isSeparatorItem());
    assert_eq!(
        quit.title().to_string(),
        copy["ui.desktop.menu-bar.quit"]["ko"].as_str().unwrap()
    );

    activate(&native, &open);
    let ran_inline = until(
        &mut app,
        "Open did not reach the registered menu handler",
        || dispatch_state.try_recv().ok(),
    );
    assert!(
        !ran_inline,
        "Open returned before invoking the window operation"
    );
    until(
        &mut app,
        "Open did not call the product window operation",
        || revealed.lock().unwrap().try_recv().ok(),
    );

    for (item, message) in [
        (&quit, "tray Quit did not call the product quit entry point"),
        (
            &app_quit,
            "application Quit did not call the same product quit entry point",
        ),
    ] {
        activate(&native, item);
        let attempt = until(&mut app, message, || draining.try_recv().ok());
        let state = handle.state::<HostState>();
        let mut quit = state.quit.lock().unwrap();
        assert!(is_current_quit(&quit, &attempt));
        assert!(!attempt.restart);
        *quit = QuitState::Idle;
    }
    drop(items);
    drop(menu);

    let save = |app: &mut tauri::App, value| {
        let handle = handle.clone();
        command(app, async move {
            desktop_save_menu_bar_item(handle, value).await
        })
    };
    assert!(!save(&mut app, false).unwrap());
    assert!(!present(), "turning off the menu removes the status item");
    assert_eq!(std::fs::read(&preference).unwrap(), b"false\n");

    // Force the rename to fail after the tray is built, and observe its rollback.
    std::fs::remove_file(&preference).unwrap();
    std::fs::create_dir(&preference).unwrap();
    assert!(save(&mut app, true).is_err());
    assert!(!present(), "a rejected enable removes the uncommitted tray");
    std::fs::remove_dir(&preference).unwrap();

    assert!(save(&mut app, true).unwrap());
    assert!(
        present(),
        "turning the menu back on installs the status item"
    );
    assert_eq!(std::fs::read(&preference).unwrap(), b"true\n");
    assert_eq!(
        std::fs::read(&notifications).unwrap(),
        b"{\"notifications\":false}\n"
    );
    assert!(!save(&mut app, false).unwrap());
}

fn application_menu(app: &tauri::App, native: &NSApplication) -> Retained<NSMenuItem> {
    fn collect_quit_items(menu: &NSMenu, items: &mut Vec<Retained<NSMenuItem>>) {
        for item in menu.itemArray().iter() {
            if let Some(submenu) = item.submenu() {
                collect_quit_items(&submenu, items);
            } else if item.action() == Some(sel!(terminate:))
                || item.keyEquivalent().to_string() == "q"
                || item.title().to_string().starts_with("Quit ")
            {
                items.push(item);
            }
        }
    }

    let menu = app.menu().unwrap();
    let MenuItemKind::Submenu(application) = &menu.items().unwrap()[0] else {
        panic!("application submenu")
    };
    let Some(MenuItemKind::MenuItem(item)) = application.get(quit_menu::QUIT_ITEM_ID) else {
        panic!("custom item in the application submenu")
    };
    assert_eq!(item.text().unwrap(), "Quit Massion");
    assert!(item.is_enabled().unwrap());

    let menu = native.mainMenu().unwrap();
    let mut quit_items = Vec::new();
    collect_quit_items(&menu, &mut quit_items);
    assert_eq!(quit_items.len(), 1, "exactly one native quit item");
    let item = quit_items.pop().unwrap();
    assert_eq!(item.title().to_string(), "Quit Massion");
    assert_eq!(
        item.action(),
        Some(sel!(customAction:)),
        "the item emits a Muda menu event"
    );
    assert_eq!(
        item.keyEquivalent().to_string(),
        "q",
        "the installed shortcut is Q"
    );
    assert_eq!(
        item.keyEquivalentModifierMask(),
        NSEventModifierFlags::Command,
        "the installed modifier is Command"
    );
    item
}
