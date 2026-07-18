# Phase 30 Slice 1A 원격 SurrealDB 3.2.1 구현 계획

> **에이전트형 작업자(agentic workers):** 이 계획의 각 작업은 `subagent-driven-development` 절차로 구현하고, 구현 뒤 명세 검토와 품질 검토를 순서대로 수행합니다.

**Goal:** 개인용 로컬 RocksDB를 건드리지 않고 원격 Docker·Compose·Kubernetes·릴리스 묶음과 미래 GitHub 릴리스가 SurrealDB 3.2.1 binary·안전한 QEMU 입력·올바른 이미지 이름을 일관되게 가리키도록 검증 가능한 소스 배포 계약으로 고정합니다.

**Architecture:** SurrealDB binary source stage만 변경 가능한 tag가 아니라 OCI index digest로 고정하고, 사용자에게 보이는 Compose·Kubernetes·배포 묶음의 기본 이미지 이름은 `massion-surrealdb:3.2.1`로 통일합니다. GitHub release workflow는 조직 registry에 게시할 때 별도 tag `${{ steps.identity.outputs.base }}/surrealdb:3.2.1-massion.1`를 사용하며, digest로 고정한 binfmt image와 필요한 arm64 emulator만으로 Buildx의 `linux/amd64,linux/arm64` manifest 생성을 준비합니다. 기존 공개 `v1.0.0`은 새 커밋에서 다시 실행되지 않으므로 실제 registry 게시은 후속 Release Recovery 조각의 새 version·tag에서만 증명합니다. 이 조각은 final Debian base와 `apt-get` 결과까지 bit-for-bit 고정하는 이미지 공급망 작업이 아니라 SurrealDB binary provenance와 배포 참조를 고정하는 작업입니다.

**Tech Stack:** Node.js 내장 테스트(node:test), Docker Buildx, Docker Compose, Kubernetes Kustomize, pnpm 11, GitHub Actions

---

## 범위와 선행 근거

- 기준 소스 커밋(source commit)은 `65922bd706580a0962b6eda81c6fa3d63b36b6a8`이고, 안전 커밋(safety commit)은 `9b049f72a96457c46139811f86d36589f073df64`입니다.
- 현재 Docker registry 조회에서 `surrealdb/surrealdb:v3.2.1`의 OCI index digest는 `sha256:a0ef3252ec197a31a262423241061390f51ba95509a68f1866f0783ad8f39ea1`입니다.
- 3.2.1은 SurrealDB의 현재 3.2 계열 안정 패치이며, 3.2.0에서 catalog·on-disk layout 변경이 없는 업그레이드라는 공식 근거는 [SurrealDB 배포·로컬 런타임 경계 조사](../../evidence/phase-30/surrealdb-runtime-boundary-2026-07-18.md)에 기록합니다.
- Slice 1B인 개인용 로컬 RocksDB의 실제 runtime version 전달, `packages/application/src/artifacts.ts`, `packages/extension-host/src/compliance.ts`는 이 계획의 범위 밖입니다.
- 이 계획은 안전 스냅샷의 Slice 1 여덟 경로 중 원격 배포·릴리스 여섯 경로만 다루며, `CHANGELOG.md`는 사후 보정(post-snapshot correction)입니다.
- `apps/cli/src/remote.e2e.test.ts`의 opt-in UAT 기대값 보정도 안전 스냅샷 밖의 사후 호환성 보정입니다. 이는 Slice 1B의 개인용 local runtime version 전달이 아니라, 원격 배포가 3.2.1로 바뀐 뒤 기존 UAT의 `surrealdb-3.2.0` literal 실패를 막는 범위입니다.
- QEMU action·binfmt image digest·arm64 emulator 제한은 안전 스냅샷에서 복원하는 hunk가 아니라, 같은 release workflow에 추가하는 사후 보안·배포 hardening입니다. 증거와 정합성 원장은 이 두 출처를 구분해 기록합니다.
- 현재 release job의 `runs-on: ubuntu-24.04`는 GitHub-hosted x64 runner label입니다. QEMU는 x64 runner에서 arm64 target을 추가하는 구성이라는 전제를 계약 테스트로 고정하며, arm64 runner label로 바꾸는 일은 별도 runner·emulation 설계가 필요합니다.
- `deploy/surreal/Dockerfile`의 final `debian:bookworm-slim` base와 `apt-get` 의존성은 이 SurrealDB version 조각에서 변경하지 않습니다. 따라서 여기서 증명하는 것은 `surreal version` 3.2.1과 배포 참조의 일관성이지 최종 image의 byte-for-byte 재현성은 아닙니다.
- 이 조각은 SurrealDB registry artifact만 `linux/amd64,linux/arm64`로 게시하도록 만듭니다. Massion·Caddy의 registry artifact 다중 아키텍처 전환은 전체 원격 stack image distribution 범위이므로 별도 조각에서 다룹니다.
- 원격 `v1.0.0` tag는 이미 공개 Release를 가리키며, 해당 workflow는 전체 품질 검증에서 실패해 image build·registry 게시·attestation 단계가 모두 생략되었습니다. 이 계획은 기존 tag를 이동하거나 덮어쓰지 않으며, 실제 공개 artifact는 후속 Release Recovery 조각에서 새 patch version과 새 tag를 사용해 검증합니다.
- 현재 `docker/setup-buildx-action` action 자체는 commit SHA로 고정되어 있지만, action이 내려받는 Buildx binary와 Docker-container BuildKit image의 runtime 입력, `# syntax=docker/dockerfile:1.12`이 해석하는 외부 Dockerfile frontend image까지 이 조각에서 고정하지는 않습니다. Slice 1A는 privileged QEMU helper의 mutable 기본 입력을 제거하는 범위까지만 다루며, Buildx·BuildKit·Dockerfile frontend runtime provenance 고정은 Release Recovery의 별도 RED→GREEN 계약으로 남깁니다.

## 파일 책임 경계

| 파일 | 변경 책임 |
| --- | --- |
| `scripts/release-workflow.test.mjs` | 서로 다른 두 이미지 tag와 OCI digest를 포함한 원격 배포 계약을 RED→GREEN으로 고정합니다. |
| `.github/workflows/release.yml` | GitHub Container Registry용 SurrealDB tag·고정 binfmt 입력·필요한 arm64 emulator·amd64/arm64 manifest 생성을 고정합니다. |
| `compose.yaml` | 사용자 배포의 기본 SurrealDB 이미지를 `massion-surrealdb:3.2.1`로 올립니다. |
| `deploy/kubernetes/base/surreal-statefulset.yaml` | Kubernetes StatefulSet의 기본 SurrealDB 이미지를 같은 로컬 이름으로 올립니다. |
| `deploy/surreal/Dockerfile` | upstream SurrealDB 3.2.1 OCI index digest를 고정합니다. |
| `scripts/build-release.mjs` | 생성되는 배포 묶음의 기본 SurrealDB 이미지를 같은 로컬 이름으로 올립니다. |
| `CHANGELOG.md` | 원격 SurrealDB 배포 버전 설명을 3.2.1로 정정합니다. |
| `apps/cli/src/remote.e2e.test.ts` | opt-in 원격 CLI UAT가 특정 과거 DB version literal 대신 실제 연결 database version을 기대하게 보정합니다. |
| `docs/phases/30-surface-parity-agent-ux/slice-1a-remote-surrealdb-implementation-plan.md` | 구현 전에 설계·RED→GREEN·검증·커밋 경계를 독립 문서 커밋으로 고정합니다. |
| `docs/evidence/phase-30/slice-1a-remote-surrealdb-2026-07-18.md` | 실제 코드 SHA와 실행한 검증 결과를 코드 커밋 뒤 기록합니다. |
| `docs/evidence/phase-30/surrealdb-runtime-boundary-2026-07-18.md` | 안전 스냅샷 복원과 후속 QEMU hardening의 출처를 구분합니다. |
| `docs/phases/30-surface-parity-agent-ux/implementation-plan.md`, `docs/phases/30-surface-parity-agent-ux/reconciliation-plan.md`, `docs/phases/30-surface-parity-agent-ux/reconciliation-manifest.json` | Slice 1A의 실제 상태, Slice 1B의 미완료 경계, 정본 원장의 부분 구현 상태를 코드 SHA에 맞게 정정합니다. |

## 작업 0: 구현 전에 계획을 독립 문서 커밋으로 고정

**파일:**

- 생성: `docs/phases/30-surface-parity-agent-ux/slice-1a-remote-surrealdb-implementation-plan.md`

