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

// GUI로 실행된 앱은 최소 PATH(/usr/bin:/bin:…)만 가지므로 massion 래퍼가 의존하는
// node·bun(mise/homebrew 등에 설치)을 찾지 못해 실패합니다. CLI를 spawn할 때
// 사용자 툴체인·표준 위치를 PATH에 보강해 이를 해결합니다.
fn augmented_path() -> String {
    let mut dirs: Vec<String> = Vec::new();
    if let Ok(home) = std::env::var("HOME") {
        dirs.push(format!("{home}/.local/bin"));
        dirs.push(format!("{home}/.local/share/mise/shims"));
    }
    dirs.push("/opt/homebrew/bin".to_string());
    dirs.push("/usr/local/bin".to_string());
    if let Ok(existing) = std::env::var("PATH") {
        for part in existing.split(':') {
            if !part.is_empty() {
                dirs.push(part.to_string());
            }
        }
    }
    for standard in ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
        dirs.push(standard.to_string());
    }
    // 순서를 유지하며 중복을 제거합니다.
    let mut seen = std::collections::HashSet::new();
    dirs.into_iter().filter(|dir| seen.insert(dir.clone())).collect::<Vec<_>>().join(":")
}

// 데스크톱 세션: 로컬 서버를 보장하고 티켓을 서버측에서 교환한 세션 쿠키를 확보합니다.
// WKWebView는 fetch 응답의 Set-Cookie를 신뢰성 있게 저장하지 못하므로(브라우저는 정상),
// 코드→쿠키 교환을 브라우저가 아니라 CLI에서 수행하고 shell이 그 쿠키를 document.cookie로
// 주입한 뒤 콘솔 root를 로드합니다. TUI처럼 로그인 마찰 없이 인증 상태로 진입하기 위함입니다.
struct DesktopSession {
    origin: String,
    cookie: String,
    max_age_seconds: u64,
}

fn desktop_session() -> Option<DesktopSession> {
    let path = augmented_path();
    for candidate in massion_candidates() {
        let output = Command::new(&candidate)
            .args(["--web", "--print-session"])
            .env("PATH", &path)
            .output();
        if let Ok(output) = output {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(text.trim()) {
                    let origin = value.get("origin").and_then(serde_json::Value::as_str);
                    let cookie = value.get("cookie").and_then(serde_json::Value::as_str);
                    let max_age = value.get("maxAgeSeconds").and_then(serde_json::Value::as_u64).unwrap_or(900);
                    if let (Some(origin), Some(cookie)) = (origin, cookie) {
                        if origin.starts_with("http://") || origin.starts_with("https://") {
                            return Some(DesktopSession {
                                origin: origin.to_string(),
                                cookie: cookie.to_string(),
                                max_age_seconds: max_age,
                            });
                        }
                    }
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

// 세션 쿠키를 document.cookie로 주입하는 초기화 스크립트를 만듭니다.
// 페이지의 다른 스크립트보다 먼저(document-start) 실행되므로, 앱이 recoverSession을
// 호출할 시점엔 이미 인증 쿠키가 존재해 로그인 화면 없이 콘솔로 진입합니다.
fn cookie_init_script(session: &DesktopSession) -> String {
    let document_cookie = format!("{}; path=/; max-age={}; samesite=lax", session.cookie, session.max_age_seconds);
    // 토큰 값에 특수문자가 있어도 안전하도록 JSON 문자열 리터럴로 escape합니다.
    let literal = serde_json::to_string(&document_cookie).unwrap_or_else(|_| "\"\"".to_string());
    format!("try {{ document.cookie = {literal}; }} catch (_) {{}}")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let port = local_port();
    let session = desktop_session();
    // 세션을 확보하면 쿠키를 주입하고 콘솔 root를 로드합니다.
    // 확보하지 못하면(예: 서버 미기동) 콘솔 root로 폴백해 로그인/초기화 안내를 표시합니다.
    let target = session
        .as_ref()
        .map(|s| format!("{}/", s.origin.trim_end_matches('/')))
        .unwrap_or_else(|| format!("http://127.0.0.1:{port}/"));
    let console_url: tauri::Url = target.parse().expect("콘솔 URL");
    let init_script = match &session {
        Some(s) => format!("{}\n{SHELL_ADAPTER_INIT}", cookie_init_script(s)),
        None => SHELL_ADAPTER_INIT.to_string(),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(move |app| {
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(console_url.clone()))
                .title("Massion")
                .inner_size(1280.0, 800.0)
                .initialization_script(&init_script)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Massion desktop shell 실행 실패");
}
