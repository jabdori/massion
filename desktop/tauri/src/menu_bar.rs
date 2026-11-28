use std::fs::OpenOptions;
use std::io::{self, Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use objc2::MainThreadMarker;
use objc2_app_kit::NSBitmapImageRep;
use objc2_foundation::NSData;
use tauri::async_runtime::{channel, spawn, spawn_blocking, Sender};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Runtime};

pub(crate) const TRAY_ID: &str = "massion-menu-bar";
pub(crate) const OPEN_ITEM_ID: &str = "open-massion";
const FILE_NAME: &str = "menu-bar-item.json";

fn menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
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
    let mut contents = Vec::new();
    file.take(MAX_BYTES + 1).read_to_end(&mut contents)?;
    if contents.len() as u64 > MAX_BYTES {
        return Err(io::Error::other("Invalid desktop settings file"));
    }
    serde_json::from_slice(&contents).map_err(io::Error::other)
}

type Reply = Result<bool, String>;

pub(super) struct Settings(Sender<Request>);

struct Request {
    change: Option<(AppHandle, bool)>,
    reply: Sender<Reply>,
}

pub(super) fn start(app: &AppHandle, directory: tauri::Result<PathBuf>) {
    let (sender, mut requests) = channel::<Request>(8);
    app.manage(Settings(sender));
    let app = app.clone();
    spawn(async move {
        let path = directory
            .map(|dir| dir.join(FILE_NAME))
            .map_err(|error| error.to_string());
        let mut visible = false;
        if let Ok(path) = &path {
            let path = path.clone();
            let result = match disk(move || read_preference(&path)).await {
                Ok(true) => apply(&app, true).await.map(|()| true),
                Ok(false) => Ok(false),
                Err(error) => Err(error),
            };
            match result {
                Ok(initial) => visible = initial,
                Err(error) => eprintln!("Could not initialize the menu bar item: {error}"),
            }
        }
        drop(app);

        // Only this task orders disk commits and tray effects. No lock spans an AppKit call.
        while let Some(Request { change, reply }) = requests.recv().await {
            let result = match (change, &path) {
                (None, _) => Ok(visible),
                (Some((app, value)), Ok(path)) => {
                    save(&app, path.clone(), &mut visible, value).await
                }
                (Some(_), Err(error)) => Err(error.clone()),
            };
            let _ = reply.try_send(result);
        }
    });
}

pub(super) async fn state(app: &AppHandle, change: Option<bool>) -> Reply {
    let settings = app
        .try_state::<Settings>()
        .ok_or("The menu bar item is unavailable")?;
    let (reply, mut result) = channel(1);
    settings
        .0
        .try_send(Request {
            change: change.map(|value| (app.clone(), value)),
            reply,
        })
        .map_err(|_| "The menu bar item is busy or unavailable")?;
    result
        .recv()
        .await
        .ok_or_else(|| "The menu bar update did not finish".to_string())?
}

async fn disk<T: Send + 'static>(
    work: impl FnOnce() -> io::Result<T> + Send + 'static,
) -> Result<T, String> {
    spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

async fn save(app: &AppHandle, path: PathBuf, visible: &mut bool, value: bool) -> Reply {
    let directory = path
        .parent()
        .expect("menu bar preference has a parent directory")
        .to_path_buf();
    let staged = disk(move || {
        let mut file = tempfile::NamedTempFile::new_in(directory)?;
        file.write_all(if value { b"true\n" } else { b"false\n" })?;
        Ok(file)
    })
    .await?;
    let installing = value && !*visible;
    if installing {
        apply(app, true).await?;
    }
    if let Err(error) =
        disk(move || staged.persist(path).map(drop).map_err(|error| error.error)).await
    {
        if installing {
            apply(app, false).await?;
        }
        return Err(error);
    }
    if !value && *visible {
        apply(app, false).await?;
    }
    *visible = value;
    Ok(*visible)
}

async fn apply(app: &AppHandle, visible: bool) -> Result<(), String> {
    let handle = app.clone();
    let (reply, mut result) = channel(1);
    app.run_on_main_thread(move || {
        let outcome = if visible {
            install(&handle)
        } else {
            drop(handle.remove_tray_by_id(TRAY_ID));
            Ok(())
        };
        let _ = reply.try_send(outcome.map_err(|error| error.to_string()));
    })
    .map_err(|error| error.to_string())?;
    result
        .recv()
        .await
        .ok_or_else(|| "The tray update did not finish".to_string())?
}

fn install(app: &AppHandle) -> tauri::Result<()> {
    // The builder sizes its click target from the initial 18-point image.
    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu(app)?)
        .icon(Image::from_bytes(include_bytes!(
            "../icons/tray-template@2x.png"
        ))?)
        .icon_as_template(true)
        .build(app)?;
    let result = tray
        .with_inner_tray_icon(|tray| -> tauri::Result<()> {
            let mtm =
                MainThreadMarker::new().expect("menu bar installation runs on the main thread");
            let button = tray
                .ns_status_item()
                .and_then(|item| item.button(mtm))
                .ok_or_else(|| io::Error::other("The status item has no button"))?;
            let image = button
                .image()
                .ok_or_else(|| io::Error::other("The status item has no image"))?;
            let data = NSData::with_bytes(include_bytes!("../icons/tray-template.png"));
            let standard = NSBitmapImageRep::imageRepWithData(&data)
                .ok_or_else(|| io::Error::other("Invalid temporary menu bar icon"))?;
            let size = image.size();
            for representation in image.representations().iter() {
                representation.setSize(size);
            }
            standard.setSize(size);
            image.addRepresentation(&standard);
            button.setImage(Some(&image));
            Ok(())
        })
        .and_then(|outcome| outcome);
    if result.is_err() {
        drop(app.remove_tray_by_id(TRAY_ID));
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preference_defaults_when_missing_and_accepts_only_a_bounded_boolean_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(FILE_NAME);
        assert!(
            read_preference(&path).unwrap(),
            "missing preference defaults to on"
        );
        for (bytes, expected) in [(b"true\n".as_slice(), true), (b"false\n".as_slice(), false)] {
            std::fs::write(&path, bytes).unwrap();
            assert_eq!(read_preference(&path).unwrap(), expected);
        }
        for bytes in [b"null".as_slice(), b"{}", b"\"false\"", b"true false"] {
            std::fs::write(&path, bytes).unwrap();
            assert!(
                read_preference(&path).is_err(),
                "non-Boolean file was accepted"
            );
        }
        let mut oversized = b"true".to_vec();
        oversized.resize(4097, b' ');
        std::fs::write(&path, oversized).unwrap();
        assert!(
            read_preference(&path).is_err(),
            "oversized preference was accepted"
        );
        let symlink = directory.path().join("link");
        std::fs::write(&path, b"true").unwrap();
        std::os::unix::fs::symlink(&path, &symlink).unwrap();
        assert!(read_preference(&symlink).is_err(), "a symlink was followed");
        assert!(
            read_preference(directory.path()).is_err(),
            "a directory was accepted"
        );
    }
}
