# Phase 24 구독 UAT 증거 — 2026-07-14

> **실행 방식**: 검증된 local release archive를 격리된 tmux 세션에서 실행
> **민감정보**: 원시 pane 출력·계정 식별자·인증정보·개인 경로를 저장하지 않음

## 계보

- Git commit: `00f77e6f8471895694b2e3600b85f2ee0dad4a5d`
- Local release archive: `sha256:54b4c151d8bb819b5a305c45a57f41a7b7dd657007982bd9eb2b558540ea23bf`
- UAT receipt: `sha256:f3f5f5d852f96d1952de52cffedf8053830e21ba1a9c3304d736009ddefaabb3`
- Receipt schema: `massion.subscription-uat.v1`
- Receipt summary: `passed: 1`, `failed: 1`, `not-run: 9`

## 통과한 흐름

- release 설치·version 확인
- bundled Connector doctor
- local daemon 시작·owner 초기화·readiness
- provider catalog·event watch
- Codex OAuth 데이터 처리 고지 동의와 로그인
- Codex account·doctor·quota·adaptive policy 조회
- daemon 재시작·owner-only backup/restore·uninstall 후 data 보존

## 외부 의존성으로 미완료인 흐름

- Codex `run subscription acceptance`: 180초 제한에 도달해 `network` 실패로 분류
- Claude consumer login: `provider-approval-required`
- Z.AI Coding Plan: `provider-approval-required` (공식 지원 도구·서면 계약 근거 전까지 fail-closed)
- 두 번째 계정·두 번째 사용자·공개 failure injection·승인 재개: 외부 전제조건 필요

실제 Codex 인증은 이번 실행에서 완료되었지만, 모델 실행 응답이 제한시간 안에 도착하지 않았습니다. 따라서 실행 계보·fallback·역할별 평가를 성공으로 기록하지 않았습니다.
