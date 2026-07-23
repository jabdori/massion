# 핸드오프 — 확장의 Capability를 계약으로 내보내기

> **상태:** 미구현. 다른 에이전트가 이어받도록 작성한 인계 문서
> **작성일:** 2026-07-23
> **관련 갭:** [제품 헌법 6절·9.1·9.5](../../product/constitution.md)

## 1. 무엇이 없는가

헌법 6절은 확장 표면에 *"조직에 추가된 Capability를 먼저 보여줘야 한다"*고 요구합니다. **설치된 확장에 대해 이걸 만족할 수 없습니다.**

| | 상태 |
|---|---|
| SDK의 선언 계약 | 있음 — `ExtensionContributionDeclaration` 8종, `ExtensionPermissionDeclaration` 8종 (`packages/extension-sdk/src/contracts.ts:16,27`) |
| Application 계약 | **없음** — `ExtensionInstallationViewV1`은 `installationId`·`packageName`·`state`·`activeVersionId`·`activationGeneration` 다섯뿐 (`contracts.ts:238`) |
| Registry 조회 | **타입 없음** — `search`·`info`·`inventory`가 전부 `Promise<unknown>` (`registry-operations.ts:9-14`). `ApplicationQueryMapV1`에 항목 자체가 없습니다 |

manifest는 `registry.info` 응답 안에만 있습니다. 즉 **아직 설치하지 않은 것의 Capability는 볼 수 있고, 이미 설치한 것은 볼 수 없습니다.** 판단이 필요한 시점과 정보가 있는 시점이 뒤집혀 있습니다.

## 2. 필요한 것

### 2.1 `extension.list`에 선언을 싣기

```ts
export interface ExtensionInstallationViewV1 {
  // 기존 다섯 필드에 더해
  readonly contributions: readonly { readonly kind: ExtensionContributionKindV1; readonly ids: readonly string[] }[];
  readonly permissions: readonly { readonly kind: ExtensionPermissionKindV1; readonly values: readonly string[] }[];
}
```

`kind`는 SDK 선언의 **키 그대로** 보내십시오(`runtimeTools`, `network`, …). 한글 문구는 화면이 소유합니다(`apps/desktop/src/app.tsx`의 `contributionLabel`·`permissionLabel`).

값의 출처는 설치된 버전의 manifest입니다. Extension Store가 이미 들고 있습니다(`packages/extension-host/src/store.ts`).

### 2.2 `registry.*` 네 조회에 반환 타입 주기

지금은 `unknown`이라 데스크톱이 `registryDetail()`·`marketplaceEntries()`에서 런타임 파싱을 합니다. 계약이 형태를 정하면 그 파싱이 사라집니다.

## 3. 프론트엔드 상태

**연결만 되면 채워집니다.** 화면은 이미 완성돼 있습니다.

| 계층 | 위치 |
|---|---|
| 뷰 타입 | `apps/desktop/src/desktop-service.ts` `ExtensionEntryView`·`ContributionKind`·`PermissionKind` |
| 투영 | 같은 파일 `projectManifestDeclarations()`·`marketplaceEntries()`·`projectExtensionEntries()` |
| 문구 | `apps/desktop/src/app.tsx` `contributionLabel`·`permissionLabel`·`extensionStateLabel` |

지금은 설치된 확장의 선언이 빈 배열로 오고, 화면이 *"이 확장이 조직에 무엇을 더하는지 계약이 알려주지 않습니다"*를 그 자리에 씁니다. **지어내지 않고 없다고 말하는 상태**이며, 2.1이 붙으면 그 문장이 목록으로 바뀝니다.

## 4. 완료 판정

- [ ] 설치된 확장 하나가 `contributions` 다섯 종류를 화면에 채운다
- [ ] `kind`가 SDK 키 그대로 오고 화면이 한글로 옮긴다 (계약이 한글을 싣지 않는다)
- [ ] `registry.*` 넷이 `ApplicationQueryMapV1`에 타입과 함께 등록된다
- [ ] 설치 → 승인 → 활성화 뒤 목록의 상태가 `starting → healthy`로 따라간다

## 5. 범위 밖

- Extension lifecycle·worker supervisor·capability broker의 생산 경로 연결 (헌법 9.5)
- 설치된 확장의 권한 변경·비활성화 command
