// Massion desktop shell: 로컬 서버가 서빙하는 Web Console을 native window로 감쌉니다.
// TUI와 동일한 "OS 사용자 로컬 신뢰" 모델 — 로그인 화면 없이, massion CLI가 로컬 profile
// 토큰으로 인증된 콘솔 URL(코드 포함)을 발급하고 shell이 그 URL을 그대로 로드합니다.
// 화면 코드는 apps/web 단일 소스이며 shell은 얇은 wrapper로 유지합니다(WS-4 결정).
use std::path::PathBuf;
use std::process::Command;

const DEFAULT_PORT: u16 = 7331;

fn local_port() -> u16 {
    std::env::var("MASSION_LOCAL_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT)
}

// GUI 앱은 셸 PATH를 물려받지 않으므로 massion 실행 파일 후보를 순서대로 시도합니다.
fn massion_candidates() -> Vec<PathBuf> {
    let mut candidates = vec![PathBuf::from("massion")];
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(PathBuf::from(format!("{home}/.local/bin/massion")));
    }
    candidates.push(PathBuf::from("/usr/local/bin/massion"));
    candidates
}

// massion --web --print-url: 로컬 서버를 보장하고 인증된 콘솔 URL(코드 포함)을 stdout에 출력합니다.
// TUI처럼 로그인 마찰 없이 바로 인증된 상태로 콘솔을 띄우기 위한 것입니다.
fn authenticated_console_url() -> Option<String> {
    for candidate in massion_candidates() {
        let output = Command::new(&candidate).args(["--web", "--print-url"]).output();
        if let Ok(output) = output {
            if output.status.success() {
                let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if url.starts_with("http://") || url.starts_with("https://") {
                    return Some(url);
                }
            }
        }
    }
    None
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
    // 인증된 URL을 우선 사용하고, CLI가 없거나 미초기화면 콘솔 루트로 폴백합니다.
    // (폴백 시 콘솔이 로그인/초기화 안내를 표시합니다.)
    let target = authenticated_console_url().unwrap_or_else(|| format!("http://127.0.0.1:{port}/"));
    let console_url: tauri::Url = target.parse().expect("콘솔 URL");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(move |app| {
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(console_url.clone()))
                .title("Massion")
                .inner_size(1280.0, 800.0)
                .initialization_script(SHELL_ADAPTER_INIT)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Massion desktop shell 실행 실패");
}