- [ ] 계획의 Markdown 형식·문서 구조·정합성 원장을 검증하고, 이 계획 파일만 별도 커밋합니다. 이후 코드·증거 커밋의 allowlist에는 계획 파일을 다시 넣지 않습니다.

```bash
set -euo pipefail
expected_worktree_paths="docs/phases/30-surface-parity-agent-ux/slice-1a-remote-surrealdb-implementation-plan.md"
actual_worktree_paths="$(git status --porcelain --untracked-files=all | sed -E 's/^.. //' | LC_ALL=C sort)"
test "$actual_worktree_paths" = "$expected_worktree_paths" || {
  printf '%s\n' "Slice 1A 계획 커밋 전에 허용되지 않은 작업 트리 변경이 있습니다" >&2
  exit 1
}
pnpm exec prettier --check docs/phases/30-surface-parity-agent-ux/slice-1a-remote-surrealdb-implementation-plan.md
pnpm verify:docs
node scripts/verify-phase30-reconciliation.mjs --require-safety
git diff --check
git diff --cached --quiet || {
  printf '%s\n' "기존 staged 변경이 있어 Slice 1A 계획 커밋을 만들 수 없습니다" >&2
  exit 1
}
actual_worktree_paths="$(git status --porcelain --untracked-files=all | sed -E 's/^.. //' | LC_ALL=C sort)"
test "$actual_worktree_paths" = "$expected_worktree_paths" || {
  printf '%s\n' "계획 검증 뒤 허용되지 않은 작업 트리 변경이 생겼습니다" >&2
  exit 1
}
git add -- docs/phases/30-surface-parity-agent-ux/slice-1a-remote-surrealdb-implementation-plan.md
expected_paths="$expected_worktree_paths"
actual_paths="$(git diff --cached --name-only)"
test "$actual_paths" = "$expected_paths" || {
  printf '%s\n' "Slice 1A 계획 커밋의 staged 경로가 허용 목록과 다릅니다" >&2
  exit 1
}
git diff --cached --check
git commit -m "docs(phase-30): plan remote SurrealDB validation"
```

## 작업 1: 원격 배포 계약을 실패하는 테스트로 고정

**파일:**

- 수정: `scripts/release-workflow.test.mjs`
- 읽기: `apps/cli/src/remote.e2e.test.ts`
- 테스트: `scripts/release-workflow.test.mjs`

- [ ] 기존 import와 첫 번째 release workflow 보안 테스트는 유지합니다. 두 번째 테스트를 아래 계약 테스트로 교체하고, 상수·helper는 그 테스트 바로 앞에 추가합니다. 기존의 Massion·database-provision·Caddy 기본 이미지 계약은 단순 token 존재가 아니라 해당 Compose service와 release bundle `images` 객체에서 계속 단언합니다.

