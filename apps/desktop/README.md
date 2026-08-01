# Massion Desktop

Massion의 독립 React·Vite 렌더러와 Tauri 호스트입니다. 렌더러는 번들 안에서 실행되고, Tauri 호스트가 Node.js 브리지(sidecar)를 통해 로컬 daemon의 제한된 조회(query)·명령(command)·사건 스트림(event stream) 계약만 전달합니다.

- `src`: 데스크톱 화면과 사용자 상호작용
- `src-tauri`: 창, 허용된 네이티브 명령, 브리지 수명 주기와 패키징
- `apps/desktop-bridge`: 인증과 Application HTTP/SSE 변환

## 빌드·실행

```sh
pnpm --filter @massion/desktop tauri:dev
pnpm --filter @massion/desktop test
pnpm --filter @massion/desktop typecheck
```

설치 후보는 `pnpm --filter @massion/desktop tauri:build`로 생성합니다. 공개 릴리스에는 별도 서명·공증·설치 검증이 필요합니다.
