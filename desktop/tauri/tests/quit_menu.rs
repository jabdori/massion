#[cfg(target_os = "macos")]
#[path = "../src/menu_bar.rs"]
mod menu_bar;
#[cfg(target_os = "macos")]
#[path = "../src/quit_menu.rs"]
mod quit_menu;

fn main() {
    #[cfg(target_os = "macos")]
    {
        application_menu_has_one_custom_cmd_q();
        menu_bar_follows_the_saved_preference();
    }
}

#[cfg(target_os = "macos")]
fn menu_bar_follows_the_saved_preference() {
    use std::fs;
    use tauri::menu::MenuItemKind;
    use tauri::test::{mock_builder, mock_context, noop_assets};

    struct Fixture(std::path::PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let directory = std::env::temp_dir()
        .canonicalize()
        .unwrap()
        .join(format!("massion-menu-bar-{}", std::process::id()));
    fs::create_dir(&directory).unwrap();
    let directory = Fixture(directory);
    let file = directory.0.join("notifications.json");
    let app = mock_builder().build(mock_context(noop_assets())).unwrap();
    let handle = app.handle();
    let present = || handle.tray_by_id(menu_bar::TRAY_ID).is_some();

    fs::write(&file, br#"{"notifications":true,"showMenuBarItem":false}"#).unwrap();
    menu_bar::refresh(handle, &file).unwrap();
    assert!(!present(), "a disabled startup does not build the item");
    fs::write(&file, br#"{"notifications":false}"#).unwrap();
    menu_bar::refresh(handle, &file).unwrap();
    assert!(present(), "a legacy preference builds the default item");
    handle.remove_tray_by_id(menu_bar::TRAY_ID).unwrap();
    fs::write(&file, br#"{"notifications":true,"showMenuBarItem":true}"#).unwrap();
    menu_bar::refresh(handle, &file).unwrap();
    assert!(present(), "an enabled startup builds the item");
    fs::write(&file, br#"{"notifications":true,"showMenuBarItem":false}"#).unwrap();
    menu_bar::refresh(handle, &file).unwrap();
    assert!(!present(), "turning the setting off removes the item");
    fs::write(&file, br#"{"notifications":true,"showMenuBarItem":true}"#).unwrap();
    menu_bar::refresh(handle, &file).unwrap();
    assert!(present(), "turning the setting back on rebuilds the item");
    handle.remove_tray_by_id(menu_bar::TRAY_ID).unwrap();
    fs::remove_file(&file).unwrap();
    menu_bar::refresh(handle, &file).unwrap();
    assert!(present(), "a fresh installation builds the default item");
    handle.remove_tray_by_id(menu_bar::TRAY_ID).unwrap();

    let menu = menu_bar::menu(handle).unwrap();
    let items = menu.items().unwrap();
    let [MenuItemKind::MenuItem(open), MenuItemKind::Predefined(_), MenuItemKind::MenuItem(quit)] =
        &items[..]
    else {
        panic!("expected open, separator and quit in order");
    };
    assert_eq!(open.id(), menu_bar::OPEN_ITEM_ID);
    assert_eq!(quit.id(), quit_menu::QUIT_ITEM_ID);
    let copy: serde_json::Value =
        serde_json::from_str(include_str!("../../../docs/product/screens/copy.ko.json")).unwrap();
    assert_eq!(
        open.text().unwrap(),
        copy["ui.desktop.menu-bar.open"]["ko"].as_str().unwrap()
    );
    assert_eq!(
        quit.text().unwrap(),
        copy["ui.desktop.menu-bar.quit"]["ko"].as_str().unwrap()
    );
}

#[cfg(target_os = "macos")]
fn application_menu_has_one_custom_cmd_q() {
    use objc2::{sel, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSEventModifierFlags, NSMenu, NSMenuItem};
    use tauri::menu::MenuItemKind;
    use tauri::test::{mock_builder, mock_context, noop_assets};

    fn collect_quit_items(menu: &NSMenu, items: &mut Vec<objc2::rc::Retained<NSMenuItem>>) {
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

    // AppKit menus require the process main thread; this test builds no windows and runs no event loop.
    let mtm = MainThreadMarker::new().unwrap();
    let app = mock_builder()
        .menu(quit_menu::application_menu)
        .build(mock_context(noop_assets()))
        .unwrap();
    let menu = app.menu().unwrap();
    let MenuItemKind::Submenu(application) = &menu.items().unwrap()[0] else {
        panic!("application submenu")
    };
    let Some(MenuItemKind::MenuItem(item)) = application.get(quit_menu::QUIT_ITEM_ID) else {
        panic!("custom item in the application submenu")
    };
    assert_eq!(item.text().unwrap(), "Quit Massion");
    assert!(item.is_enabled().unwrap());

    let menu = NSApplication::sharedApplication(mtm).mainMenu().unwrap();
    let mut quit_items = Vec::new();
    collect_quit_items(&menu, &mut quit_items);
    assert_eq!(quit_items.len(), 1, "exactly one native quit item");
    let item = &quit_items[0];
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
}
