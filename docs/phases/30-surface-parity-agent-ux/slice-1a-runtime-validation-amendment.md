# Phase 30 Slice 1A 런타임 검증 보강 기록

> **문서 성격:** Phase 구현자를 위한 검증 방법(how-to)과 설계 결정 기록(decision record)입니다. 대상 독자는 Slice 1A를 재현하거나 이후 배포 회귀를 조사하는 개발자입니다.

## 목적과 적용 범위

이 보강은 원격 SurrealDB 3.2.1 코드 커밋 `462cb7b06390a0875d951fd9d9f535e90de086fc` 뒤의 독립 런타임 검토에서 추가되었습니다. 기존 구현 계획은 binary version, 두 Linux architecture, Compose·Kubernetes 정적 해석을 검증했지만, 실제 Compose 서비스의 named volume·secret·capability 경계와 Kubernetes의 read-only root filesystem 경계를 같은 방식으로 실행하지는 않았습니다.

이 문서는 다음만 보강합니다.

- Compose SurrealDB 서비스의 실제 시작·healthcheck·named `/data` volume·`cap_drop: ALL`·`no-new-privileges:true`
- Kubernetes SurrealDB container의 non-root 사용자, read-only root filesystem, `/data`·`/tmp` writable mount, capability 제한
- deploy archive 내부 `SHA256SUMS`의 byte 무결성과 release bundle의 `start` 계약
- 위 보안 profile이 정적 source에서 사라지지 않도록 하는 회귀 테스트(regression test)

개인용 local runtime version, `packages/application/src/artifacts.ts`, `packages/extension-host/src/compliance.ts`, 실제 Kubernetes cluster apply, GitHub Container Registry publish, 새 공개 release는 이 보강의 범위 밖입니다.

## 확인된 배포 profile

소스 `compose.yaml`의 SurrealDB 서비스는 root filesystem을 read-only로 설정하지 않습니다. 대신 image의 `surreal` 사용자, Docker named volume `/data`, `cap_drop: ALL`, `no-new-privileges:true`를 사용합니다. Kubernetes StatefulSet은 pod 사용자·그룹·filesystem group을 `10001`로 지정하고, application container에 `readOnlyRootFilesystem: true`, capability drop, `/data` PVC, `/tmp` emptyDir, read-only runtime secret mount를 적용합니다.

따라서 하나의 generic Docker run으로 두 환경을 대표하면 안 됩니다. Compose와 Kubernetes를 각각 재현해야 합니다.

Docker의 공식 문서는 `--read-only`가 지정 volume 이외의 root filesystem 쓰기를 막고, `--tmpfs`가 `uid`, `gid`, `mode`, `size` 옵션을 지원한다고 설명합니다. 빈 named volume을 image의 기존 directory에 mount하면 그 directory 내용이 기본 복사되는 것도 공식 동작입니다. 이 보강은 그 동작에 의존하므로 validation 전 최신 공식 문서를 다시 확인합니다.

