# Phase 30 릴리스 안전 선행 게이트 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `subagent-driven-development`로 이 작업을 한 조각씩 구현하고, 구현 뒤 명세 검토와 코드 품질 검토를 모두 수행합니다.

**Goal:** 기존 개인용 데이터를 자동 삭제하지 않고, 호환 불명 local data epoch를 안전하게 차단해 Phase 30의 실제 업데이트·재설치 UAT를 시작할 수 있게 합니다.

**Architecture:** `ensureLocalDataEpoch()`는 새 설치의 비어 있는 Massion root만 초기화합니다. marker가 없거나 다른데 실제 데이터가 있으면 삭제·재생성 대신 구조화된 migration-required 오류를 던집니다. 이 공통 경계 하나를 runtime staging, daemon 시작, backup이 함께 사용하므로 호출자별 우회는 만들지 않습니다.

**Tech Stack:** TypeScript 5.9, Node `fs/promises`, Vitest, `@massion/local-control`

---

## Task 1: 사용자 데이터 보존 epoch gate

**Files:**

- Modify: `packages/local-control/src/daemon.ts`
- Modify: `packages/local-control/src/daemon.test.ts`
- Modify: `apps/desktop-bridge/src/runtime-staging.test.ts`
- Modify: `docs/operations/backup-restore.md`
- Modify: `docs/phases/30-surface-parity-agent-ux/v1-delivery/README.md`

- [x] **Step 1: 현재 자동 삭제 기대 테스트를 보존 차단 테스트로 교체합니다.**

`daemon.test.ts`의 "v1 data epoch이 바뀌면 … 모두 비운다" 테스트를 삭제합니다. 대신 세 root에 `stale` 파일과 `obsolete\n` marker를 만든 뒤 다음을 확인합니다.

```ts
await expect(ensureLocalDataEpoch(paths)).rejects.toMatchObject({
  name: "LocalDataEpochMigrationRequiredError",
});
await expect(readFile(join(paths.dataDirectory, "stale"), "utf8")).resolves.toBe("stale");
await expect(readFile(join(paths.configDirectory, ".massion-data-epoch"), "utf8")).resolves.toBe("obsolete\n");
```

같은 테스트 파일에 marker 없는 새 root는 정상적으로 세 marker를 만들고, marker가 없는 **빈** root는 삭제 없이 marker만 만들어 초기화된다는 두 사례를 추가합니다.

- [x] **Step 2: 집중 테스트가 기존 구현에서 예상한 이유로 실패하는지 확인합니다.**

Run: `pnpm --filter @massion/local-control test -- daemon.test.ts`

Expected: 기존 구현이 `stale` 파일을 지워 보존 assertion에서 실패합니다.

- [x] **Step 3: 공통 epoch 경계만 최소 수정합니다.**

`daemon.ts`에 다음 동작을 추가합니다.

```ts
export class LocalDataEpochMigrationRequiredError extends Error {
  public constructor() {
    super("기존 Massion 데이터의 호환성을 확인할 수 없습니다. 데이터를 보존한 채 마이그레이션이 필요합니다.");
    this.name = "LocalDataEpochMigrationRequiredError";
  }
}
```

각 root는 symlink 검사를 통과한 뒤, `.massion-data-epoch`을 제외한 항목이 하나라도 있으면 data-bearing root로 취급합니다. 모든 root가 없거나 비어 있으면 `mkdir`과 marker write만 수행합니다. 하나라도 data-bearing인데 marker가 current epoch와 다르면 `LocalDataEpochMigrationRequiredError`를 던집니다. `rm(root, { recursive: true })` 호출은 이 migration 경로에서 제거합니다. 동시 초기화의 `EEXIST`/`ENOENT` 재시도는 유지합니다.

- [x] **Step 4: 보존·기존 정상 시작·typecheck를 검증합니다.**

Run: `pnpm --filter @massion/local-control test -- daemon.test.ts && pnpm --filter @massion/local-control typecheck`

Expected: epoch 보존 사례와 기존 daemon 사례가 모두 통과합니다.

- [x] **Step 5: 운영 문서와 전달 기록을 사실 상태로 갱신합니다.**

