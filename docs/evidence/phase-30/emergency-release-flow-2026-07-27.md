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

## 남은 범위

1. 실제 Tauri 부트스트랩 access token이 발급 키와 검증 키를 동일하게 사용하는지 확인합니다.
2. 인증 경계가 해결된 새 후보에서 이 수직 흐름과 실제 Provider 연결을 다시 실행합니다.
3. 실제 화면·로그 증거가 확보되기 전에는 이 흐름을 완료 또는 릴리스 통과로 표시하지 않습니다.
