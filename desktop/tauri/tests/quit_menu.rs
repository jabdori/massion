#[cfg(target_os = "macos")]
#[path = "../src/quit_menu.rs"]
mod quit_menu;

fn main() {
    #[cfg(target_os = "macos")]
    application_menu_has_one_custom_cmd_q();
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
