# Massion Desktop

[English](README.md) | [한국어](README.ko.md)

`apps/desktop`은 개인용 macOS AgentOS의 화면과 로컬 수명 주기를 소유합니다. 브라우저 fixture, Tauri 앱과 실제 daemon 연결은 같은 React 화면을 사용하지만 서로 다른 검증 경계입니다.

```text
React·Vite 렌더러
→ Tauri 호스트
→ Node.js bridge sidecar
→ loopback Massion daemon
→ SurrealDB
```

- 렌더러는 daemon URL, 인증 토큰과 범용 shell·filesystem 권한을 받지 않습니다.
- Tauri 호스트는 허용된 native 명령과 bridge 수명 주기만 소유합니다.
- bridge는 인증, Application query·command와 사건 스트림을 제한된 메시지로 변환합니다.
- daemon은 Work, 조직, 정책, 실행과 영속 상태의 정본을 소유합니다.
- 브라우저 개발 모드는 `createFixtureDesktopService()`를 사용하며 실제 Provider 또는 출시 동작을 증명하지 않습니다.

제품 전체 문서 분류는 [문서 지도](../../docs/README.ko.md), 화면의 시각·상호작용 원칙은 [DESIGN.ko.md](DESIGN.ko.md)를 따릅니다.

## 개발 실행

저장소 루트에서 실행합니다.

```sh
pnpm --filter @massion/desktop dev
pnpm --filter @massion/desktop test
pnpm --filter @massion/desktop typecheck
pnpm --filter @massion/desktop tauri:dev
```

`dev`는 시연 데이터(fixture)를 사용하는 브라우저 화면입니다. 실제 로컬 수명 주기와 native picker, bridge, daemon, 재시작 보존은 `tauri:dev` 또는 릴리스 후보 앱에서 별도로 검증해야 합니다.
