# 긴급 정지 해제 수직 흐름 검증 기록

검증일: 2026-07-27
상태: 구현·집중 검증 통과, 실제 Tauri 실행은 인증 경계에서 중단

## 범위

긴급 정지 활성화 → 해제 승인 요청 → 수신함 승인 → 해제 재개 → Permit 1회 소비를 한 번의 사용자 수직 흐름으로 확인했습니다.

## 코드 및 집중 검증

- `packages/application/src/adapters/domain.ts`: 해제 승인 요청과 승인 Permit 재개 command
- `packages/governance/src/emergency.ts`: 승인된 `emergency.stop.disable` 범위와 조직 revision 검증
- `packages/governance/src/permit.ts`: 승인된 action·resource와 실제 소비 목적 일치 검증
- `packages/governance/src/governance-service.ts`: `full-access`에서도 긴급 정지 해제는 non-bypassable 승인 요구
- `pnpm --filter @massion/governance exec vitest run src/governance-service.test.ts -t 'full-access에서도 긴급 중단 해제는 사람 승인을 요구한다'`: 통과
- `pnpm --filter @massion/application exec vitest run src/adapters/domain.test.ts -t '긴급 정지'`: 2개 통과
- 관련 패키지 타입 검사(`governance`, `application`, `server`, `desktop`): 통과

## 실제 Tauri 및 Provider 실행

실제 Tauri 앱을 Computer Use로 실행하고 로컬 Provider 연결 전 부트스트랩을 확인했습니다. 앱 화면에는 다음 오류가 표시됐습니다.

```text
Application access token 인증에 실패했습니다
operatorCode: APP_HTTP_AUTH
```

서버는 `127.0.0.1:7331`에서 준비됐지만, 실제 앱이 `status`/`me` 인증을 통과하지 못해 긴급 정지 흐름과 실제 Provider 호출까지 도달하지 못했습니다. 실행 후보의 서버 로그에는 준비·종료 기록만 있고 인증 실패의 내부 원인은 기록되지 않았습니다.

따라서 이 기록은 실제 Tauri 성공 증거가 아니며, 기존 후보의 UAT 결과를 재사용하지 않습니다. 인증 발급·검증 경계의 구체적인 원인을 확인하기 전에는 같은 Computer Use 조작을 반복하지 않습니다.

## 별도 Work 실행 상태 가시성 증분

긴급 정지 흐름과 별개로, 최신 릴리스 번들에서 실제 Provider Work가 전략 단계에서 막힌 경우를 Computer Use로 다시 확인했습니다. 이 증분은 긴급 정지 해제 흐름의 완료 증거가 아닙니다.

- 번들: `apps/desktop/src-tauri/target/release/bundle/macos/Massion.app`
- 실행 바이너리 SHA-256: `580f2ecb36c40e10ad57686659f3a434eb8f30bec7d64b0994762449d968237c`
- Provider: 격리 프로필에 등록한 OpenRouter 연결(키와 원문은 기록하지 않음)
- 실제 Work: `ed167c46-d9c4-4699-bbe7-15605329c3ed`
- 실제 실행: `4a0ae3c6-64ba-4b87-b80f-049a94f9d0ee`
- 관측: `orchestration-balanced`는 성공했지만 `planning-quality`의 구조화 응답을 파싱하지 못해 `context-strategy-stage-failed`로 막힘
- 화면: 중앙 대화에 `실행이 멈췄습니다`, Provider 오류 설명, `현재 단계: 맥락·전략 구성`, 재개 안내가 표시됨
- 재개: 상단 `실행 재개`를 눌렀을 때 같은 실제 Provider 경로가 다시 실행되고, 동일 단계의 실패가 화면에 갱신됨

따라서 이번 증분은 “오류가 수신함에만 남고 대화에서는 보이지 않는 문제”를 해결했음을 증명하지만, Provider의 구조화 출력 호환성 문제를 해결했음을 뜻하지 않습니다.

## Provider capability·fallback·로컬 runtime 증분

앞선 실패 실행과 별개로, 구조화 출력 capability를 실제 Model Builder에 전달하고 출력 파싱 실패를 다른 Model Candidate로 넘기는 최신 후보를 실제 Tauri 앱에서 다시 실행했습니다.

- 번들 실행 바이너리 SHA-256: `f23380048ed8bf657b396174d9f7dccb13cd1ce99b1c1f8cb1af7bd6d7bac061`
- 실제 Work: `caba29fc-0eda-4199-8769-f116da511bf9`
- 실제 실행: `b4fca03d-aa2c-4c38-9e2c-8b0e02f6d8f8`
- 실제 실행 화면: 새 Work를 만들고 `OpenRouter fallback 경로를 한 문장으로 확인해줘`를 제출한 뒤, 중앙 Work 화면에서 `실행 중` → `완료`, 작업 `1/1`, 진행률 `100%`를 확인했습니다.
- 실제 실행 경로: `orchestration-balanced` 성공, `planning-quality` 성공, `delivery-quality` 성공, Assurance 성공.
- SurrealDB route attempt: `55b99547-433a-4ff2-8b3a-47e1bb70b006`, `4e492aaa-0106-4abb-963c-fad950157a8b`, `099c7766-4d83-4b6e-a86b-81e054c0acca`, `60d1ea7a-7edd-4a30-acb1-59a28c0d95c1`가 모두 `succeeded`로 기록됐습니다. 이 실행에서는 Provider가 모두 성공했으므로 실제 fallback 전이는 발생하지 않았고, fallback 자체는 focused 회귀 테스트로 검증했습니다.
- 실제 로컬 경계: 앱이 번들 SurrealDB를 사용자 data directory의 `runtime/surrealdb/3.2.1/darwin-arm64/surreal`로 복사한 뒤 실행했고, `server.json`·`surrealdb.json`의 loopback endpoint가 준비됐습니다. 복사된 실행 파일은 owner-only 실행 권한(`-r-x------`)입니다.
- 후속 비차단 관측: Work가 terminal `completed`가 된 뒤 Growth 실행 하나가 `unknown`으로 실패했습니다. 이는 이번 Provider Work 완료를 막지는 않았지만, Growth background provider 호환성은 아직 별도 미완료 범위입니다.

이번 증분의 의미는 사용자 모델을 검증 전 native structured output으로 오인하지 않고 JSON prompt 경로로 시작하며, `Invalid JSON response`·`No object generated`를 output 실패로 분류해 같은 Credential의 다른 Model Candidate를 선택할 수 있게 한 것입니다. 실제 앱 성공은 확보했지만, 무료 Provider의 모델별 출력 편차와 Growth 후속 실패까지 해결했다는 뜻은 아닙니다.

## 남은 범위

1. 실제 Tauri 부트스트랩 access token이 발급 키와 검증 키를 동일하게 사용하는지 확인합니다.
2. 인증 경계가 해결된 새 후보에서 이 수직 흐름과 실제 Provider 연결을 다시 실행합니다.
3. 실제 화면·로그 증거가 확보되기 전에는 이 흐름을 완료 또는 릴리스 통과로 표시하지 않습니다.