```js
const SURREALDB_VERSION = "3.2.1";
const SURREALDB_DIGEST = "sha256:a0ef3252ec197a31a262423241061390f51ba95509a68f1866f0783ad8f39ea1";
const WORKFLOW_SURREALDB_TAG = "${{ steps.identity.outputs.base }}/surrealdb:3.2.1-massion.1";
const QEMU_SETUP_ACTION = "docker/setup-qemu-action@96fe6ef7f33517b61c61be40b68a1882f3264fb8 # v4.2.0";
const QEMU_BINFMT_IMAGE = "docker.io/tonistiigi/binfmt@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0";
const QEMU_PLATFORMS = "arm64";
const RELEASE_RUNNER = "ubuntu-24.04";
const WORKFLOW_SURREALDB_PLATFORMS = "linux/amd64,linux/arm64";
const DEPLOY_SURREALDB_IMAGE = "massion-surrealdb:3.2.1";
const COMPOSE_SURREALDB_IMAGE = "${MASSION_SURREALDB_IMAGE:-massion-surrealdb:3.2.1}";
const COMPOSE_MASSION_IMAGE = "${MASSION_IMAGE:-massion:1.0.0}";
const COMPOSE_CADDY_IMAGE = "${MASSION_CADDY_IMAGE:-massion-caddy:2.11.4}";
const UPSTREAM_SURREALDB_IMAGE = `surrealdb/surrealdb:v${SURREALDB_VERSION}@${SURREALDB_DIGEST}`;

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function workflowStepByName(workflow, name) {
  const heading = new RegExp(`^      - name: ${escapeRegularExpression(name)}$`, "mu");
  const matches = [...workflow.matchAll(new RegExp(heading.source, "gmu"))];
  assert.ok(matches.length > 0, `${name} workflow step이 없습니다`);
  assert.equal(matches.length, 1, `${name} workflow step은 정확히 하나여야 합니다`);
  const [match] = matches;
  const start = match.index;
  const end = workflow.indexOf("\n      - name: ", start + 1);
  return { content: workflow.slice(start, end === -1 ? undefined : end), offset: start };
}

function workflowJobByName(workflow, name) {
  const jobsStart = workflow.indexOf("\njobs:\n");
  assert.ok(jobsStart !== -1, "workflow jobs section이 없습니다");
  const jobs = workflow.slice(jobsStart + "\njobs:\n".length);
  const jobHeadings = [...jobs.matchAll(/^  [^\s][^:\n]*:$/gmu)];
  const heading = `  ${name}:`;
  const matches = jobHeadings.filter(([line]) => line === heading);
  assert.equal(matches.length, 1, `${name} workflow job은 정확히 하나여야 합니다`);
  const [match] = matches;
  const start = match.index;
  const next = jobHeadings.find((candidate) => candidate.index > start);
  return jobs.slice(start, next?.index);
}

function expectSingleProperty(block, indentation, key, value, message) {
  const prefix = `${" ".repeat(indentation)}${key}: `;
  const lines = [...block.matchAll(new RegExp(`^${escapeRegularExpression(prefix)}.*$`, "gmu"))].map(
    ([line]) => line,
  );
  assert.deepEqual(lines, [`${prefix}${value}`], message);
}

function expectSingleDockerInstruction(stage, instruction, value, message) {
  const prefix = `${instruction} `;
  const lines = [...stage.matchAll(new RegExp(`^${escapeRegularExpression(prefix)}.*$`, "gmu"))].map(
    ([line]) => line,
  );
  assert.deepEqual(lines, [`${prefix}${value}`], message);
}

function finalDockerStage(dockerfile) {
  const stages = [...dockerfile.matchAll(/^FROM .+$/gmu)];
  assert.ok(stages.length > 0, "Dockerfile에 FROM stage가 없습니다");
  const finalStage = stages[stages.length - 1];
  return dockerfile.slice(finalStage.index);
}

function expectSurrealBinaryCopy(finalStage) {
  const lines = [...finalStage.matchAll(/^COPY .+ \/usr\/local\/bin\/surreal$/gmu)].map(([line]) => line);
  assert.deepEqual(
    lines,
    ["COPY --from=surreal /surreal /usr/local/bin/surreal"],
    "Dockerfile final stage는 고정한 surreal stage의 binary만 복사해야 합니다",
  );
}

function composeServiceBlock(compose, serviceName) {
  const service = compose.match(
    new RegExp(`^  ${escapeRegularExpression(serviceName)}:\\n(?<body>(?:^    .*\\n?)*)`, "mu"),
  );
  assert.ok(service?.groups?.body, `${serviceName} Compose service가 없습니다`);
  return service.groups.body;
}

function expectComposeImage(compose, serviceName, image, message) {
  expectSingleProperty(composeServiceBlock(compose, serviceName), 4, "image", image, message);
}

function releaseBundleImagesBlock(builder) {
  const anchor = 'await writeFile(\n    resolve(deploy, "release-bundle.json"),';
  const anchorCount = builder.split(anchor).length - 1;
  assert.equal(anchorCount, 1, "release-bundle.json writeFile 호출은 정확히 하나여야 합니다");
  const start = builder.indexOf(anchor);
  const end = builder.indexOf("\n  );", start);
  assert.notEqual(end, -1, "release-bundle.json writeFile 호출의 끝을 찾지 못했습니다");
  const releaseBundleWrite = builder.slice(start, end);
  const matches = [...releaseBundleWrite.matchAll(/^        images: \{\n(?<body>(?:^          .*\n?)*)^        \},$/gmu)];
  assert.equal(matches.length, 1, "release bundle images 객체는 정확히 하나여야 합니다");
  return matches[0].groups.body;
}

function kubernetesContainerBlock(kubernetes, containerName) {
  const heading = new RegExp(`^        - name: ${escapeRegularExpression(containerName)}$`, "gmu");
  const matches = [...kubernetes.matchAll(heading)];
  assert.equal(matches.length, 1, `${containerName} Kubernetes container는 정확히 하나여야 합니다`);
  const [match] = matches;
  const start = match.index;
  const end = kubernetes.indexOf("\n        - name: ", start + 1);
  return kubernetes.slice(start, end === -1 ? undefined : end);
}

function currentChangelogSection(changelog) {
  const headings = [...changelog.matchAll(/^## [^\n]+$/gmu)];
  assert.ok(headings.length > 0, "CHANGELOG 현재 릴리스 항목이 없습니다");
  const start = headings[0].index;
  const end = headings[1]?.index ?? changelog.length;
  return changelog.slice(start, end);
}

test("원격 SurrealDB 배포 계약은 3.2.1의 registry·배포 이미지 이름과 OCI digest를 고정한다", async () => {
  const [workflow, compose, builder, dockerfile, kubernetes, changelog, remoteCliE2e] = await Promise.all([
    readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
    readFile(new URL("../compose.yaml", import.meta.url), "utf8"),
    readFile(new URL("./build-release.mjs", import.meta.url), "utf8"),
    readFile(new URL("../deploy/surreal/Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("../deploy/kubernetes/base/surreal-statefulset.yaml", import.meta.url), "utf8"),
    readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8"),
    readFile(new URL("../apps/cli/src/remote.e2e.test.ts", import.meta.url), "utf8"),
  ]);

  const releaseJob = workflowJobByName(workflow, "release");
  expectSingleProperty(releaseJob, 4, "runs-on", RELEASE_RUNNER, "release workflow runner가 x64 ubuntu-24.04가 아닙니다");
  const qemuStep = workflowStepByName(releaseJob, "QEMU 설치");
  const buildxStep = workflowStepByName(releaseJob, "Docker Buildx 설치");
  assert.ok(qemuStep.offset < buildxStep.offset, "QEMU는 Buildx보다 먼저 설정해야 합니다");
  const qemuActionLines = workflow.match(/^        uses: docker\/setup-qemu-action@.*$/gmu) ?? [];
  assert.deepEqual(
    qemuActionLines,
    [`        uses: ${QEMU_SETUP_ACTION}`],
    "workflow 전체에는 digest로 고정한 QEMU action만 정확히 하나여야 합니다",
  );
  const binfmtImageLines = workflow.match(/^          image: .*tonistiigi\/binfmt.*$/gmu) ?? [];
  assert.deepEqual(
    binfmtImageLines,
    [`          image: ${QEMU_BINFMT_IMAGE}`],
    "workflow 전체에는 digest로 고정한 binfmt image만 정확히 하나여야 합니다",
  );
  expectSingleProperty(qemuStep.content, 8, "uses", QEMU_SETUP_ACTION, "workflow QEMU action이 다릅니다");
  expectSingleProperty(
    qemuStep.content,
    10,
    "image",
    QEMU_BINFMT_IMAGE,
    "workflow QEMU binfmt image가 digest로 고정되지 않았습니다",
  );
  expectSingleProperty(
    qemuStep.content,
    10,
    "platforms",
    QEMU_PLATFORMS,
    "workflow QEMU 대상 platform이 arm64로 제한되지 않았습니다",
  );

  const surrealWorkflowStep = workflowStepByName(releaseJob, "SurrealDB 이미지 빌드·게시");
  expectSingleProperty(surrealWorkflowStep.content, 8, "id", "surrealdb_image", "workflow SurrealDB step id가 다릅니다");
  expectSingleProperty(
    surrealWorkflowStep.content,
    10,
    "file",
    "deploy/surreal/Dockerfile",
    "workflow Dockerfile 경로가 다릅니다",
  );
  expectSingleProperty(
    surrealWorkflowStep.content,
    10,
    "push",
    "true",
    "workflow SurrealDB registry 게시가 비활성화됐습니다",
  );
  expectSingleProperty(
    surrealWorkflowStep.content,
    10,
    "tags",
    WORKFLOW_SURREALDB_TAG,
    "workflow SurrealDB 게시 tag가 다릅니다",
  );
  expectSingleProperty(
    surrealWorkflowStep.content,
    10,
    "platforms",
    WORKFLOW_SURREALDB_PLATFORMS,
    "workflow SurrealDB 다중 아키텍처가 다릅니다",
  );
  assert.doesNotMatch(workflow, /surrealdb:3\.2\.0-massion\.1/u, "workflow에 이전 SurrealDB registry tag가 남아 있습니다");

  expectComposeImage(compose, "surrealdb", COMPOSE_SURREALDB_IMAGE, "Compose SurrealDB 기본 이미지가 다릅니다");
  expectComposeImage(compose, "massion", COMPOSE_MASSION_IMAGE, "Compose Massion 기본 이미지가 다릅니다");
  expectComposeImage(
    compose,
    "database-provision",
    COMPOSE_MASSION_IMAGE,
    "Compose database provision 기본 이미지가 다릅니다",
  );
  expectComposeImage(compose, "caddy", COMPOSE_CADDY_IMAGE, "Compose Caddy 기본 이미지가 다릅니다");
  expectSingleProperty(
    kubernetesContainerBlock(kubernetes, "surrealdb"),
    10,
    "image",
    DEPLOY_SURREALDB_IMAGE,
    "Kubernetes SurrealDB 이미지가 다릅니다",
  );
  const releaseBundleImages = releaseBundleImagesBlock(builder);
  expectSingleProperty(releaseBundleImages, 10, "MASSION_IMAGE", '"massion:1.0.0",', "release bundle Massion 이미지가 다릅니다");
  expectSingleProperty(
    releaseBundleImages,
    10,
    "MASSION_SURREALDB_IMAGE",
    `"${DEPLOY_SURREALDB_IMAGE}",`,
    "release bundle SurrealDB 이미지가 다릅니다",
  );
  expectSingleProperty(
    releaseBundleImages,
    10,
    "MASSION_CADDY_IMAGE",
    '"massion-caddy:2.11.4",',
    "release bundle Caddy 이미지가 다릅니다",
  );
  const surrealStageLines = [...dockerfile.matchAll(/^FROM .* AS surreal$/gmu)].map(([line]) => line);
  assert.deepEqual(
    surrealStageLines,
    [`FROM ${UPSTREAM_SURREALDB_IMAGE} AS surreal`],
    "Dockerfile upstream SurrealDB OCI digest stage가 다릅니다",
  );
  const finalStage = finalDockerStage(dockerfile);
  expectSurrealBinaryCopy(finalStage);
  expectSingleDockerInstruction(finalStage, "USER", "surreal", "Dockerfile final 실행 사용자가 surreal로 고정되지 않았습니다");
  expectSingleDockerInstruction(
    finalStage,
    "ENTRYPOINT",
    '["/usr/local/bin/massion-surreal-entrypoint"]',
    "Dockerfile final entrypoint가 Massion SurrealDB entrypoint가 아닙니다",
  );
  const currentChangelog = currentChangelogSection(changelog);
  assert.match(
    currentChangelog,
    /^- 원격 SurrealDB 3\.2\.1,/mu,
    "CHANGELOG 현재 릴리스의 원격 SurrealDB 버전이 다릅니다",
  );
  assert.doesNotMatch(
    currentChangelog,
    /원격 SurrealDB 3\.2\.0/u,
    "CHANGELOG 현재 릴리스에 이전 원격 SurrealDB 버전이 남아 있습니다",
  );
  assert.doesNotMatch(remoteCliE2e, /surrealdb-3\.2\.0/u, "원격 CLI UAT에 이전 SurrealDB version literal이 남아 있습니다");
  assert.match(
    remoteCliE2e,
    /const expectedDatabaseVersion = await database\.version\(\);/u,
    "원격 CLI UAT가 실제 연결 database version을 고정하지 않습니다",
  );
  assert.match(
    remoteCliE2e,
    /queries: \{ status: async \(\) => \(\{ status: "ready", database: await database\.version\(\) \}\) \}/u,
    "원격 CLI UAT status query가 status 시점의 실제 database version을 읽지 않습니다",
  );
  assert.match(
    remoteCliE2e,
    /data: \{ status: "ready", database: expectedDatabaseVersion \}/u,
    "원격 CLI UAT status 기대값이 실제 연결 database version을 사용하지 않습니다",
  );
});
```

