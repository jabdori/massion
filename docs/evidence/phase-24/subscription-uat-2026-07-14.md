# Phase 24 구독 UAT 증거 — 2026-07-14

> **실행 방식**: 검증된 local release archive를 격리된 tmux 세션에서 실행
> **민감정보**: 원시 pane 출력·계정 식별자·인증정보·개인 경로를 저장하지 않음

## 최신 local lifecycle 재검증 — 2026-07-14

- Git commit: `584fdb72b78bf9f2451932af4028c2f0a123bb6a`
- Release manifest source digest: `sha256:1a705c9545f54abe8ed806e85b424b5be04ca209f7e0809cca3a4171a7231157`
- Local release archive: `sha256:a9bf059c11cdd50f2fda026170efdb6fa7e6ace00fdbd3f9f66565734ada6611`
- UAT receipt: `sha256:4bad0bc7039f7060d888690f5c8e88efc1500817258c592420b74566f65a664a`
- Receipt summary: `passed: 1`, `failed: 0`, `not-run: 9`

이번 실행은 경로에 공백이 포함된 격리 작업공간에서 `tmux`로 수행했습니다. 설치·version·Connector doctor·local 시작·owner 초기화·readiness·provider catalog·event watch·재시작·owner-only backup·복원 서버 시작·복원 readiness·uninstall 후 data 보존을 모두 통과했습니다. 복원 command와 복원 server는 상대 RocksDB URL(`rocksdb://./massion.db`)과 복원 directory 작업 디렉터리를 사용했습니다.

Codex·Claude·Z.AI 실제 Provider 실행은 이 실행에서 시작하지 않았습니다. Codex OAuth·실행 응답에 대한 이전 시도는 아래 역사 기록처럼 네트워크 timeout으로 실패했으며, 계정 회전·fallback·승인 재개 시나리오는 외부 전제조건이 남아 있습니다.

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
- Codex OAuth 데이터 처리 고지 동의와 로그인
- Codex account·doctor·quota·adaptive policy 조회
- daemon 재시작·owner-only backup/restore·uninstall 후 data 보존

## 외부 의존성으로 미완료인 흐름

- Codex `run subscription acceptance`: 180초 제한에 도달해 `network` 실패로 분류
- Claude consumer login: `provider-approval-required`
- Z.AI Coding Plan: `provider-approval-required` (공식 지원 도구·서면 계약 근거 전까지 fail-closed)
- 두 번째 계정·두 번째 사용자·공개 failure injection·승인 재개: 외부 전제조건 필요

최신 local lifecycle에서는 실제 Provider 실행을 시작하지 않았습니다. 이전 외부 Codex UAT 시도에서는 인증이 완료되었지만 모델 실행 응답이 제한시간 안에 도착하지 않았습니다. 따라서 실행 계보·fallback·역할별 평가를 성공으로 기록하지 않았습니다.