`backup-restore.md`에는 incompatibility가 자동 초기화되지 않으며 backup/restore 또는 명시적 migration이 선행되어야 한다고 적습니다. v1 전달 기록에는 이 작업을 "릴리스 전 안전 gate 진행 중"으로 추가하고, 실제 업데이트·재설치 UAT 전에는 완료로 표기하지 않습니다.

- [x] **Step 6: 한 개의 분리 커밋을 만듭니다.**

```sh
git add packages/local-control/src/daemon.ts packages/local-control/src/daemon.test.ts \
  apps/desktop-bridge/src/runtime-staging.test.ts \
  docs/operations/backup-restore.md docs/phases/30-surface-parity-agent-ux/v1-delivery/README.md \
  docs/superpowers/plans/2026-07-26-phase-30-release-safety-preflight.md
git commit -m "fix(local-control): 호환 불명 epoch에서 사용자 데이터를 보존" \
  -m "marker 불일치가 Work·자격증명·로컬 DB를 자동 삭제하지 않도록 차단하고, 실제 마이그레이션 전 안전 게이트를 기록했습니다."
```

## 완료 조건

- [x] marker 불일치·부분 marker 손상에서 사용자 파일과 marker가 모두 보존됩니다.
- [x] 새 설치와 빈 root는 자동 초기화됩니다.
- [x] daemon 시작·runtime staging·backup이 같은 공통 gate를 사용합니다.
- [x] Task 11의 업데이트·제거·재설치 UAT 전, 자동 삭제 경로가 없다는 회귀 검증이 있습니다.

---

## Task 2: 깨끗한 checkout의 Tauri 개발 실행 준비

**Files:**

- Modify: `apps/desktop/src-tauri/tauri.conf.json`
- Modify: `docs/superpowers/plans/2026-07-26-phase-30-release-safety-preflight.md`

- [x] **Step 1: 현재 개발 실행의 누락된 build 의존을 재현합니다.**

`RuntimePaths::development()`가 `desktop-bridge/dist/entry.js`와 `server/dist/main.js`를 필수로 요구하지만, 두 파일은 Git에서 추적하지 않습니다. 기존 `beforeDevCommand`가 sidecar와 Vite만 준비한다는 것을 설정과 실행 출력으로 기록합니다.

- [x] **Step 2: 개발 전 단일 bootstrap에 server·bridge build를 추가합니다.**

`tauri.conf.json`의 `beforeDevCommand` 앞에 기존 package script를 그대로 사용해 다음 순서를 둡니다.

```text
pnpm --filter @massion/server build
pnpm --filter @massion/desktop-bridge build
node src-tauri/prepare-runtime.mjs
pnpm dev
```

별도 wrapper나 새 build script는 만들지 않습니다. 릴리스 staging도 같은 두 산출물을 이미 빌드하므로 개발 경로만 정합화합니다.

- [x] **Step 3: GUI를 열지 않는 bootstrap 순서를 검증합니다.**

Run: `env MASSION_SURREAL_BINARY=/dev/null pnpm --filter @massion/desktop tauri:dev`

Expected: server와 desktop bridge build가 `prepare-runtime` 실패보다 먼저 실행되고, `/dev/null` 때문에 sidecar 입력 검증에서 exit 1로 끝납니다. 실제 GUI·native UAT는 이 명령으로 대체하지 않습니다.

- [x] **Step 4: 타입·diff와 한 개의 분리 커밋을 검증합니다.**

Run: `pnpm --filter @massion/desktop typecheck && git diff --check`

```sh
git add apps/desktop/src-tauri/tauri.conf.json docs/superpowers/plans/2026-07-26-phase-30-release-safety-preflight.md
git commit -m "fix(desktop): Tauri 개발 실행 전에 bridge와 server를 빌드" -m "추적되지 않는 runtime entrypoint 때문에 깨끗한 checkout에서 앱이 시작하지 못하던 문제를 개발 bootstrap 순서에서 해결했습니다."
```

## 완료 조건

- [x] `tauri:dev`가 ignored `server`·`desktop-bridge` 산출물을 스스로 준비합니다.
- [x] sidecar 검증 실패는 build가 끝난 뒤에만 발생합니다.
- [x] 실제 GUI UAT는 별도 증거로 남기며 이 bootstrap 검증을 UAT 완료로 표시하지 않았습니다.
