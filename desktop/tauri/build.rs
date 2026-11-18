fn main() {
    // App commands get an allow-$command/deny-$command permission generated;
    // capabilities/main.json lists exactly the ones the client needs.
    let attributes = tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_settings",
            "desktop_save_notifications",
            "desktop_restart",
            "desktop_relaunch",
            "desktop_ready",
            "desktop_events_subscribe",
            "desktop_events_close",
        ]),
    );
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