- [ ] 다음 명령을 실행해 새 테스트가 현재 3.2.0 계약 때문에 실패하는지 확인합니다.

```bash
node --test scripts/release-workflow.test.mjs
```

예상 결과는 종료 코드 `1`이며, `QEMU 설치 workflow step이 없습니다`, `workflow QEMU binfmt image가 digest로 고정되지 않았습니다`, `workflow SurrealDB 게시 tag가 다릅니다` 또는 이후의 3.2.1 계약 단언에서 실패해야 합니다. 문법 오류·파일 없음·테스트 러너 오류는 RED로 인정하지 않습니다.

## 작업 2: 가장 작은 원격 배포 변경으로 GREEN 만들기

**파일:**

- 수정: `.github/workflows/release.yml`
- 수정: `compose.yaml`
- 수정: `deploy/kubernetes/base/surreal-statefulset.yaml`
- 수정: `deploy/surreal/Dockerfile`
- 수정: `scripts/build-release.mjs`
- 수정: `CHANGELOG.md`
- 수정: `scripts/release-workflow.test.mjs`
- 수정: `apps/cli/src/remote.e2e.test.ts`
- 테스트: `scripts/release-workflow.test.mjs`

- [ ] 다음 다섯 원격 배포 소스와 `CHANGELOG.md`의 계약값을 변경하고, 작업 1의 계약 테스트를 교체합니다. 기존 opt-in 원격 CLI 사용자 인수 테스트(UAT)는 배포 이미지 version을 독자적으로 다시 고정하지 않고 실제 연결 database version을 기대값으로 사용하도록 보정합니다. `packages/application/src/artifacts.ts`와 `packages/extension-host/src/compliance.ts`는 수정하지 않습니다. Massion·Caddy 게시 단계에는 `platforms`를 추가하지 않습니다. QEMU 단계는 안전 스냅샷에서 복원하는 hunk가 아니라, SHA로 고정한 action이 privileged container를 실행할 때 mutable `binfmt:latest`와 전체 emulator 설치를 피하기 위한 사후 hardening입니다.

```text
.github/workflows/release.yml
  Docker Buildx 설치 직전:
    - name: QEMU 설치
      uses: docker/setup-qemu-action@96fe6ef7f33517b61c61be40b68a1882f3264fb8 # v4.2.0
      with:
        image: docker.io/tonistiigi/binfmt@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0
        platforms: arm64
  SurrealDB 이미지 빌드·게시 단계:
    tags: ${{ steps.identity.outputs.base }}/surrealdb:3.2.1-massion.1
    platforms: linux/amd64,linux/arm64

compose.yaml
  image: ${MASSION_SURREALDB_IMAGE:-massion-surrealdb:3.2.1}

deploy/kubernetes/base/surreal-statefulset.yaml
  image: massion-surrealdb:3.2.1

deploy/surreal/Dockerfile
  FROM surrealdb/surrealdb:v3.2.1@sha256:a0ef3252ec197a31a262423241061390f51ba95509a68f1866f0783ad8f39ea1 AS surreal

scripts/build-release.mjs
  MASSION_SURREALDB_IMAGE: "massion-surrealdb:3.2.1"

CHANGELOG.md
  원격 SurrealDB 3.2.1

apps/cli/src/remote.e2e.test.ts
  `createDatabase(...)` 직후:
    const expectedDatabaseVersion = await database.version();
  `ApplicationProduct.create(...)`의 status query:
    기존 `database: await database.version()`을 유지
  JSON status 기대값:
    data: { status: "ready", database: expectedDatabaseVersion }
```

- [ ] 아래의 대상 테스트를 다시 실행해 종료 코드 `0`을 확인합니다.

```bash
node --test scripts/release-workflow.test.mjs
```

- [ ] index가 비어 있는지 먼저 확인하고, 코드와 테스트만 스테이징합니다. staged 경로가 허용 목록과 정확히 같을 때만 커밋합니다. 이 커밋에는 증거 문서를 넣지 않습니다.

```bash
set -euo pipefail
pnpm exec prettier --check .github/workflows/release.yml compose.yaml deploy/kubernetes/base/surreal-statefulset.yaml scripts/build-release.mjs scripts/release-workflow.test.mjs apps/cli/src/remote.e2e.test.ts CHANGELOG.md
node --test scripts/release-workflow.test.mjs
pnpm --filter @massion/cli typecheck
for docker_variable in DOCKER_HOST DOCKER_CONTEXT BUILDX_BUILDER BUILDX_CONFIG BUILDKIT_HOST; do
  docker_value="$(printenv "$docker_variable" 2>/dev/null || true)"
  if [ -n "$docker_value" ]; then
    printf '%s\n' "${docker_variable}가 설정되어 있어 로컬 Dockerfile 검증을 시작하지 않습니다" >&2
    exit 1
  fi
done
docker_context="$(docker context show)"
docker_endpoint="$(docker context inspect "$docker_context" --format '{{ (index .Endpoints "docker").Host }}')"
case "$docker_endpoint" in
  unix://*) ;;
  *) printf '%s\n' "현재 Docker context가 로컬 Unix socket이 아니므로 중단합니다" >&2; exit 1 ;;
esac
buildx_inspect="$(docker --context "$docker_context" buildx inspect --bootstrap)"
buildx_builder="$(printf '%s\n' "$buildx_inspect" | awk '/^Name:/ { print $2; exit }')"
test -n "$buildx_builder" || {
  printf '%s\n' "현재 Docker context의 active Buildx builder를 찾지 못했습니다" >&2
  exit 1
}
buildx_inspect="$(docker --context "$docker_context" buildx inspect "$buildx_builder" --bootstrap)"
buildx_endpoint="$(printf '%s\n' "$buildx_inspect" | awk '/^Endpoint:/ { print $2; exit }')"
test "$buildx_endpoint" = "$docker_context" || {
  printf '%s\n' "active Buildx builder가 현재 Docker context endpoint를 사용하지 않습니다" >&2
  exit 1
}
printf '%s\n' "$buildx_inspect" | grep -Eq '^Driver:[[:space:]]+docker$' || {
  printf '%s\n' "active Buildx builder가 docker driver가 아닙니다" >&2
  exit 1
}
buildx_platforms="$(printf '%s\n' "$buildx_inspect" | sed -n 's/^Platforms:[[:space:]]*//p' | tr -d '[:space:]')"
for platform in linux/amd64 linux/arm64; do
  case ",$buildx_platforms," in
    *,"$platform",*) ;;
    *) printf '%s\n' "active Buildx builder가 $platform 을 지원하지 않습니다" >&2; exit 1 ;;
  esac
done
docker --context "$docker_context" buildx build --builder "$buildx_builder" --check --platform linux/arm64 -f deploy/surreal/Dockerfile .
git diff --cached --quiet || {
  printf '%s\n' "기존 staged 변경이 있어 Slice 1A 코드 커밋을 만들 수 없습니다" >&2
  exit 1
}
expected_worktree_paths="$(printf '%s\n' .github/workflows/release.yml CHANGELOG.md apps/cli/src/remote.e2e.test.ts compose.yaml deploy/kubernetes/base/surreal-statefulset.yaml deploy/surreal/Dockerfile scripts/build-release.mjs scripts/release-workflow.test.mjs | LC_ALL=C sort)"
actual_worktree_paths="$(git status --porcelain --untracked-files=all | sed -E 's/^.. //' | LC_ALL=C sort)"
test "$actual_worktree_paths" = "$expected_worktree_paths" || {
  printf '%s\n' "Slice 1A 코드 커밋 전에 허용되지 않은 작업 트리 변경이 있습니다" >&2
  exit 1
}
git add -- .github/workflows/release.yml compose.yaml deploy/kubernetes/base/surreal-statefulset.yaml deploy/surreal/Dockerfile scripts/build-release.mjs scripts/release-workflow.test.mjs apps/cli/src/remote.e2e.test.ts CHANGELOG.md
expected_paths="$expected_worktree_paths"
actual_paths="$(git diff --cached --name-only | LC_ALL=C sort)"
if [ "$actual_paths" != "$expected_paths" ]; then
  printf '%s\n' "Slice 1A 코드 커밋의 staged 경로가 허용 목록과 다릅니다" >&2
  exit 1
fi
git diff --cached --check
git commit -m "build(release): pin remote SurrealDB 3.2.1"
```

## 작업 3: 깨끗한 코드 커밋에서 실제 배포·릴리스 묶음 검증

