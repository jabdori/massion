# Massion Desktop Shell

로컬 Massion 서버가 서빙하는 Web Console을 native window로 감싸는 Tauri shell입니다.
[WS-4 결정](../../docs/phases/30-surface-parity-agent-ux/ws4-web-role-decision.md)에 따라
화면 코드는 `apps/web` 단일 소스이고, 이 패키지는 다음만 소유합니다.

- 로컬 서버 미기동 시 `massion local start` 기동 시도 후 `http://127.0.0.1:7331` 로드
- `window.massionShell` 주입: 폴더 선택(dialog)·OS 알림(notification) — `apps/web/src/local-shell.ts` 계약

## 빌드·실행

```sh
cd apps/desktop/src-tauri
cargo build            # 개발 빌드
cargo run              # shell 실행 (서버가 없으면 기동 시도)
```

번들(설치 파일)은 `cargo tauri build`(tauri-cli 필요)로 생성하며, 서명·배포는 릴리스 파이프라인 결정 후 연결합니다.
