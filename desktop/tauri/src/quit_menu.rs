use tauri::menu::{Menu, MenuItem, MenuItemKind};
use tauri::{AppHandle, Runtime};

pub(crate) const QUIT_ITEM_ID: &str = "quit-massion";

pub(crate) fn application_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    // Tauri 2.12.5 puts the native Quit last in the first macOS submenu.
    let Some(MenuItemKind::Submenu(application)) = menu.items()?.into_iter().next() else {
        return Err(std::io::Error::other("Missing macOS application submenu").into());
    };
    let items = application.items()?;
    let Some(MenuItemKind::Predefined(quit)) = items.last() else {
        return Err(std::io::Error::other("Missing macOS Quit item").into());
    };
    application.remove(quit)?;
    let quit = MenuItem::with_id(app, QUIT_ITEM_ID, "Quit Massion", true, Some("Cmd+Q"))?;
    application.append(&quit)?;
    Ok(menu)
}