**파일:** 코드 수정 없음. 작업 2의 코드 커밋에서만 실행합니다.

- [ ] 현재 작업 트리를 Docker build context로 쓰지 않습니다. 코드 커밋을 기준으로 새 임시 복제본(clean clone)을 만들고, 그 안에서 Compose·Kubernetes·두 Linux 플랫폼의 SurrealDB image·동결 설치·전체 품질 검증·릴리스 묶음·복구 검증을 실행합니다. clean clone이므로 개인 파일과 후속 증거 문서가 Docker context·릴리스 산출물에 섞이지 않습니다.

```bash
set -euo pipefail
source_root="$(git rev-parse --show-toplevel)"
code_commit="$(git rev-parse HEAD)"
scratch_root="$(mktemp -d)"
clean_root="$scratch_root/repository"
docker_context=""
docker_config="${DOCKER_CONFIG:-$HOME/.docker}"
case "$docker_config" in
  /*) ;;
  *) docker_config="$PWD/$docker_config" ;;
esac
run_id=""
arm64_image_tag=""
amd64_image_tag=""
arm64_image_id=""
amd64_image_id=""
arm64_iid_file="$scratch_root/arm64.iid"
amd64_iid_file="$scratch_root/amd64.iid"
surreal_smoke_secret="$scratch_root/surreal-smoke-password"
smoke_containers=""
toolchain_home="$scratch_root/toolchain-home"
corepack_home="$scratch_root/corepack-home"
corepack_bin="$scratch_root/corepack-bin"

docker_local() {
  docker --context "$docker_context" "$@"
}
remove_owned_image_tag() {
  image_tag="$1"
  image_id="$2"
  [ -n "$docker_context" ] && [ -n "$run_id" ] && [ -n "$image_tag" ] && [ -n "$image_id" ] || return 0
  current_image_id="$(docker_local image inspect --format '{{.Id}}' "$image_tag" 2>/dev/null || true)"
  current_run_id="$(docker_local image inspect --format '{{ index .Config.Labels "org.massion.slice1.validation-run" }}' "$image_tag" 2>/dev/null || true)"
  if [ "$current_image_id" = "$image_id" ] && [ "$current_run_id" = "$run_id" ]; then
    docker_local image rm "$image_tag" >/dev/null 2>&1 || true
  fi
}
cleanup() {
  for container in $smoke_containers; do
    docker_local container rm --force "$container" >/dev/null 2>&1 || true
  done
  remove_owned_image_tag "$arm64_image_tag" "$arm64_image_id"
  remove_owned_image_tag "$amd64_image_tag" "$amd64_image_id"
  rm -rf "$scratch_root"
}
trap cleanup EXIT

case "$(node --version)" in
  v24.*) ;;
  *) printf '%s\n' "Node.js 24가 필요합니다" >&2; exit 1 ;;
esac
test "$(bun --version)" = "1.3.14" || {
  printf '%s\n' "Bun 1.3.14가 필요합니다" >&2
  exit 1
}
run_id="$(node --input-type=module -e 'import { randomUUID } from "node:crypto"; process.stdout.write(randomUUID())')"

for docker_variable in DOCKER_HOST DOCKER_CONTEXT BUILDX_BUILDER BUILDX_CONFIG BUILDKIT_HOST; do
  docker_value="$(printenv "$docker_variable" 2>/dev/null || true)"
  if [ -n "$docker_value" ]; then
    printf '%s\n' "${docker_variable}가 설정되어 있어 로컬 Docker 검증을 시작하지 않습니다" >&2
    exit 1
  fi
done
docker_context="$(docker context show)"
docker_endpoint="$(docker context inspect "$docker_context" --format '{{ (index .Endpoints "docker").Host }}')"
case "$docker_endpoint" in
  unix://*) ;;
  *) printf '%s\n' "현재 Docker context가 로컬 Unix socket이 아니므로 중단합니다" >&2; exit 1 ;;
esac
buildx_inspect="$(docker --context "$docker_context" buildx inspect --bootstrap)"
buildx_builder="$(printf '%s\n' "$buildx_inspect" | awk '/^Name:/ { print $2; exit }')"
test -n "$buildx_builder" || {
  printf '%s\n' "현재 Docker context의 active Buildx builder를 찾지 못했습니다" >&2
  exit 1
}
buildx_inspect="$(docker --context "$docker_context" buildx inspect "$buildx_builder" --bootstrap)"
buildx_endpoint="$(printf '%s\n' "$buildx_inspect" | awk '/^Endpoint:/ { print $2; exit }')"
test "$buildx_endpoint" = "$docker_context" || {
  printf '%s\n' "active Buildx builder가 현재 Docker context endpoint를 사용하지 않습니다" >&2
  exit 1
}
printf '%s\n' "$buildx_inspect" | grep -Eq '^Driver:[[:space:]]+docker$' || {
  printf '%s\n' "active Buildx builder가 docker driver가 아닙니다" >&2
  exit 1
}
buildx_platforms="$(printf '%s\n' "$buildx_inspect" | sed -n 's/^Platforms:[[:space:]]*//p' | tr -d '[:space:]')"
for platform in linux/amd64 linux/arm64; do
  case ",$buildx_platforms," in
    *,"$platform",*) ;;
    *) printf '%s\n' "active Buildx builder가 $platform 을 지원하지 않습니다" >&2; exit 1 ;;
  esac
done

git clone --no-local "$source_root" "$clean_root"
cd "$clean_root"
git checkout --detach "$code_commit"
test -z "$(git status --porcelain --untracked-files=all)" || {
  printf '%s\n' "clean clone이 비어 있지 않습니다" >&2
  exit 1
}
mkdir -p "$scratch_root/tmp"
export TMPDIR="$scratch_root/tmp"

compose_defaults() {
  env -i \
    PATH="$PATH" \
    HOME="$HOME" \
    DOCKER_CONFIG="$docker_config" \
    TMPDIR="$TMPDIR" \
    docker --context "$docker_context" compose --env-file /dev/null --file "$clean_root/compose.yaml" --project-directory "$clean_root" "$@"
}
archive_compose_defaults() {
  env -i \
    PATH="$PATH" \
    HOME="$HOME" \
    DOCKER_CONFIG="$docker_config" \
    TMPDIR="$TMPDIR" \
    docker --context "$docker_context" compose --env-file /dev/null --file "$deploy_extract/compose.yaml" --project-directory "$deploy_extract" "$@"
}
require_compose_image_count() {
  images="$1"
  image="$2"
  expected_count="$3"
  actual_count="$(printf '%s\n' "$images" | grep -Fxc "$image" || true)"
  test "$actual_count" = "$expected_count" || {
    printf '%s\n' "Compose 기본 image가 기대값과 다릅니다: $image" >&2
    exit 1
  }
}
compose_defaults config --quiet
compose_images="$(compose_defaults config --images)"
require_compose_image_count "$compose_images" "massion-surrealdb:3.2.1" 1
require_compose_image_count "$compose_images" "massion:1.0.0" 2
require_compose_image_count "$compose_images" "massion-caddy:2.11.4" 1
kubernetes_render="$(kubectl kustomize deploy/kubernetes/base)"
kubernetes_image_count="$(printf '%s\n' "$kubernetes_render" | grep -Ec '^[[:space:]]+image: massion-surrealdb:3\.2\.1$' || true)"
test "$kubernetes_image_count" = "1" || {
  printf '%s\n' "Kubernetes 기본 SurrealDB image가 기대값과 다릅니다" >&2
  exit 1
}

arm64_image_tag="massion-surrealdb:3.2.1-slice1-arm64-$run_id"
amd64_image_tag="massion-surrealdb:3.2.1-slice1-amd64-$run_id"
for image_tag in "$arm64_image_tag" "$amd64_image_tag"; do
  if docker_local image inspect "$image_tag" >/dev/null 2>&1; then
    printf '%s\n' "검증용 Docker image tag가 이미 존재합니다: $image_tag" >&2
    exit 1
  fi
done
node --input-type=module -e '
  import { randomBytes } from "node:crypto";
  import { writeFile } from "node:fs/promises";
  await writeFile(process.argv[1], randomBytes(24).toString("base64url"), { mode: 0o600 });
' "$surreal_smoke_secret"
chmod 0444 "$surreal_smoke_secret"

docker_local buildx build --builder "$buildx_builder" --pull --platform linux/arm64 --load --iidfile "$arm64_iid_file" --label "org.massion.slice1.validation-run=$run_id" --tag "$arm64_image_tag" -f deploy/surreal/Dockerfile .
arm64_image_id="$(tr -d '\r\n' < "$arm64_iid_file")"
test -n "$arm64_image_id" || {
  printf '%s\n' "linux/arm64 build가 image ID를 만들지 않았습니다" >&2
  exit 1
}
test "$(docker_local image inspect --format '{{ index .Config.Labels "org.massion.slice1.validation-run" }}' "$arm64_image_id")" = "$run_id" || {
  printf '%s\n' "linux/arm64 build image의 검증 소유 label이 다릅니다" >&2
  exit 1
}
test "$(docker_local image inspect --format '{{.Os}}/{{.Architecture}}' "$arm64_image_id")" = "linux/arm64" || {
  printf '%s\n' "linux/arm64 build image의 platform metadata가 다릅니다" >&2
  exit 1
}
verify_surreal_image_config() {
  target_platform="$1"
  target_image_id="$2"
  test "$(docker_local image inspect --format '{{.Config.User}}' "$target_image_id")" = "surreal" || {
    printf '%s\n' "$target_platform build image의 Config.User가 surreal이 아닙니다" >&2
    exit 1
  }
  test "$(docker_local image inspect --format '{{json .Config.Entrypoint}}' "$target_image_id")" = '["/usr/local/bin/massion-surreal-entrypoint"]' || {
    printf '%s\n' "$target_platform build image의 Config.Entrypoint가 다릅니다" >&2
    exit 1
  }
}
verify_surreal_image_config linux/arm64 "$arm64_image_id"
arm64_version="$(docker_local run --rm --platform linux/arm64 --entrypoint /usr/local/bin/surreal "$arm64_image_id" version)"
printf '%s\n' "$arm64_version" | grep -Eq '(^|[^0-9])3\.2\.1([^0-9]|$)' || {
  printf '%s\n' "linux/arm64 SurrealDB version이 3.2.1이 아닙니다" >&2
  exit 1
}
printf '%s\n' "linux/arm64 SurrealDB version: $arm64_version"

run_surreal_entrypoint_smoke() {
  platform="$1"
  image_id="$2"
  suffix="$3"
  container="massion-surrealdb-slice1-$suffix-$run_id"
  if docker_local container inspect "$container" >/dev/null 2>&1; then
    printf '%s\n' "검증용 Docker container 이름이 이미 존재합니다: $container" >&2
    exit 1
  fi
  docker_local run --detach --rm --name "$container" --platform "$platform" \
    --env SURREAL_PASSWORD_FILE=/run/secrets/database_password \
    --mount "type=bind,src=$surreal_smoke_secret,dst=/run/secrets/database_password,readonly" \
    "$image_id" >/dev/null
  smoke_containers="${smoke_containers}${smoke_containers:+ }$container"
  attempt=0
  until docker_local exec "$container" /usr/local/bin/surreal is-ready --endpoint http://127.0.0.1:8000 >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 30 ]; then
      printf '%s\n' "$platform SurrealDB entrypoint readiness가 30초 안에 성공하지 않았습니다" >&2
      exit 1
    fi
    sleep 1
  done
  test "$(docker_local exec "$container" id -u)" = "10001" || {
    printf '%s\n' "$platform SurrealDB container가 uid 10001로 실행되지 않았습니다" >&2
    exit 1
  }
  docker_local exec "$container" sh -ec 'test -e /data/massion.db'
  docker_local container rm --force "$container" >/dev/null
}
run_surreal_entrypoint_smoke linux/arm64 "$arm64_image_id" arm64

docker_local buildx build --builder "$buildx_builder" --pull --platform linux/amd64 --load --iidfile "$amd64_iid_file" --label "org.massion.slice1.validation-run=$run_id" --tag "$amd64_image_tag" -f deploy/surreal/Dockerfile .
amd64_image_id="$(tr -d '\r\n' < "$amd64_iid_file")"
test -n "$amd64_image_id" || {
  printf '%s\n' "linux/amd64 build가 image ID를 만들지 않았습니다" >&2
  exit 1
}
test "$(docker_local image inspect --format '{{ index .Config.Labels "org.massion.slice1.validation-run" }}' "$amd64_image_id")" = "$run_id" || {
  printf '%s\n' "linux/amd64 build image의 검증 소유 label이 다릅니다" >&2
  exit 1
}
test "$(docker_local image inspect --format '{{.Os}}/{{.Architecture}}' "$amd64_image_id")" = "linux/amd64" || {
  printf '%s\n' "linux/amd64 build image의 platform metadata가 다릅니다" >&2
  exit 1
}
verify_surreal_image_config linux/amd64 "$amd64_image_id"
amd64_version="$(docker_local run --rm --platform linux/amd64 --entrypoint /usr/local/bin/surreal "$amd64_image_id" version)"
printf '%s\n' "$amd64_version" | grep -Eq '(^|[^0-9])3\.2\.1([^0-9]|$)' || {
  printf '%s\n' "linux/amd64 SurrealDB version이 3.2.1이 아닙니다" >&2
  exit 1
}
printf '%s\n' "linux/amd64 SurrealDB version: $amd64_version"
run_surreal_entrypoint_smoke linux/amd64 "$amd64_image_id" amd64

mkdir -p "$toolchain_home" "$corepack_home" "$corepack_bin"
export HOME="$toolchain_home"
export COREPACK_HOME="$corepack_home"
export DOCKER_CONFIG="$docker_config"
export NPM_CONFIG_USERCONFIG="$scratch_root/npmrc"
export NPM_CONFIG_CACHE="$scratch_root/npm-cache"
export XDG_CACHE_HOME="$scratch_root/xdg-cache"
export PATH="$corepack_bin:$PATH"
corepack enable --install-directory "$corepack_bin"
corepack prepare pnpm@11.13.0 --activate
test "$(command -v pnpm)" = "$corepack_bin/pnpm" || {
  printf '%s\n' "pnpm shim이 clean clone 내부에 설치되지 않았습니다" >&2
  exit 1
}
test "$(pnpm --version)" = "11.13.0" || {
  printf '%s\n' "pnpm 11.13.0이 필요합니다" >&2
  exit 1
}
without_remote_surreal() {
  env -u SURREAL_TEST_URL "$@"
}
without_remote_surreal pnpm install --frozen-lockfile --store-dir "$scratch_root/pnpm-store"
without_remote_surreal node --test scripts/release-workflow.test.mjs
without_remote_surreal pnpm verify
without_remote_surreal pnpm verify:security
without_remote_surreal pnpm verify:hardening
test -z "$(git status --porcelain --untracked-files=all)" || {
  printf '%s\n' "전체 품질 검증 뒤 clean clone의 tracked 상태가 바뀌었습니다" >&2
  exit 1
}
without_remote_surreal pnpm release:build
without_remote_surreal pnpm verify:release artifacts/release-1.0.0
test -z "$(git status --porcelain --untracked-files=all)" || {
  printf '%s\n' "릴리스 묶음 생성·복구 검증 뒤 clean clone의 tracked 상태가 바뀌었습니다" >&2
  exit 1
}

deploy_extract="$scratch_root/deploy-release"
mkdir "$deploy_extract"
tar -xzf artifacts/release-1.0.0/massion-deploy-1.0.0.tar.gz -C "$deploy_extract"
without_remote_surreal node --input-type=module -e '
  import assert from "node:assert/strict";
  import { readFile } from "node:fs/promises";
  import { join } from "node:path";
  const root = process.argv[1];
  const bundle = JSON.parse(await readFile(join(root, "release-bundle.json"), "utf8"));
  assert.deepEqual(bundle.images, {
    MASSION_IMAGE: "massion:1.0.0",
    MASSION_SURREALDB_IMAGE: "massion-surrealdb:3.2.1",
    MASSION_CADDY_IMAGE: "massion-caddy:2.11.4",
  });
  const compose = await readFile(join(root, "compose.yaml"), "utf8");
  assert.match(compose, /^    image: \$\{MASSION_SURREALDB_IMAGE:-massion-surrealdb:3\.2\.1\}$/mu);
  const dockerfile = await readFile(join(root, "deploy", "surreal", "Dockerfile"), "utf8");
  assert.match(
    dockerfile,
    /^FROM surrealdb\/surrealdb:v3\.2\.1@sha256:a0ef3252ec197a31a262423241061390f51ba95509a68f1866f0783ad8f39ea1 AS surreal$/mu,
  );
  const finalStageOffset = dockerfile.lastIndexOf("\nFROM ");
  assert.notEqual(finalStageOffset, -1, "archive Dockerfile final stage가 없습니다");
  const finalStage = dockerfile.slice(finalStageOffset + 1);
  assert.deepEqual([...finalStage.matchAll(/^USER .*$/gmu)].map(([line]) => line), ["USER surreal"]);
  assert.deepEqual(
    [...finalStage.matchAll(/^ENTRYPOINT .*$/gmu)].map(([line]) => line),
    ['ENTRYPOINT ["/usr/local/bin/massion-surreal-entrypoint"]'],
  );
  assert.deepEqual(
    [...finalStage.matchAll(/^COPY .+ \/usr\/local\/bin\/surreal$/gmu)].map(([line]) => line),
    ["COPY --from=surreal /surreal /usr/local/bin/surreal"],
  );
' "$deploy_extract"
archive_compose_defaults config --quiet
archive_compose_images="$(archive_compose_defaults config --images)"
require_compose_image_count "$archive_compose_images" "massion-surrealdb:3.2.1" 1
require_compose_image_count "$archive_compose_images" "massion:1.0.0" 2
require_compose_image_count "$archive_compose_images" "massion-caddy:2.11.4" 1
archive_kubernetes_render="$(kubectl kustomize "$deploy_extract/deploy/kubernetes/base")"
archive_kubernetes_image_count="$(printf '%s\n' "$archive_kubernetes_render" | grep -Ec '^[[:space:]]+image: massion-surrealdb:3\.2\.1$' || true)"
test "$archive_kubernetes_image_count" = "1" || {
  printf '%s\n' "deploy archive의 Kubernetes SurrealDB image가 기대값과 다릅니다" >&2
  exit 1
}
```

