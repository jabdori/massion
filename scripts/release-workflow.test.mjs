import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

const SHA_PIN = /uses:\s+[\w./-]+@[a-f0-9]{40}(?:\s+#.*)?$/mu;

test("레거시 release workflow는 수동 실행과 job 조건에서 이중으로 게시를 차단한다", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const uses = workflow.match(/^\s*uses:.*$/gmu) ?? [];

  assert.ok(uses.length >= 8, "release action 단계가 누락됐습니다");
  for (const line of uses) assert.match(line, SHA_PIN, `action을 commit SHA로 고정해야 합니다: ${line.trim()}`);
  assert.match(workflow, /^name: Legacy 1\.0 Release \(disabled\)$/mu);
  assert.match(workflow, /^on:\n {2}workflow_dispatch:\n\npermissions:$/mu);
  assert.doesNotMatch(workflow, /^ {2}push:$/mu);
  assert.match(workflow, /^ {4}if: \$\{\{ false \}\}$/mu);
  assert.doesNotMatch(workflow, /^\s+(?:artifact-metadata|attestations|id-token|packages):\s*write$/mu);
  assert.match(workflow, /provenance:\s*mode=max/u);
  assert.match(workflow, /sbom:\s*true/u);
  assert.match(workflow, /pnpm verify\b/u);
  assert.match(workflow, /pnpm verify:security\b/u);
  assert.match(workflow, /pnpm verify:hardening\b/u);
  assert.match(workflow, /pnpm verify:release\b/u);
});

const SURREALDB_VERSION = "3.2.1";
const SURREALDB_DIGEST = "sha256:a0ef3252ec197a31a262423241061390f51ba95509a68f1866f0783ad8f39ea1";
const WORKFLOW_SURREALDB_TAG = "${{ steps.identity.outputs.base }}/surrealdb:3.2.1-massion.1";
const QEMU_SETUP_ACTION = "docker/setup-qemu-action@96fe6ef7f33517b61c61be40b68a1882f3264fb8 # v4.2.0";
const QEMU_BINFMT_IMAGE =
  "docker.io/tonistiigi/binfmt@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0";
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
  const end = workflow.indexOf("\n      - ", start + 1);
  return { content: workflow.slice(start, end === -1 ? undefined : end), offset: start };
}

function workflowJobByName(workflow, name) {
  const jobsStart = workflow.indexOf("\njobs:\n");
  assert.ok(jobsStart !== -1, "workflow jobs section이 없습니다");
  const jobs = workflow.slice(jobsStart + "\njobs:\n".length);
  const jobHeadings = [...jobs.matchAll(/^ {2}[^\s][^:\n]*:$/gmu)];
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
  const lines = [...block.matchAll(new RegExp(`^${escapeRegularExpression(prefix)}.*$`, "gmu"))].map(([line]) => line);
  assert.deepEqual(lines, [`${prefix}${value}`], message);
}

