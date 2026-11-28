use std::fs::OpenOptions;
use std::io::{self, Read};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Runtime};

pub(crate) const TRAY_ID: &str = "massion-menu-bar";
pub(crate) const OPEN_ITEM_ID: &str = "open-massion";

pub(crate) fn menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let copy: serde_json::Value =
        serde_json::from_str(include_str!("../../../docs/product/screens/copy.ko.json"))
            .map_err(io::Error::other)?;
    let label = |key: &str| {
        copy[key]["ko"]
            .as_str()
            .ok_or_else(|| io::Error::other("Missing menu bar copy"))
    };
    let open = MenuItem::with_id(
        app,
        OPEN_ITEM_ID,
        label("ui.desktop.menu-bar.open")?,
        true,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(
        app,
        super::quit_menu::QUIT_ITEM_ID,
        label("ui.desktop.menu-bar.quit")?,
        true,
        None::<&str>,
    )?;
    Menu::with_items(app, &[&open, &separator, &quit])
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preference {
    show_menu_bar_item: Option<bool>,
}

fn read_preference(path: &Path) -> io::Result<bool> {
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(error),
    };
    const MAX_BYTES: u64 = 4096;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES {
        return Err(io::Error::other("Invalid desktop settings file"));
    }
    serde_json::from_reader::<_, Preference>(file.take(MAX_BYTES))
        .map(|settings| settings.show_menu_bar_item.unwrap_or(true))
        .map_err(io::Error::other)
}

// Read the committed value on the UI thread, so queued notifications cannot restore an old value.
pub(crate) fn refresh<R: Runtime>(app: &AppHandle<R>, settings_file: &Path) -> tauri::Result<()> {
    if read_preference(settings_file)? {
        if app.tray_by_id(TRAY_ID).is_none() {
            // The macOS tray backend displays square icons at 18 points.
            TrayIconBuilder::with_id(TRAY_ID)
                .menu(&menu(app)?)
                .icon(Image::from_bytes(include_bytes!(
                    "../icons/tray-template@2x.png"
                ))?)
                .icon_as_template(true)
                .build(app)?;
        }
    } else {
        drop(app.remove_tray_by_id(TRAY_ID));
    }
    Ok(())
}