모든 명령의 종료 코드는 `0`이어야 하고, `arm64_version`·`amd64_version` 출력에는 각각 숫자 경계가 있는 `3.2.1`이 포함되어야 합니다. Docker 환경 변수가 설정된 경우에는 검증을 시작하지 않고, 현재 context의 endpoint가 local Unix socket이며 그 context가 선택한 active Buildx builder가 `docker` driver와 `linux/amd64`, `linux/arm64`를 모두 제공할 때만 명시한 context·builder를 사용합니다. 증거 문서에는 local Unix-socket·`docker` driver·target platform 검증 사실만 기록하고 context·builder 이름과 socket 경로는 기록하지 않습니다. 두 image tag는 무작위 UUID와 검증 label·image ID로 소유권을 확인하며, cleanup은 현재 tag가 이번 실행의 같은 image ID·label을 가리킬 때만 force 없이 tag를 해제합니다. 따라서 다른 작업의 image나 tag를 삭제하지 않습니다. 각 image의 Config.User·Config.Entrypoint와 두 실제 container smoke는 non-root `surreal` 사용자(uid 10001), 임시 비밀 파일을 읽는 Massion entrypoint, `/data/massion.db` RocksDB 상태와 readiness를 각각 확인하고, 비밀값은 출력·문서화하지 않습니다. Compose는 `env -i`의 최소 환경, 명시한 파일·project directory·빈 env file만 사용하므로 외부 Compose 제어 변수, 모든 Massion override, secret 경로를 상속하지 않습니다. source와 deploy archive 모두에서 Compose image와 Kustomize 출력의 기대 image를 정확히 한 번 확인하며 archive 안의 SurrealDB Dockerfile digest도 확인합니다. `SURREAL_TEST_URL`이 있으면 여러 workspace의 원격 계약 테스트가 인증된 외부 데이터베이스에 실제 쓰기를 할 수 있으므로, clean clone의 설치·테스트·빌드·릴리스 검증에서는 반드시 제거합니다. 인증된 원격 SurrealDB 사용자 인수 테스트(UAT)는 별도 opt-in 시나리오로만 실행하고 이 작업의 성공 근거로 섞지 않습니다. Corepack shim·cache·사용자 home·pnpm store/cache·Node 임시 파일은 clone 밖의 scratch 안에만 만듭니다. 공유 Docker build cache나 다른 프로젝트 image를 전역 prune하지 않습니다. 이 검증은 SurrealDB binary version과 배포 참조를 증명하며 final Debian base·APT 결과를 포함한 image byte 재현성을 주장하지 않습니다.