- [Docker container run](https://docs.docker.com/reference/cli/docker/container/run/)
- [Docker tmpfs mounts](https://docs.docker.com/engine/storage/tmpfs/)
- [Docker volumes](https://docs.docker.com/engine/storage/volumes/)

## 작업 2A: 정적 deployment security 계약을 추가

**파일:**

- 수정: `scripts/release-workflow.test.mjs`
- 테스트: `node --test scripts/release-workflow.test.mjs`

기존 3.2.1 배포 계약 test에 다음을 추가합니다. 이 항목은 새 deployment 설정을 도입하지 않고, 이미 source에 있는 실제 runtime profile이 사라지는 회귀를 막습니다.

1. Compose `surrealdb` service 안에 정확히 하나의 `surreal-data:/data` volume, `no-new-privileges:true`, `cap_drop: ALL`이 있는지 확인합니다.
2. Kubernetes pod security context가 `runAsNonRoot: true`, `runAsUser: 10001`, `runAsGroup: 10001`, `fsGroup: 10001`, `RuntimeDefault` seccomp로 정확히 하나인지 확인합니다.
3. Kubernetes `surrealdb` container security context가 `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, `drop: ["ALL"]`인지 확인합니다.
4. 같은 container가 `/data`, read-only `/run/massion-secrets`, `/tmp` mount와 `/run/massion-secrets/database-owner-password` 환경 변수를 정확히 유지하는지 확인합니다.
5. init container가 database owner password를 runtime memory volume으로 copy한 뒤 `10001:10001`, mode `0600`으로 만드는 명령을 유지하는지 확인합니다.

단순 token 존재 검사 대신 service/container block 안에서 동일 property 또는 block이 정확히 하나이고 예상값과 같음을 단언합니다. test를 추가한 뒤에는 source를 바꾸지 않는 메모리 mutation으로 아래 각 변경이 실패하는지 먼저 확인합니다.

- Compose의 `cap_drop` 또는 named `/data` volume 삭제
- Kubernetes application container의 read-only root filesystem 또는 capability drop 삭제
- Kubernetes pod의 uid/fsGroup 변경
- runtime secret mount 또는 init copy·permission 변경

현재 source가 이미 이 profile을 만족하므로 이 단계의 제품 test는 characterization GREEN입니다. mutation 차단 결과를 RED→GREEN 근거로 오해하지 않고, 증거 문서에는 “기존 hardening의 회귀 계약 추가”로 기록합니다.

코드와 test 허용 목록이 `scripts/release-workflow.test.mjs` 하나일 때만 다음 커밋을 만듭니다.

```bash
set -euo pipefail
node --test scripts/release-workflow.test.mjs
pnpm exec prettier --check scripts/release-workflow.test.mjs
git diff --check
git diff --cached --quiet
expected_paths='scripts/release-workflow.test.mjs'
actual_paths="$(git status --porcelain --untracked-files=all | sed -E 's/^.. //' | LC_ALL=C sort)"
test "$actual_paths" = "$expected_paths"
git add -- scripts/release-workflow.test.mjs
test "$(git diff --cached --name-only)" = "$expected_paths"
git diff --cached --check
git commit -m "test(release): cover remote database runtime hardening"
```

## 작업 3A: clean clone에서 Compose와 Kubernetes profile을 각각 실행

작업 3의 clean clone, Docker context, Buildx builder, random run ID, temporary directory, image ownership label, cleanup 규칙을 그대로 사용합니다. source 또는 archive directory 안에는 secret·cache·image artifact를 만들지 않습니다.

### Compose source runtime smoke

각 Compose secret path에 임시 random value를 만들고 mode `0600`으로 제한합니다. 실제 값, 사용자 secret, profile 경로를 재사용하거나 출력하지 않습니다. clean clone에서 Docker가 실행 가능한 loaded SurrealDB image tag를 `MASSION_SURREALDB_IMAGE`로 지정하고, `env -i`로 다음 command만 실행합니다.

```bash
compose_runtime() {
  env -i \
    PATH="$PATH" \
    HOME="$HOME" \
    DOCKER_CONFIG="$docker_config" \
    TMPDIR="$TMPDIR" \
    MASSION_SURREALDB_IMAGE="$runtime_image_tag" \
    MASSION_DATABASE_OWNER_PASSWORD_FILE="$compose_secrets/database-owner-password" \
    MASSION_DATABASE_PASSWORD_FILE="$compose_secrets/database-password" \
    MASSION_TOKEN_KEY_FILE="$compose_secrets/token-key" \
    MASSION_CREDENTIAL_KEY_FILE="$compose_secrets/credential-key" \
    MASSION_REGISTRY_KEY_FILE="$compose_secrets/registry-key" \
    MASSION_TLS_CERTIFICATE_FILE="$compose_secrets/tls.crt" \
    MASSION_TLS_PRIVATE_KEY_FILE="$compose_secrets/tls.key" \
    docker --context "$docker_context" compose --env-file /dev/null \
      --project-name "$compose_project" \
      --file "$clean_root/compose.yaml" \
      --project-directory "$clean_root" "$@"
}

compose_runtime up --detach --no-build --wait --wait-timeout 120 surrealdb
compose_container="$(compose_runtime ps --quiet surrealdb)"
test -n "$compose_container"
test "$(docker_local inspect --format '{{json .HostConfig.CapDrop}}' "$compose_container")" = '["ALL"]'
printf '%s' "$(docker_local inspect --format '{{json .HostConfig.SecurityOpt}}' "$compose_container")" | grep -Fq 'no-new-privileges:true'
test "$(docker_local inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Type}}{{end}}{{end}}' "$compose_container")" = 'volume'
test "$(docker_local exec "$compose_container" id -u)" = '10001'
docker_local exec "$compose_container" sh -ec 'test -e /data/massion.db && test -w /data'
compose_runtime down --volumes --remove-orphans
```

`compose_project`는 run ID를 포함한 새 이름이어야 합니다. cleanup trap도 같은 project에 `down --volumes --remove-orphans`를 다시 시도합니다. 이 smoke는 source Compose의 writable root filesystem을 의도적으로 유지합니다. full Massion/Caddy stack, 외부 HTTPS port, 실제 provider credential은 시작하지 않습니다.

### Kubernetes container parity smoke

각 loaded `linux/arm64`, `linux/amd64` image에 아래 profile을 적용합니다. Kubernetes cluster를 apply하지 않아도 StatefulSet application container의 filesystem·user·capability 조건을 Docker runtime에서 재현합니다.

```bash
docker_local run --detach --rm --name "$kubernetes_container" --platform "$platform" \
  --user 10001:10001 \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --tmpfs /data:rw,noexec,nosuid,nodev,size=128m,mode=0700,uid=10001,gid=10001 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777 \
  --env SURREAL_PASSWORD_FILE=/run/massion-secrets/database-owner-password \
  --mount "type=bind,src=$surreal_smoke_secret,dst=/run/massion-secrets/database-owner-password,readonly" \
  "$image_id" >/dev/null
```

readiness 뒤에는 uid `10001`, `/data/massion.db` 존재, `/data` 쓰기 가능, root filesystem 쓰기 실패를 확인합니다. container와 임시 image tag는 기존 run ID·image ID·label ownership 확인 뒤에만 제거합니다. global prune, 다른 container·volume·image 삭제는 금지합니다.

### deploy archive integrity와 의미 검증

deploy archive를 추출한 직후 source path가 아니라 archive root에서 내부 checksum을 확인합니다. Linux와 macOS 모두를 지원하기 위해 `sha256sum`을 우선하고 `shasum -a 256`으로 fallback합니다.

```bash
verify_sha256sums() {
  checksum_root="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$checksum_root" && sha256sum -c SHA256SUMS)
  elif command -v shasum >/dev/null 2>&1; then
    (cd "$checksum_root" && shasum -a 256 -c SHA256SUMS)
  else
    printf '%s\n' 'SHA-256 checksum 검증 도구가 필요합니다' >&2
    exit 1
  fi
}

tar -xzf artifacts/release-1.0.0/massion-deploy-1.0.0.tar.gz -C "$deploy_extract"
verify_sha256sums "$deploy_extract"
```

기존 archive JSON assertion에는 다음 `start` value의 exact equality도 추가합니다.

```js
assert.equal(bundle.start, "docker compose --file compose.yaml up -d --no-build --wait --wait-timeout 120");
```

archive는 공개 registry image를 실제 pull해 full stack을 시작했다는 증거가 아닙니다. 이 단계가 증명하는 것은 archive의 checksum, source에서 복사된 Compose·Kubernetes·Dockerfile·release bundle 계약의 정합성입니다.

## 증거와 완료 경계

최종 Slice 1A 증거 문서에는 다음을 별도로 기록합니다.

- source Compose runtime smoke의 종료 코드, healthcheck, named volume type, capability·no-new-privileges, uid, RocksDB file 확인
- 두 platform Kubernetes parity smoke의 종료 코드, read-only root filesystem, tmpfs ownership, uid, readiness, RocksDB file 확인
- archive `SHA256SUMS` 검증과 release `start` contract 결과
- static hardening contract은 기존 설정을 잠근 characterization test이며, deployment security 설정을 새로 바꾼 작업이 아니라는 사실

실제 GitHub registry publish, authenticated remote UAT, real Kubernetes cluster deployment는 계속 별도 증거와 사용자 권한이 필요한 항목입니다. 이 문서는 그 항목을 통과한 것처럼 기록하지 않습니다.
