# Phase 30 — WS-4: Web의 역할과 GUI 경계 결정

> **상태**: superseded — 독립 데스크톱 결정으로 대체됨
> **판정일**: 2026-07-21
> **관계**: [에이전틱 도구 UX 벤치마크와 재설계 계획](agent-ux-benchmark-and-redesign-plan.md)의 WS-4 슬라이스
> **대체 문서**: [조직·Work·성장을 운영하는 독립 AgentOS 데스크톱 ADR](../../architecture/desktop-clean-sheet.md)

이 문서는 2026-07-21 당시 판단의 이력을 보존합니다. `apps/web` 화면을 GUI에 재사용하는 결정은 더 이상 활성 결정이 아니며 새 구현과 검토 근거로 사용하지 않습니다.

## 1. 결정 요약

Web과 GUI는 **별도 제품이 아니라 같은 화면(`apps/web`)의 두 배포 형태**입니다. Codex·Claude Code에서 확인한 "Web UI ≈ Desktop UI" 패턴을 따르며, 차이는 화면이 아니라 **접속 경로·인증·로컬 능력**에만 둡니다.

| 형태 | 접속 | 인증 | 스코프 | 로컬 능력 |
|---|---|---|---|---|
| 로컬 Web Console (현재) | `massion --web` → loopback | 5분 로그인 티켓 → access token | 전역 (모든 워크스페이스) | 없음 (브라우저 sandbox) |
| 팀 원격 Web (현재) | TLS 역방향 프록시 | 동일 token 체계, 조직 Membership | 전역, tenant 격리 | 없음 |
| GUI (WS-3, 예정) | native shell이 로컬 서버 자동 기동 후 내장 webview | 로컬 티켓 흐름 재사용 | 전역 + 워크스페이스 sidebar | 폴더 선택 dialog · OS 알림 · tray · 서버 수명 관리 |
| 관리형 Cloud | 1.0 범위 밖 | — | — | — |

## 2. 코드 공유 경계 (구현됨 + 규칙)

### 2.1 브라우저 안전 진입점 (구현됨)

`packages/application/src/browser.ts`가 Web이 소비할 수 있는 유일한 `@massion/application` 표면입니다. `apps/web`의 Vite alias가 이 파일을 가리키며, 다음만 재노출합니다.

- design token (상태·역할·단계 토큰)
- Surface 팔레트 계약 (`SURFACE_PALETTE_ITEMS`, `filterPaletteItems`)
- timeline 셀 계약 (`workTimelineCellToken`, 셀 타입)

**규칙**: 서버 전용 의존성(surrealdb, node:*)을 끌어들이는 모듈은 browser.ts에서 재노출하지 않습니다. Web에 새 공용 계약이 필요하면 순수 모듈로 만들고 browser.ts에 추가합니다.

### 2.2 로컬 능력 어댑터 (WS-3에서 구현)

GUI 고유 기능은 화면 코드에 분기하지 않고 **주입 가능한 어댑터 인터페이스**로 격리합니다.

```ts
interface LocalShellCapabilities {
  pickDirectory?(): Promise<string | undefined>; // 워크스페이스 등록용 폴더 선택
  notify?(input: { title: string; body: string }): void; // OS 알림
  serverLifecycle?: { ensureRunning(): Promise<void> };
}
```

- 브라우저: 어댑터 부재 → 경로 직접 입력(현행 /workspaces), Notification API 옵트인
- GUI(Tauri): shell이 어댑터 구현을 주입

### 2.3 WS-3 spike 계획 (다음 단계)

1. Tauri 2.x로 `apps/web` dist를 감싸는 최소 shell — Rust toolchain 필요, CI 별도 판정
2. Electron 대안 비교: 크기·서명·자동 갱신 비용
3. 판정 기준: 로컬 서버 자동 기동 + 폴더 선택 + 알림 3개가 동작하면 채택

## 3. 인증 경계

- 로컬·팀 모두 **기존 access token 체계 하나**를 사용합니다. GUI도 새 인증을 만들지 않고 로컬 티켓 흐름(`massion --web`과 동일)을 재사용합니다.
- 원격 Web에서 워크스페이스 경로는 **서버 기준 로컬 경로**임을 UI에 명시합니다 (원격 사용자의 로컬 디렉토리가 아님). workspace kind가 `local-directory` 하나인 동안 원격 팀 배포에서는 등록 UI를 owner·admin에게만 노출하는 것을 권장합니다 (신뢰 결정 권한과 동일).

## 4. 향후 Cloud와의 호환

관리형 Cloud는 1.0 범위 밖이지만, 이 결정이 남기는 호환 계약은 다음과 같습니다: Surface는 Application API(HTTP·SSE)와 browser.ts 계약만 소비하므로, Cloud가 같은 API를 제공하면 `apps/web`은 접속 대상만 바뀝니다. GUI의 로컬 능력 어댑터는 Cloud 접속 시 자동으로 비활성(부재) 처리됩니다.