## 작업 4: 코드 SHA와 검증 근거를 문서 커밋으로 닫기

**파일:**

- 생성: `docs/evidence/phase-30/slice-1a-remote-surrealdb-2026-07-18.md`
- 수정: `docs/evidence/phase-30/surrealdb-runtime-boundary-2026-07-18.md`
- 수정: `docs/phases/30-surface-parity-agent-ux/implementation-plan.md`
- 수정: `docs/phases/30-surface-parity-agent-ux/reconciliation-plan.md`
- 수정: `docs/phases/30-surface-parity-agent-ux/reconciliation-manifest.json`
- 테스트: `scripts/verify-docs.test.mjs`, `scripts/verify-phase30-reconciliation.test.mjs`

- [ ] Slice 1A 증거 문서에는 코드 커밋 SHA, 실행 시각, Node·pnpm·Bun 버전, Docker·kubectl 버전, 각 명령의 종료 코드, local Unix-socket·현재 context endpoint 일치·`docker` Buildx driver·두 target platform 확인 결과, source와 archive의 resolved Compose image, arm64·amd64 `docker run`의 3.2.1 출력, 두 entrypoint readiness smoke, archive 이미지 객체·Dockerfile digest·Kustomize 검증, clean clone의 HEAD를 기록합니다. 기존 opt-in 원격 CLI UAT는 실제 연결 database version을 기대하도록 코드 계약만 보정했고, 인증된 원격 UAT를 이번 성공 근거로 실행하지 않았다는 사실도 기록합니다. GitHub registry 실제 게시는 인증된 새 tag workflow에서만 가능하므로, 로컬 증거에는 QEMU·`platforms: linux/amd64,linux/arm64` workflow 계약 테스트가 통과했음을 별도로 기록하고, 실제 registry push를 로컬에서 했다고 기록하지 않습니다. context·builder 이름, socket 경로·사용자 경로·이메일·토큰·프로필 경로·비밀값은 적지 않습니다.
- [ ] 기존 런타임 경계 조사 문서에는 안전 스냅샷이 제공한 원격 SurrealDB six-path 후보와, 이번 Slice 1A에서 추가한 QEMU action·binfmt digest·arm64-only emulator hardening, opt-in CLI UAT의 3.2.0 literal 호환성 보정을 서로 다른 출처로 기록합니다. Slice 1A가 Buildx action의 runtime Buildx·BuildKit image와 Dockerfile frontend image까지 고정하지 않는 경계와 Release Recovery에 남긴 이유도 명시합니다. 공개 `v1.0.0` tag가 새 커밋에서 재실행되지 않는 사실과 그 실패 run의 품질 검증 단계를 기록하되, 이 문서에서 새 version·tag를 결정하거나 registry release 성공을 주장하지 않습니다.
- [ ] 아래 명령으로 공개 `v1.0.0` tag·Release·실패한 workflow run을 다시 조회하고, 관측 시각·public tag SHA·run URL·`전체 품질 검증` 실패와 이후 build·publish·attestation skip 사실만 증거 문서에 기록합니다. 공개 tag가 `ecd35b1b34e4e8797da6e458c4d69e857bd90656`이 아닐 때는 문서화하지 않고 중단합니다. 로컬 경로·환경 변수·인증 정보는 기록하지 않습니다.