function expectSingleDockerInstruction(stage, instruction, value, message) {
  const prefix = `${instruction} `;
  const lines = [...stage.matchAll(new RegExp(`^${escapeRegularExpression(prefix)}.*$`, "gmu"))].map(([line]) => line);
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

function expectSingleBlock(source, expression, expected, message) {
  const blocks = [...source.matchAll(expression)].map(([block]) => block);
  assert.deepEqual(blocks, [expected], message);
}

function releaseBundleImagesBlock(builder) {
  const anchor = 'await writeFile(\n    resolve(deploy, "release-bundle.json"),';
  const anchorCount = builder.split(anchor).length - 1;
  assert.equal(anchorCount, 1, "release-bundle.json writeFile 호출은 정확히 하나여야 합니다");
  const start = builder.indexOf(anchor);
  const end = builder.indexOf("\n  );", start);
  assert.notEqual(end, -1, "release-bundle.json writeFile 호출의 끝을 찾지 못했습니다");
  const releaseBundleWrite = builder.slice(start, end);
  const matches = [...releaseBundleWrite.matchAll(/^ {8}images: \{\n(?<body>(?:^ {10}.*\n?)*)^ {8}\},$/gmu)];
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

function kubernetesInitContainerBlock(kubernetes, containerName) {
  const initContainerSections = [
    ...kubernetes.matchAll(/^ {6}initContainers:\n(?<body>(?:^ {8}.*\n?)*)^ {6}containers:/gmu),
  ];
  assert.equal(initContainerSections.length, 1, "Kubernetes initContainers section은 정확히 하나여야 합니다");
  const [initContainers] = initContainerSections;
  assert.ok(initContainers.groups?.body, "Kubernetes initContainers section이 없습니다");
  const initContainerSource = initContainers.groups.body;
  const heading = new RegExp(`^        - name: ${escapeRegularExpression(containerName)}$`, "gmu");
  const matches = [...initContainerSource.matchAll(heading)];
  assert.equal(matches.length, 1, `${containerName} Kubernetes init container는 정확히 하나여야 합니다`);
  const [match] = matches;
  const start = match.index;
  const end = initContainerSource.indexOf("\n        - name: ", start + 1);
  return initContainerSource.slice(start, end === -1 ? undefined : end);
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
  expectSingleProperty(
    releaseJob,
    4,
    "runs-on",
    RELEASE_RUNNER,
    "release workflow runner가 x64 ubuntu-24.04가 아닙니다",
  );
  const qemuStep = workflowStepByName(releaseJob, "QEMU 설치");
  const buildxStep = workflowStepByName(releaseJob, "Docker Buildx 설치");
  assert.ok(qemuStep.offset < buildxStep.offset, "QEMU는 Buildx보다 먼저 설정해야 합니다");
  const qemuActionLines = workflow.match(/^ {8}uses: docker\/setup-qemu-action@.*$/gmu) ?? [];
  assert.deepEqual(
    qemuActionLines,
    [`        uses: ${QEMU_SETUP_ACTION}`],
    "workflow 전체에는 digest로 고정한 QEMU action만 정확히 하나여야 합니다",
  );
  const binfmtImageLines = workflow.match(/^ {10}image: .*tonistiigi\/binfmt.*$/gmu) ?? [];
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
  expectSingleProperty(
    surrealWorkflowStep.content,
    8,
    "id",
    "surrealdb_image",
    "workflow SurrealDB step id가 다릅니다",
  );
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
  assert.doesNotMatch(
    workflow,
    /surrealdb:3\.2\.0-massion\.1/u,
    "workflow에 이전 SurrealDB registry tag가 남아 있습니다",
  );

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
  expectSingleProperty(
    releaseBundleImages,
    10,
    "MASSION_IMAGE",
    '"massion:1.0.0",',
    "release bundle Massion 이미지가 다릅니다",
  );
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
  expectSingleDockerInstruction(
    finalStage,
    "USER",
    "surreal",
    "Dockerfile final 실행 사용자가 surreal로 고정되지 않았습니다",
  );
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
  assert.doesNotMatch(
    remoteCliE2e,
    /surrealdb-3\.2\.0/u,
    "원격 CLI UAT에 이전 SurrealDB version literal이 남아 있습니다",
  );
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

test("원격 SurrealDB의 Compose와 Kubernetes runtime 보안 profile을 고정한다", async () => {
  const [compose, kubernetes] = await Promise.all([
    readFile(new URL("../compose.yaml", import.meta.url), "utf8"),
    readFile(new URL("../deploy/kubernetes/base/surreal-statefulset.yaml", import.meta.url), "utf8"),
  ]);

  const composeSurrealdb = composeServiceBlock(compose, "surrealdb");
  expectSingleBlock(
    composeSurrealdb,
    /^ {4}secrets:\n {6}- database_owner_password$/gmu,
    "    secrets:\n      - database_owner_password",
    "Compose SurrealDB secret mount가 다릅니다",
  );
  expectSingleBlock(
    composeSurrealdb,
    /^ {4}volumes:\n {6}- surreal-data:\/data$/gmu,
    "    volumes:\n      - surreal-data:/data",
    "Compose SurrealDB named data volume이 다릅니다",
  );
  expectSingleBlock(
    composeSurrealdb,
    /^ {4}security_opt:\n {6}- no-new-privileges:true$/gmu,
    "    security_opt:\n      - no-new-privileges:true",
    "Compose SurrealDB no-new-privileges 설정이 다릅니다",
  );
  expectSingleBlock(
    composeSurrealdb,
    /^ {4}cap_drop:\n {6}- ALL$/gmu,
    "    cap_drop:\n      - ALL",
    "Compose SurrealDB capability drop 설정이 다릅니다",
  );

  expectSingleBlock(
    kubernetes,
    /^ {6}securityContext:\n {8}runAsNonRoot: true\n {8}runAsUser: 10001\n {8}runAsGroup: 10001\n {8}fsGroup: 10001\n {8}seccompProfile:\n {10}type: RuntimeDefault$/gmu,
    "      securityContext:\n        runAsNonRoot: true\n        runAsUser: 10001\n        runAsGroup: 10001\n        fsGroup: 10001\n        seccompProfile:\n          type: RuntimeDefault",
    "Kubernetes SurrealDB pod security context가 다릅니다",
  );
  const kubernetesPrepareSecret = kubernetesInitContainerBlock(kubernetes, "prepare-secret");
  expectSingleBlock(
    kubernetesPrepareSecret,
    /^ {10}securityContext:\n {12}runAsNonRoot: false\n {12}runAsUser: 0\n {12}allowPrivilegeEscalation: false\n {12}readOnlyRootFilesystem: true\n {12}capabilities:\n {14}drop: \["ALL"\]\n {14}add: \["CHOWN", "FOWNER"\]$/gmu,
    '          securityContext:\n            runAsNonRoot: false\n            runAsUser: 0\n            allowPrivilegeEscalation: false\n            readOnlyRootFilesystem: true\n            capabilities:\n              drop: ["ALL"]\n              add: ["CHOWN", "FOWNER"]',
    "Kubernetes prepare-secret init container security context가 다릅니다",
  );
  expectSingleBlock(
    kubernetesPrepareSecret,
    /^ {10}command:\n {12}- sh\n {12}- -ec\n {12}- cp \/source\/database-owner-password \/target\/database-owner-password && chown 10001:10001 \/target\/database-owner-password && chmod 0600 \/target\/database-owner-password$/gmu,
    "          command:\n            - sh\n            - -ec\n            - cp /source/database-owner-password /target/database-owner-password && chown 10001:10001 /target/database-owner-password && chmod 0600 /target/database-owner-password",
    "Kubernetes SurrealDB runtime secret 초기화가 다릅니다",
  );
  expectSingleBlock(
    kubernetesPrepareSecret,
    /^ {10}volumeMounts:\n {12}- name: raw-secrets\n {14}mountPath: \/source\n {14}readOnly: true\n {12}- name: runtime-secrets\n {14}mountPath: \/target$/gmu,
    "          volumeMounts:\n            - name: raw-secrets\n              mountPath: /source\n              readOnly: true\n            - name: runtime-secrets\n              mountPath: /target",
    "Kubernetes prepare-secret init container secret volume mount가 다릅니다",
  );

  const kubernetesSurrealdb = kubernetesContainerBlock(kubernetes, "surrealdb");
  expectSingleBlock(
    kubernetesSurrealdb,
    /^ {10}env:\n {12}- name: SURREAL_PASSWORD_FILE\n {14}value: \/run\/massion-secrets\/database-owner-password$/gmu,
    "          env:\n            - name: SURREAL_PASSWORD_FILE\n              value: /run/massion-secrets/database-owner-password",
    "Kubernetes SurrealDB password file 경로가 다릅니다",
  );
  expectSingleBlock(
    kubernetesSurrealdb,
    /^ {10}securityContext:\n {12}allowPrivilegeEscalation: false\n {12}readOnlyRootFilesystem: true\n {12}capabilities:\n {14}drop: \["ALL"\]$/gmu,
    '          securityContext:\n            allowPrivilegeEscalation: false\n            readOnlyRootFilesystem: true\n            capabilities:\n              drop: ["ALL"]',
    "Kubernetes SurrealDB container security context가 다릅니다",
  );
  expectSingleBlock(
    kubernetesSurrealdb,
    /^ {10}volumeMounts:\n {12}- name: data\n {14}mountPath: \/data\n {12}- name: runtime-secrets\n {14}mountPath: \/run\/massion-secrets\n {14}readOnly: true\n {12}- name: tmp\n {14}mountPath: \/tmp$/gmu,
    "          volumeMounts:\n            - name: data\n              mountPath: /data\n            - name: runtime-secrets\n              mountPath: /run/massion-secrets\n              readOnly: true\n            - name: tmp\n              mountPath: /tmp",
    "Kubernetes SurrealDB writable·secret mount가 다릅니다",
  );
});

test("desktop release는 고정 의존성 설치 뒤 서명 build 전에 보안·Rust gate를 순서대로 통과한다", async () => {
  const workflow = await readFile(new URL("../.github/workflows/desktop-release.yml", import.meta.url), "utf8");
  const installStep = workflowStepByName(workflow, "고정 의존성 설치");
  const securityStep = workflowStepByName(workflow, "서명 전 보안 검증");
  const rustStep = workflowStepByName(workflow, "Tauri Rust 검증");
  const buildStep = workflowStepByName(workflow, "개인용 후보 빌드");

  assert.ok(
    installStep.offset < securityStep.offset &&
      securityStep.offset < rustStep.offset &&
      rustStep.offset < buildStep.offset,
    "desktop release gate 순서가 고정 의존성 설치 → 보안 → Rust → 서명 build가 아닙니다",
  );
  expectSingleProperty(securityStep.content, 8, "run", "pnpm verify:security", "desktop 보안 gate 명령이 다릅니다");
  expectSingleProperty(
    rustStep.content,
    8,
    "run",
    "cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked",
    "desktop Rust gate 명령이 다릅니다",
  );

  const outsideBuild = `${workflow.slice(0, buildStep.offset)}${workflow.slice(buildStep.offset + buildStep.content.length)}`;
  const anonymousSecretStep = '      - run: echo "${{ secrets.APPLE_ID }}"';
  const leakedWorkflow = workflow.replace(
    "\n      - name: 개인용 후보 검증",
    `\n${anonymousSecretStep}\n\n      - name: 개인용 후보 검증`,
  );
  const leakedBuildStep = workflowStepByName(leakedWorkflow, "개인용 후보 빌드");
  const outsideLeakedBuild = `${leakedWorkflow.slice(0, leakedBuildStep.offset)}${leakedWorkflow.slice(leakedBuildStep.offset + leakedBuildStep.content.length)}`;
  assert.equal(
    leakedBuildStep.content.includes(anonymousSecretStep),
    false,
    "익명 workflow 단계를 build 단계로 오인하면 안 됩니다",
  );
  assert.equal(
    outsideLeakedBuild.includes(anonymousSecretStep),
    true,
    "build 직후 익명 단계의 secret 참조를 놓치면 안 됩니다",
  );
  for (const secret of [
    "APPLE_CERTIFICATE",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_SIGNING_IDENTITY",
    "APPLE_ID",
    "APPLE_PASSWORD",
    "APPLE_TEAM_ID",
  ]) {
    expectSingleProperty(
      buildStep.content,
      10,
      secret,
      `\${{ secrets.${secret} }}`,
      `${secret} signing secret이 build 단계에 정확히 하나 있어야 합니다`,
    );
    assert.doesNotMatch(
      outsideBuild,
      new RegExp(`secrets\\.${secret}\\b`, "u"),
      `${secret}는 build 밖에서 사용하면 안 됩니다`,
    );
  }
});
