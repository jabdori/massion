# Phase 24 — 새 Codex 계정 준비 재개 원자성 경계

> **기록 시각**: 2026-07-15
> **범위**: `subscription.server.prepare`의 실패 후 동일 명령 재개
> **상태**: 실제 저장소 자동화 검증 통과 · 실제 제공자 로그인 UAT와는 별도

## 결정

새 Codex 계정 준비는 하나의 전역 원자 트랜잭션(transaction)이 아닙니다. 다음 세 단계로 구성된 보상 사가(compensating saga)입니다.

1. 결정론적인 server Connector를 provision하고 독립 transaction으로 기록합니다.
2. Provider·endpoint·구독 계정·Connector credential을 하나의 transaction으로 만듭니다.
3. 두 번째 단계가 실패하면 Connector를 offline으로 두는 보상 transaction을 기록합니다.

따라서 첫 실패 뒤 offline Connector 하나가 남는 것은 누수가 아니라 안전한 복구 지점입니다. 계정, Provider, endpoint, credential과 router 감사 기록은 두 번째 transaction과 함께 rollback되어야 합니다.

실패한 `subscription.server.prepare` 또는 `subscription.server.attest`는 원래 actor가 완전히 같은 command envelope를 다시 보낼 때만 재개할 수 있습니다. 이 identity에는 operation, command ID, correlation ID와 canonical payload가 포함됩니다. 새 command ID, 다른 correlation ID 또는 다른 payload는 재개가 아닙니다. 재개 때 Application command의 lease generation은 정확히 하나 증가합니다.

CLI의 새 계정 pending 상태는 prepare command ID와 correlation ID를 보존합니다. 사용자는 중단된 새 계정 추가를 재개할 때 `--new-account`를 다시 명시해야 합니다. 이 재개는 일반적인 상태 reconcile 기능이 아니라, 중단된 동일 workflow의 복구 경로입니다.

## 자동화 근거

다음 명령을 2026-07-15 작업 트리에서 실행했습니다.

```text
pnpm --filter @massion/server exec vitest run src/server-subscription-connection.test.ts --reporter=dot
```

결과: 1개 test file, 21개 test 통과.

실제 memory database, Identity·Organization 서비스, SubscriptionAccountService, ProviderService, SubscriptionConnectionService, ServerConnectorProvisioningService, ApplicationCommandStore·Registry를 함께 조립한 회귀 테스트는 다음을 검증합니다.

- credential 생성이 실제 transaction 안에서 끝난 직후 의도적으로 실패하면 Connector 하나만 `offline`으로 남습니다.
- account, model provider, endpoint, credential, router audit은 모두 0개로 rollback됩니다.
- provision audit과 offline 보상 audit은 각각 독립 commit으로 남습니다.
- 같은 command의 두 번째 실행은 generation 2에서 Connector를 재사용하고 account·provider·endpoint·credential을 각각 정확히 하나만 만듭니다.
- 세 번째 같은 command는 result replay만 수행하며 resource, audit, runtime inspection, credential 생성 호출 수를 증가시키지 않습니다.

이 검증은 외부 Codex 로그인, OAuth token, quota 값 또는 provider 모델 응답을 사용하지 않습니다. 그런 실제 사용자 UAT는 별도 영수증과 사용자 인증이 필요하며, 이 문서를 성공 근거로 승격하지 않습니다.

## 연관 근거

- profile 재사용·소유권·quota 계약: `codex-profile-reuse-contract-2026-07-14.md`
- 실제 사용자 UAT 영수증: `subscription-uat-2026-07-14.md`
- 구현: `apps/server/src/server-subscription-connection.ts`, `packages/application/src/subscription-connection.ts`, `packages/application/src/command-store.ts`
