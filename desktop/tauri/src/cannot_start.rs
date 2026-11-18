use std::path::Path;

use tauri::http;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CannotStartReason {
    ConnectionUnavailable,
    ConnectionClosed,
    DataDirectoryEnterFailed,
}

impl CannotStartReason {
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::ConnectionUnavailable => "start-connection-unavailable",
            Self::ConnectionClosed => "start-connection-closed",
            Self::DataDirectoryEnterFailed => "data-directory-enter-failed",
        }
    }
}

pub(crate) const TITLE: &str = "문제가 발생했습니다";
pub(crate) const MESSAGE: &str = "로컬 서버를 시작하지 못했습니다.";
pub(crate) const DETAILS_LABEL: &str = "기술 세부 정보";
pub(crate) const COPY_LABEL: &str = "복사";

pub(crate) const STYLE: &str = r#":root{color-scheme:light dark;--bg-0:#ffffff;--bg-1:#f9f9f9;--bg-2:#f3f3f3;--line:#cdcdcd;--line-strong:#8f8f8f;--fg:#131313;--fg-2:#303030;--fg-3:#414141;--fg-4:#5d5d5d;--halt:#ba2623;--focus-width:2px;--focus-ring:var(--fg-4);--focus-offset:4px;--motion-fast:.12s;--motion-ease:cubic-bezier(.32,.72,0,1);--font-sans:"Pretendard Variable",Pretendard,Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--font-mono:ui-monospace,SFMono-Regular,Menlo,monospace}
@media (prefers-color-scheme:dark){:root{--bg-0:#0b0c0e;--bg-1:#15171a;--bg-2:#1b1d20;--line:#2b2d30;--line-strong:#3a3c3f;--fg:#f4f5f7;--fg-2:#c8cdd6;--fg-3:#a2a8b4;--fg-4:#838993;--halt:#f5766e}}
@media (prefers-reduced-motion:reduce){:root{--motion-fast:0s}}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--bg-0);color:var(--fg);font-family:var(--font-sans);font-synthesis:none}
.cannot-start{width:min(440px,100%);text-align:center}
.icon{display:grid;place-items:center;width:44px;height:44px;margin:0 auto 16px;border:1px solid var(--line);border-radius:12px;background:var(--bg-2);color:var(--halt)}
h1{margin:0 0 8px;font-size:20px;line-height:28px;font-weight:600;color:var(--fg)}
.message{margin:0 0 24px;font-size:14px;line-height:22px;color:var(--fg-3)}
.details{text-align:left;border:1px solid var(--line);border-radius:10px;background:var(--bg-1);padding:10px 14px}
.details summary{cursor:pointer;font-size:13px;line-height:20px;font-weight:600;color:var(--fg-2);user-select:none;-webkit-user-select:none}
.details-body{margin-top:10px;display:grid;gap:10px}
.details-text{margin:0;padding:10px 12px;border:1px solid var(--line);border-radius:7px;background:var(--bg-2);color:var(--fg-2);font:12px/1.55 var(--font-mono);white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;-webkit-user-select:text}
.copy-button{justify-self:end;min-height:30px;padding:4px 12px;border:1px solid var(--line-strong);border-radius:7px;background:var(--bg-0);color:var(--fg);font:400 12px/20px var(--font-sans);cursor:pointer;transition:background var(--motion-fast) var(--motion-ease)}
.copy-button:hover{background:var(--bg-2)}
summary:focus-visible,.details-text:focus-visible,.copy-button:focus-visible{outline:var(--focus-width) solid var(--focus-ring);outline-offset:var(--focus-offset)}"#;

pub(crate) const SCRIPT: &str = r#"(() => {
 const button = document.getElementById('copy-details');
 const details = document.getElementById('technical-details');
 if (!button || !details) return;
 button.addEventListener('click', async () => {
  const text = details.textContent || '';
  if (!text) return;
  try {
   if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(text);
    return;
   }
  } catch {}
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(details);
  selection.removeAllRanges();
  selection.addRange(range);
  try {
   document.execCommand('copy');
  } catch {}
 });
})();"#;

// 정적 인라인 style/script의 SHA-256 해시만 허용하고 네트워크·프레임·연결을 모두 차단한다.
pub(crate) const CONTENT_SECURITY_POLICY: &str = "default-src 'none'; script-src 'sha256-2dDmxTgjsjU42A/wmI73mM5vABWqx+GIMwzm4Tc0Mss='; style-src 'sha256-9DPKawprMFUT9mu6cL4mBFjBL13swjPVn8KvxUW+jk8='; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

fn escape_html(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(ch),
        }
    }
    escaped
}

pub(crate) fn render_html(reason: CannotStartReason, log_path: Option<&Path>) -> String {
    let details = match log_path.filter(|path| path.is_file()) {
        Some(path) => format!("{}\n{}", reason.code(), path.display()),
        None => reason.code().to_string(),
    };
    let escaped_details = escape_html(&details);
    format!(
        "<!doctype html>\n\
<html lang=\"ko\">\n\
<head>\n\
<meta charset=\"utf-8\">\n\
<meta name=\"color-scheme\" content=\"light dark\">\n\
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
<title>{title}</title>\n\
<style>{style}</style>\n\
</head>\n\
<body>\n\
<main class=\"cannot-start\" role=\"main\">\n\
<div class=\"icon\" aria-hidden=\"true\"><svg width=\"22\" height=\"22\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z\"/><line x1=\"12\" y1=\"9\" x2=\"12\" y2=\"13\"/><line x1=\"12\" y1=\"17\" x2=\"12.01\" y2=\"17\"/></svg></div>\n\
<h1>{title}</h1>\n\
<p class=\"message\">{message}</p>\n\
<details class=\"details\">\n\
<summary>{details_label}</summary>\n\
<div class=\"details-body\">\n\
<pre id=\"technical-details\" class=\"details-text\" tabindex=\"0\">{escaped_details}</pre>\n\
<button id=\"copy-details\" type=\"button\" class=\"copy-button\">{copy_label}</button>\n\
</div>\n\
</details>\n\
</main>\n\
<script>{script}</script>\n\
</body>\n\
</html>\n",
        title = escape_html(TITLE),
        message = escape_html(MESSAGE),
        details_label = escape_html(DETAILS_LABEL),
        copy_label = escape_html(COPY_LABEL),
        escaped_details = escaped_details,
        style = STYLE,
        script = SCRIPT,
    )
}

pub(crate) fn response(reason: CannotStartReason, log_path: Option<&Path>) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(503)
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Content-Security-Policy", CONTENT_SECURITY_POLICY)
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(render_html(reason, log_path).into_bytes())
        .unwrap()
}
