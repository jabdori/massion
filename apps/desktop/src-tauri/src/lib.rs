// Massion desktop shell: 로컬 서버가 서빙하는 Web Console을 native window로 감싸고,
// WS-4 결정의 LocalShellCapabilities(폴더 선택·OS 알림)를 window.massionShell로 주입합니다.
// 화면 코드는 apps/web 단일 소스이며, shell은 얇은 wrapper로 유지합니다.
use std::net::TcpStream;
use std::process::Command;
use std::time::Duration;

const DEFAULT_PORT: u16 = 7331;

fn local_port() -> u16 {
    std::env::var("MASSION_LOCAL_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT)
}

fn server_reachable(port: u16) -> bool {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().expect("loopback 주소"),
        Duration::from_millis(500),
    )
    .is_ok()
}

// 서버가 내려가 있으면 사용자 권한으로 로컬 서버 기동을 시도합니다 (최대 15초 대기).
// massion CLI가 PATH에 없으면 콘솔 페이지가 연결 안내를 표시하도록 그대로 둡니다.
fn ensure_local_server(port: u16) {
    if server_reachable(port) {
        return;
    }
    let spawned = Command::new("massion").args(["local", "start"]).spawn();
    if spawned.is_err() {
        return;
    }
    for _ in 0..30 {
        if server_reachable(port) {
            return;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

// 원격(로컬 서버) 페이지에 주입되는 어댑터: apps/web의 local-shell 계약과 일치해야 합니다.
const SHELL_ADAPTER_INIT: &str = r#"
(function () {
  if (!window.__TAURI__) return;
  window.massionShell = {
    async pickDirectory() {
      const selected = await window.__TAURI__.dialog.open({ directory: true, multiple: false });
      return typeof selected === "string" ? selected : undefined;
    },
    notify(input) {
      try {
        window.__TAURI__.notification.sendNotification({ title: input.title, body: input.body });
      } catch {
        /* 알림 실패는 무시합니다 */
      }
    },
  };
})();
"#;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let port = local_port();
    ensure_local_server(port);
    let console_url: tauri::Url = format!("http://127.0.0.1:{port}/")
        .parse()
        .expect("콘솔 URL");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(move |app| {
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External(console_url.clone()),
            )
            .title("Massion")
            .inner_size(1280.0, 800.0)
            .initialization_script(SHELL_ADAPTER_INIT)
            .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Massion desktop shell 실행 실패");
}
