# Phase 30 Slice 1B — SurrealDB 3.2.1 실행 확인

> **기록 일시:** 2026-07-19
> **기준 커밋:** `e9f99f74df484bb1f1965678ffe9be5c97deb35e`

## 확인 결과

공식 SurrealDB 3.2.1 binary를 임시 loopback 환경에서 실행하고 현재 SDK transport로 인증·write·query를 확인했습니다.

- binary version: `3.2.1 for macos on aarch64`
- SDK version: `surrealdb-3.2.1`
- authenticated write와 query: 성공

backup round-trip도 임시 source/candidate database에서 확인했습니다.

- database-scoped runtime user로 export 가능
- import 뒤 runtime user credential을 다시 설정해야 candidate runtime authentication이 성공
- record 보존 확인

```text
source_export=ok contains_runtime_user=true
candidate_runtime_before_overwrite=rejected
candidate_runtime_after_overwrite=ok record_preserved=true
```

따라서 제품 restore는 import 뒤 runtime credential을 다시 설정하고 authenticated readiness를 확인해야 합니다.

## 공식 근거

- [SurrealDB 3.2 release](https://surrealdb.com/releases/3.2)
- [export](https://surrealdb.com/docs/reference/cli/surrealdb-cli/commands/export)
- [import](https://surrealdb.com/docs/reference/cli/surrealdb-cli/commands/import)

`OPTION IMPORT`와 platform별 archive 검증은 구현 시 source test와 release verification으로 다시 확인합니다. 이 기록은 native runtime 선택의 실행 근거이며, 설치·TUI·Web·전체 제품 완료의 근거는 아닙니다.
