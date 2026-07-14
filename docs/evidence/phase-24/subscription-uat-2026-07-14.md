# Phase 24 구독 UAT 증거 — 2026-07-14

> **실행 방식**: 검증된 local release archive를 격리된 tmux 세션에서 실행
> **민감정보**: 원시 pane 출력·계정 식별자·인증정보·개인 경로를 저장하지 않음

## 현재 source commit lifecycle UAT — 2026-07-14

- Git commit: `bf92127f78ce62f15f75ca20f5611dc1ea388ddc`
- Local release archive: `sha256:f55c09d9866164b16d4c32860c7d4b206437a8552055b12302d2655a804bb950`
- UAT receipt: `sha256:fa6b48dfa20e76d6ff31d1ad7d782770c50670dd0189a8dbc922308dcb573aa2`
- Receipt summary: `passed: 1`, `failed: 0`, `not-run: 9`

최신 source commit의 release를 격리된 `tmux`에서 설치해 version·Connector doctor·local 시작·owner 초기화·readiness·provider catalog·event watch·재시작·owner-only backup·복원·uninstall 후 data 보존을 확인했습니다. Codex 제공자 시나리오는 새 격리 profile에서 사용자 인증 입력이 필요하므로 `interactive-login-required`로 기록했으며, 인증 성공으로 추정하지 않았습니다. 실행 뒤 UAT driver·격리 server·tmux session은 남지 않았습니다.

## 최신 실제 Codex UAT — 2026-07-14

- Git commit: `64d1e83576f811bf80c8077e5183e27e40b4508b`
- Release manifest source digest: `sha256:799af64dfda8db445be1ca5001a79d3b0ed79c27cf462e24ced578ffaacf16da`
- Local release archive: `sha256:d95896feaa642b6410ede7e806d1ee4c48cfc6332a41fd7ee0c349dcf0e3d2d9`
- UAT receipt: `sha256:48f3e62612222022485009ee04cdd57e0613ee681095dac52008428b9c1bee90`
- Receipt summary: `passed: 1`, `failed: 1`, `not-run: 9`

이번 실행은 경로에 공백이 포함된 격리 작업공간에서 UAT 드라이버 자체도 `tmux`로 실행했습니다. 설치·version·Connector doctor·local 시작·owner 초기화·readiness·provider catalog·event watch·재시작·owner-only backup·복원 서버 시작·복원 readiness·uninstall 후 data 보존을 모두 통과했습니다. UAT 종료 뒤 격리 tmux·server 프로세스가 남지 않았습니다.

Codex 연결, account·doctor·quota 조회, `adaptive` 자동 승인 정책 설정·조회는 통과했습니다. 실제 `subscription acceptance` 실행은 15분 제한 내 terminal event를 받지 못해 종료 코드 `124`, 분류 `network`으로 실패했습니다. timeout 뒤 같은 상관관계 ID의 공개 runtime 계보 조회는 종료 코드 `65`로 실패했습니다. 이 값은 원시 출력이나 계정 정보를 저장하지 않는 UAT 관찰 계약 실패를 뜻하며, 실제 제공자·제품 원인을 확정하는 근거로 사용하지 않습니다.

## 계보

아래는 이전 외부 Provider UAT 시도의 보존 기록입니다.

- Git commit: `00f77e6f8471895694b2e3600b85f2ee0dad4a5d`
- Local release archive: `sha256:54b4c151d8bb819b5a305c45a57f41a7b7dd657007982bd9eb2b558540ea23bf`
- UAT receipt: `sha256:f3f5f5d852f96d1952de52cffedf8053830e21ba1a9c3304d736009ddefaabb3`
- Receipt schema: `massion.subscription-uat.v1`
- Receipt summary: `passed: 1`, `failed: 1`, `not-run: 9`

## 이전 외부 Provider UAT에서 통과한 흐름

- release 설치·version 확인
- bundled Connector doctor
- local daemon 시작·owner 초기화·readiness
- provider catalog·event watch
- 공식 Codex OAuth 로그인
- Codex account·doctor·quota·adaptive policy 조회
- daemon 재시작·owner-only backup/restore·uninstall 후 data 보존

## 외부 의존성으로 미완료인 흐름

- Codex `run subscription acceptance`: 180초 제한에 도달해 `network` 실패로 분류
- Claude consumer login: `provider-approval-required`
- Z.AI Coding Plan: `provider-approval-required` (공식 지원 도구·서면 계약 근거 전까지 fail-closed)
- 두 번째 계정·두 번째 사용자·공개 failure injection·승인 재개: 외부 전제조건 필요

최신 실제 Codex UAT에서도 인증과 연결은 완료됐지만 모델 실행 응답이 제한시간 안에 도착하지 않았습니다. 따라서 실행 계보·fallback·역할별 평가를 성공으로 기록하지 않았습니다.

> 현재 제품에서는 Massion의 데이터 처리 고지·동의 화면을 제공하지 않습니다. OpenAI 계정의 데이터 제어는 사용자가 OpenAI에서 직접 선택하며, 이 역사 기록의 로그인 역시 이를 대리 확인하거나 기록하는 절차가 아닙니다.
