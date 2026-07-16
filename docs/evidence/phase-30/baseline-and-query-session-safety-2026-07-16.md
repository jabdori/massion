# Phase 30 — 기준선과 Web query·session 안전성 검증

> **검증일**: 2026-07-16
> **기준 source commit**: `716fd08c1670`
> **구현 브랜치**: `feat/phase-30-parity-ux`
> **환경**: macOS 26.1 arm64, Node.js 24.8.0, pnpm 11.13.0

## 1. 기준선

격리된 worktree에서 고정된 lockfile을 사용해 의존성을 설치한 뒤 다음 명령을 실행했습니다.

```sh
pnpm install --frozen-lockfile --offline
pnpm verify
```

두 명령은 종료 코드 0이었습니다. `pnpm verify`는 format 검사, 전체 workspace build, ESLint, 형 검사(typecheck), root 85개 테스트, 모든 workspace 테스트, Web 18개 테스트, TUI 54개 Vitest와 13개 Bun renderer 테스트, 문서 검증을 포함했습니다.

## 2. Web query resource RED → GREEN

실패 테스트를 먼저 추가해 다음 결함을 재현했습니다.

- 같은 operation의 서로 다른 payload가 같은 결과·오류 슬롯을 공유했습니다.
- 늦게 끝난 오래된 요청이 최신 응답을 덮을 수 있었습니다.
- 초기 snapshot·audit이 모두 실패해도 준비 완료 상태가 될 수 있었습니다.
- 커서가 0일 때 순번이 큰 첫 사건을 간격 검사 없이 수락했습니다.
- 성숙 조직에서 감사 이력(audit)을 항상 0부터 1,000건만 읽어 복구하지 못했습니다.
- 동시 사건 간격(gap)의 목표가 높아지면 낮은 목표에서 복구를 끝내거나 실패했습니다.
- 오래된 재동기화가 실패해도 최신 snapshot만 있으면 사건 복구를 성공으로 오인했습니다.
- 현재 커서가 서버의 사건 보존 하한(retention floor)보다 오래되면 복구 진입점이 없었습니다.
- SSE 서버가 만료 cursor를 확인하기 전에 HTTP 200 header를 열어 연결만 끊었고, Web은 같은 cursor로 무한 재시도했습니다.
- 초기 load의 오래된 snapshot 실패가 더 최신 snapshot 성공을 무효화했습니다.
- 조회 getter가 React render 중 cache 접근 순서를 변경했습니다.
- 사건 크기 제한이 매 반복마다 전체 배열을 직렬화했습니다.

보정 뒤 다음 계약을 검증했습니다.

- query identity는 operation과 JSON 전송 의미로 정규화한 payload를 함께 사용합니다.
- payload별 data·error·요청 generation을 분리하고 최신 성공만 상태에 반영합니다.
- snapshot과 audit cursor가 새 요청 generation에서 확보돼야 초기 상태가 준비 완료가 됩니다.
- 사건 간격은 현재 cursor 뒤부터 최대 1,000건씩 이어 읽고, 동시 목표 상승도 추가로 복구합니다.
- 보존 하한 만료는 공개 충돌 오류 `APP_EVENT_CURSOR_EXPIRED`로 변환하고, 새 snapshot과 함께 `after: 0`에서 보존 중인 첫 사건으로 재진입합니다.
- SSE는 첫 사건 조회가 성공한 뒤에만 HTTP 200 stream을 열며, 만료 409를 받은 Web은 snapshot·audit 복구 뒤 새 cursor로 즉시 재연결합니다.
- stale 재동기화는 목표 cursor가 실제로 복구되지 않으면 성공으로 반환하지 않습니다.
- 화면이 유지한 query만 전역 오류에 노출하며 비활성 resource는 요청·retain 기준 soft limit으로 정리합니다.
- 사건은 최대 1,000개·UTF-8 4 MiB를 단일 역방향 순회로 제한합니다.

검증 명령과 결과는 다음과 같습니다.

```sh
pnpm --filter @massion/web test
# 8 files, 54 passed

pnpm --filter @massion/web typecheck
pnpm --filter @massion/web build
# 17개 Web chunk가 250 KiB budget 안, 모두 exit 0
```

## 3. Web session 복구 계약 RED → GREEN

브라우저 로그인 교환 응답은 발급·절대 만료·비활성 만료 시각을 제공했지만, 기존 Cookie를 복구하는 `GET /api/v1/web/session` 응답은 세 필드를 누락했습니다. Web decoder는 이를 필수로 검사하므로 유효한 기존 세션도 새로고침 뒤 익명으로 오인될 수 있었습니다.

인증 결과와 HTTP 복구 응답에 `issuedAt`, `expiresAt`, `idleExpiresAt`을 연결하고, 인증 때 갱신된 비활성 만료 시각이 절대 만료를 넘지 않는 기존 서비스 계약을 그대로 사용했습니다.

```sh
pnpm --filter @massion/application test
# 43 files passed, 2 skipped; 168 passed, 2 skipped

pnpm --filter @massion/application typecheck
# exit 0
```

## 4. 정적 검증

이번 변경 파일 전체에 ESLint, Prettier와 Git 공백 검사를 실행해 종료 코드 0을 확인했습니다.

```sh
pnpm exec eslint <changed TypeScript files>
pnpm exec prettier --check <changed TypeScript files>
git diff --check
```

최신 코드 상태에서 전체 저장소 게이트도 다시 실행해 종료 코드 0을 확인했습니다.

```sh
pnpm verify
```

전체 format, 30개 workspace build, ESLint, 형 검사, root 85개 테스트, 모든 workspace 테스트, Server 215개 테스트와 2개 제외, TUI 54개 Vitest·13개 Bun renderer 테스트, Web 54개 테스트와 문서 구조 검증이 통과했습니다.

독립 사양 검토와 품질 검토는 모두 Critical·Important 0건으로 PASS했습니다. 품질 검토의 비차단 Minor 1건은 제품 설정으로 노출하지 않은 query resource soft limit을 `1~3`으로 직접 주입할 때 초기 필수 resource가 정리될 수 있다는 내부 시험 설정 경계입니다. 기본값은 256입니다.

## 5. 추적 상태

- query identity 1차 구현 commit: `04697d4`
- 최신 응답 우선 처리 commit: `548835a`
- query resource lifecycle 1차 보강 commit: `cbe2698`
- 동시 gap·보존 하한·SSE·session 복구 보정 commit: `30caaca`

Phase 30 전체 완료 증거가 아닙니다. 이 문서는 구현 계획 Task 1과 Task 2 중 Web P0 안전성 범위만 증명합니다.
