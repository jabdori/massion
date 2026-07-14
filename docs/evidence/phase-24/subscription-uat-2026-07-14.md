# Phase 24 구독 UAT 증거 — 2026-07-14

> **실행 방식**: 검증된 local release archive를 격리된 tmux 세션에서 실행
> **민감정보**: 원시 pane 출력·계정 식별자·인증정보·개인 경로를 저장하지 않음

## 현재 source commit lifecycle UAT — 2026-07-14

- Git commit: `26cac867dec17b36370e80d98d4e9d1813c7db96`
- Release manifest source digest: `sha256:f00e5d9396ff3beeef9f36eddb231e5b5d07d76ac51618da5d38bd582b7771b1`
- Local release archive: `sha256:1f4510141e80c6239a80765594eaab7f7d94205663c61a3439c734d63744313c`
- UAT receipt: `sha256:3cb401a0919904def55c99455e90c88e788c242b8730e1f50c5ab6ac8478acb3`
- Receipt summary: `passed: 1`, `failed: 1`, `not-run: 9`

최신 source commit의 release를 격리된 `tmux`에서 설치해 version·Connector doctor·local 시작·owner 초기화·readiness·provider catalog·event watch·재시작·owner-only backup·복원·uninstall 후 data 보존을 확인했습니다. 같은 실행에서 Codex의 공식 로그인 세션이 격리 profile에 이미 유효해 연결·account·doctor·quota 조회까지 확인했습니다. 실행 뒤 UAT driver·격리 server·tmux session은 남지 않았습니다.

## 최신 실제 Codex UAT — 2026-07-14

- Git commit: `26cac867dec17b36370e80d98d4e9d1813c7db96`
- Release manifest source digest: `sha256:f00e5d9396ff3beeef9f36eddb231e5b5d07d76ac51618da5d38bd582b7771b1`
- Local release archive: `sha256:1f4510141e80c6239a80765594eaab7f7d94205663c61a3439c734d63744313c`
- UAT receipt: `sha256:3cb401a0919904def55c99455e90c88e788c242b8730e1f50c5ab6ac8478acb3`
- Receipt summary: `passed: 1`, `failed: 1`, `not-run: 9`

이번 실행은 경로에 공백이 포함된 격리 작업공간에서 UAT 드라이버 자체도 `tmux`로 실행했습니다. 설치·version·Connector doctor·local 시작·owner 초기화·readiness·provider catalog·event watch·재시작·owner-only backup·복원 서버 시작·복원 readiness·uninstall 후 data 보존을 모두 통과했습니다. UAT 종료 뒤 격리 tmux·server 프로세스가 남지 않았습니다.

Codex 연결, account·doctor·quota 조회, `adaptive` 자동 승인 정책 설정·조회는 통과했습니다. 실제 `subscription acceptance` 실행은 15분 제한 내 terminal event를 받지 못해 종료 코드 `124`, 분류 `network`으로 실패했습니다. timeout 뒤 같은 상관관계 ID의 공개 runtime 계보 조회는 종료 코드 `67`(유효한 JSON이지만 공개 계약과 불일치)로 실패했습니다. 이 값은 원시 출력이나 계정 정보를 저장하지 않는 UAT 관찰 계약 실패를 뜻하며, 실제 제공자·제품 원인을 확정하는 근거로 사용하지 않습니다.

## 추가 bounded Codex UAT 재검증 — 2026-07-14

- Git commit: `d36d39e304eebe21eef76b8581ab785f67345dad`
- Release manifest source digest: `sha256:57121bd61e22c70e2cbfdcbde2113f45fb3db4f75653e9b854b3d403b29a5551`
- Local release archive: `sha256:8dd48cc4512fe72b38748099c2361069f69fe2decb7286af7a175c2f890ebd6d`
- UAT receipt: `sha256:13b2c4014414d3d411aad48d7072e2b4a36a55f7b83ed1210492608b355281d0`
- Receipt summary: `passed: 1`, `failed: 1`, `not-run: 9`

문서 커밋까지 포함한 release를 새 격리 `tmux`에서 180초 제한으로 재실행했습니다. lifecycle과 Codex 연결·account·doctor·quota·`adaptive` 정책은 다시 통과했고, 전체 Application Work 실행은 제한시간에 도달해 동일하게 `124`/`network`, timeout 뒤 공개 runtime 계보 관찰은 `67`로 기록됐습니다. UAT 도구의 최대 제한은 900초이며, 이를 초과하는 값은 제품 실행이 시작되기 전에 인자 오류로 거부됩니다.

같은 시각 Massion 경로와 분리한 공식 Codex CLI의 읽기 전용·일회성 `gpt-5.6-sol` 요청은 `thread.started`·`turn.started`·`item.completed`·`turn.completed` 사건과 길이 5의 최종 응답, 종료 코드 `0`을 반환했습니다. 이 probe는 제공자 응답 가능성만 확인하며 Massion의 Application·Router·runtime 계보 성공을 의미하지 않습니다. 원시 응답과 계정 식별자는 저장하지 않았습니다.

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