```bash
set -euo pipefail
printf 'GitHub 관측 시각: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
expected_public_tag_sha="ecd35b1b34e4e8797da6e458c4d69e857bd90656"
actual_public_tag_sha="$(git ls-remote origin refs/tags/v1.0.0 | awk '$2 == "refs/tags/v1.0.0" { print $1 }')"
test "$actual_public_tag_sha" = "$expected_public_tag_sha" || {
  printf '%s\n' "공개 v1.0.0 tag SHA가 기대값과 다릅니다" >&2
  exit 1
}
printf '공개 v1.0.0 tag SHA: %s\n' "$actual_public_tag_sha"
gh release view v1.0.0 --repo jabdori/massion --json tagName,isDraft,isPrerelease,publishedAt,url
gh run view 29439133101 --repo jabdori/massion --json databaseId,displayTitle,event,headBranch,headSha,status,conclusion,url,jobs
gh run view 29439133101 --repo jabdori/massion --log-failed | rg -n '전체 품질 검증|verify-docs|존재하지 않는 추적 커밋|not found'
```
- [ ] `implementation-plan.md`에는 기존 Task 0B의 `[ ]` 항목을 `[x]`로 바꾸지 않고, 그 아래에 Slice 1A 코드 SHA·검증 증거 링크·Slice 1B 미완료 경계와, 안전 스냅샷 밖 opt-in CLI UAT 3.2.0 literal 호환성 보정을 설명하는 일반 기록 문장을 추가합니다. `scripts/verify-phase30-reconciliation.test.mjs`는 이 문서의 완료 체크박스를 의도적으로 금지하므로, 실제 근거가 있어도 완료 checkbox를 추가하면 안 됩니다.
- [ ] `reconciliation-plan.md`의 Slice 1 전체 상태는 Slice 1A 완료와 Slice 1B 미완료를 반영해 부분 구현(partial)으로만 올리고, Slice 1A 코드 SHA·검증 증거 링크와 안전 스냅샷 밖 opt-in CLI UAT 3.2.0 literal 호환성 보정을 일반 기록 문장으로 추가합니다. Slice 1 전체를 커밋 완료 상태나 `[x]` 체크박스로 표시하지 않습니다.
- [ ] 정합성 원장(reconciliation manifest)의 Slice 1은 아래처럼 `partial`로만 올립니다. `baseCommit`, `safetyCommit`, `safetyDiff`의 hash·entries와 Slice 1의 전체 verification 목록·primary paths는 변경하지 않습니다.

```json
{
  "id": "1",
  "title": "SurrealDB 릴리스 기반",
  "purpose": "원격 배포 SurrealDB 3.2.1 계약(Slice 1A)은 검증했으며, 개인용 로컬 runtime version 전달(Slice 1B)은 별도 TDD 설계 전까지 미완료로 남긴다.",
  "status": "partial"
}
```

- [ ] 다음 문서 검증을 실행합니다.

```bash
pnpm exec prettier --check docs/evidence/phase-30/slice-1a-remote-surrealdb-2026-07-18.md docs/evidence/phase-30/surrealdb-runtime-boundary-2026-07-18.md docs/phases/30-surface-parity-agent-ux/implementation-plan.md docs/phases/30-surface-parity-agent-ux/reconciliation-plan.md docs/phases/30-surface-parity-agent-ux/reconciliation-manifest.json
node --test scripts/verify-docs.test.mjs scripts/verify-phase30-reconciliation.test.mjs
pnpm verify:docs
node scripts/verify-phase30-reconciliation.mjs --require-safety
git diff --check
```

- [ ] index가 비어 있는지 먼저 확인하고, 문서만 스테이징합니다. staged 경로가 허용 목록과 정확히 같을 때만 커밋합니다.

```bash
set -euo pipefail
pnpm exec prettier --check docs/evidence/phase-30/slice-1a-remote-surrealdb-2026-07-18.md docs/evidence/phase-30/surrealdb-runtime-boundary-2026-07-18.md docs/phases/30-surface-parity-agent-ux/implementation-plan.md docs/phases/30-surface-parity-agent-ux/reconciliation-plan.md docs/phases/30-surface-parity-agent-ux/reconciliation-manifest.json
node --test scripts/verify-docs.test.mjs scripts/verify-phase30-reconciliation.test.mjs
pnpm verify:docs
node scripts/verify-phase30-reconciliation.mjs --require-safety
git diff --check
git diff --cached --quiet || {
  printf '%s\n' "기존 staged 변경이 있어 Slice 1A 문서 커밋을 만들 수 없습니다" >&2
  exit 1
}
expected_worktree_paths="$(printf '%s\n' docs/evidence/phase-30/slice-1a-remote-surrealdb-2026-07-18.md docs/evidence/phase-30/surrealdb-runtime-boundary-2026-07-18.md docs/phases/30-surface-parity-agent-ux/implementation-plan.md docs/phases/30-surface-parity-agent-ux/reconciliation-plan.md docs/phases/30-surface-parity-agent-ux/reconciliation-manifest.json | LC_ALL=C sort)"
actual_worktree_paths="$(git status --porcelain --untracked-files=all | sed -E 's/^.. //' | LC_ALL=C sort)"
test "$actual_worktree_paths" = "$expected_worktree_paths" || {
  printf '%s\n' "Slice 1A 문서 커밋 전에 허용되지 않은 작업 트리 변경이 있습니다" >&2
  exit 1
}
git add -- docs/evidence/phase-30/slice-1a-remote-surrealdb-2026-07-18.md docs/evidence/phase-30/surrealdb-runtime-boundary-2026-07-18.md docs/phases/30-surface-parity-agent-ux/implementation-plan.md docs/phases/30-surface-parity-agent-ux/reconciliation-plan.md docs/phases/30-surface-parity-agent-ux/reconciliation-manifest.json
expected_paths="$expected_worktree_paths"
actual_paths="$(git diff --cached --name-only | LC_ALL=C sort)"
if [ "$actual_paths" != "$expected_paths" ]; then
  printf '%s\n' "Slice 1A 문서 커밋의 staged 경로가 허용 목록과 다릅니다" >&2
  exit 1
fi
git diff --cached --check
git commit -m "docs(phase-30): record remote SurrealDB validation"
```

## 후속 Release Recovery 경계

공개 `v1.0.0` tag와 Release는 이미 존재하고, 현재 workflow trigger는 정확히 `v1.0.0`만 받습니다. 따라서 Slice 1A의 새 코드 커밋은 GitHub registry publish를 다시 실행하지 않습니다. 기존 tag를 이동·재생성·덮어쓰면 공개 artifact의 계보와 사용자 설치 재현성을 훼손하므로 금지합니다.

실제 GitHub Container Registry artifact와 attestation은 별도 Release Recovery 설계·승인을 거쳐 새 patch version과 새 tag에서만 검증합니다. 그 설계에는 최소한 다음의 독립 범위를 포함해야 합니다.

- `actions/checkout`의 complete history checkout(`fetch-depth: 0`)과, 현재 `pnpm verify`가 기록한 역사적 commit을 찾을 수 있도록 하는 CI RED→GREEN 회귀 테스트
- `docker/setup-buildx-action`이 실제로 사용하는 Buildx version과 Docker-container BuildKit image digest, `# syntax=docker/dockerfile:1.12` Dockerfile frontend image digest의 supply-chain 고정, 그리고 그 계약을 우회하지 못하게 하는 CI 회귀 테스트
- root·workspace package·CLI·installer·release bundle·workflow path/image·문서의 version topology 전수 조사와 일관된 새 version 반영
- 새 tag를 사용한 실제 GitHub Actions 품질 검증, multi-architecture SurrealDB publish, SBOM·provenance·attestation 결과의 외부 관측
- 공개 Release·GHCR digest·실행 run URL·실패 시 로그를 비밀정보 없이 기록하는 후속 근거 문서

새 version 번호는 이 Slice 1A 계획에서 결정하지 않습니다. 이 작업의 완료 판정은 소스 workflow 계약과 로컬 clean clone 검증까지이며, 실제 공개 registry release 성공을 뜻하지 않습니다.

## 완료 판정

- [ ] 작업 1의 새 계약 테스트가 구현 전에 기대한 이유로 RED였습니다.
- [ ] 작업 2 뒤 대상 테스트가 GREEN이며, 원격 배포 다섯 소스·`CHANGELOG.md`·계약 테스트와 opt-in 원격 CLI UAT 호환성 보정만 변경됐습니다.
- [ ] 작업 3의 clean clone Compose 기본 이미지 해석·Kubernetes·linux/arm64와 linux/amd64 실제 Docker image·전체 검증·릴리스 묶음·deploy archive 검증이 모두 종료 코드 `0`이며, 작업 1의 workflow 계약은 SurrealDB registry artifact의 QEMU·다중 아키텍처 게시 설정을 검증합니다.
- [ ] 작업 4의 증거·원장이 실제 코드 SHA와 출력만 가리키고, 안전 스냅샷 복원과 QEMU hardening 출처를 구분하며, Slice 1B의 로컬 runtime version 설계를 완료로 표시하지 않습니다.
- [ ] 실제 GitHub Container Registry publish·새 공개 Release·attestation 성공은 이 계획의 완료 주장이 아니며, 후속 Release Recovery에서 별도로 검증합니다.
- [ ] 구현자 자체 검토 뒤 독립 명세 검토와 독립 품질 검토가 모두 승인했습니다.
