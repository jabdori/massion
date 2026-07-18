# Phase 30 — SurrealDB 배포·로컬 런타임 경계 조사

> **조사 범위:** Slice 1의 SurrealDB 3.2.1 후보를 실제 배포 경로와 개인용 로컬 경로에 맞게 분리
> **기준 소스 커밋(source commit):** `65922bd706580a0962b6eda81c6fa3d63b36b6a8`
> **안전 커밋(safety commit):** `9b049f72a96457c46139811f86d36589f073df64`
> **조사 일시:** 2026-07-18

## 확인한 사실

- 개인용 로컬 daemon은 `apps/cli/src/local.ts`에서 `rocksdb://./massion.db`를 데이터베이스 URL로 사용합니다.
- 현재 `@massion/storage`는 `@surrealdb/node` 3.0.3을 고정하고, 설치된 패키지 메타데이터는 내장 SurrealDB 엔진을 3.0.2로 선언합니다.
- 새 임시 RocksDB 데이터베이스에 `createDatabase()`를 연결해 `database.version()`을 실행한 결과는 `surrealdb-3.0.2`였습니다.
- 반면 배포용 Docker 이미지 `surrealdb/surrealdb:v3.2.1`의 현재 OCI index digest는 `sha256:a0ef3252ec197a31a262423241061390f51ba95509a68f1866f0783ad8f39ea1`입니다.
- SurrealDB의 공식 3.2 릴리스 노트는 3.2.1을 최신 안정 버전으로 표시하고, 3.2.0에서 catalog·on-disk layout 변경 없이 제자리 업그레이드를 권고합니다. [SurrealDB 3.2 릴리스 노트](https://surrealdb.com/releases/3.2)

## 재현 명령

다음 명령은 storage package를 빌드한 뒤 별도 임시 RocksDB 데이터베이스를 만들고 실제 엔진 버전만 출력했습니다.

```bash
set -euo pipefail
repository_root="$(git rev-parse --show-toplevel)"
cd "$repository_root"
temporary_directory="$(mktemp -d)"
trap 'rm -rf "$temporary_directory"' EXIT
pnpm --filter @massion/storage build
node --input-type=module -e '
  import { createDatabase } from "./packages/storage/dist/index.js";
  const database = await createDatabase({
    url: `rocksdb://${process.argv[1]}/massion.db`,
    namespace: "massion",
    database: "version_probe",
  });
  try {
    console.log(await database.version());
  } finally {
    await database.close();
  }
' "$temporary_directory"
```

관측 결과는 `surrealdb-3.0.2`였습니다. 이 결과는 개인용 로컬 엔진의 실제 값을 나타내며, Docker·Compose·Kubernetes의 원격 SurrealDB 이미지 버전과 같은 값으로 취급하면 안 됩니다.

## 안전 스냅샷 후보와 실제 경계

안전 커밋의 Slice 1 후보는 다음 여덟 파일을 3.2.1로 바꿉니다.

- 원격 배포·릴리스 경로 여섯 파일: `.github/workflows/release.yml`, `compose.yaml`, `deploy/kubernetes/base/surreal-statefulset.yaml`, `deploy/surreal/Dockerfile`, `scripts/build-release.mjs`, `scripts/release-workflow.test.mjs`
- 확장 런타임 기본값 두 파일: `packages/application/src/artifacts.ts`, `packages/extension-host/src/compliance.ts`

첫 여섯 파일은 원격 배포 이미지 계약이므로 Slice 1A에서 독립적으로 복원할 수 있습니다. `CHANGELOG.md`의 원격 SurrealDB 표기는 안전 스냅샷에는 없으므로, Slice 1A에 포함하더라도 사후 보정(post-snapshot correction)으로 기록해야 합니다.

나머지 두 파일의 3.2.1 하드코딩은 그대로 복원하면 안 됩니다. 현재 기본값 3.2.0도 실제 개인용 로컬 엔진 3.0.2와 일치하지 않으며, 3.2.1로 바꾸면 불일치가 더 커집니다. TypeScript 소스의 정적 생성 지점 검색에서는 `ApplicationArtifactGateway`와 `ExtensionComplianceAuditor`가 production 조립 경로가 아니라 테스트에서만 직접 생성되는 것도 확인했습니다. 따라서 literal 변경만으로는 실제 제품 경로를 고치지 못합니다.

## 결정과 다음 경계

### Slice 1A — 원격 배포 SurrealDB 3.2.1

다음 커밋에서는 실제 배포 이미지 계약만 TDD로 복원합니다.

- release workflow의 `${{ steps.identity.outputs.base }}/surrealdb:3.2.1-massion.1` 게시 tag
- Compose, Kubernetes, release bundle의 `massion-surrealdb:3.2.1`
- Dockerfile의 `surrealdb/surrealdb:v3.2.1` OCI index digest 고정
- 현재 원격 배포 버전을 설명하는 `CHANGELOG.md` 보정
- 위 값을 모두 검사하는 release workflow 계약 테스트

이 단계는 개인용 로컬 RocksDB 엔진이나 확장 호환성 값을 바꾸지 않습니다.

### Slice 1B — 실제 데이터베이스 버전 전달

확장 호환성 검사는 하드코딩된 SurrealDB 버전이 아니라, 해당 실행 경로의 `database.version()`에서 얻은 실제 버전을 사용해야 합니다. 이 단계의 설계와 TDD는 다음 조건을 모두 만족한 뒤에만 시작합니다.

- Application·extension-host 조립 경로에 실제 runtime version을 한 번만 전달합니다.
- 값이 없다는 이유로 `surrealDB` 호환성 검사를 건너뛰지 않습니다.
- 3.0.2와 3.2.1 환경 모두에서 호환성 성공·실패를 검증합니다.
- 현재 공식 Extension manifest의 `>=3.2.0` 범위를 근거 없이 낮추지 않습니다.
- 개인용 로컬 엔진을 3.2.1로 교체해야 한다면 installer, daemon lifecycle, backup·restore, migration, UAT를 포함한 별도 설계로 다룹니다.

따라서 안전 스냅샷의 두 runtime literal은 직접 복원이 아니라 실제 runtime version 전달 설계로 대체하거나, 그 설계가 승인될 때까지 보류합니다.

## 증명하지 않는 범위

- 개인용 로컬 RocksDB를 SurrealDB 3.2.1 엔진으로 이전할 수 있다는 결론
- 현재 공식 Extension이 로컬 3.0.2 엔진에서 기능적으로 지원된다는 결론
- Extension lifecycle·package service·compliance auditor의 production 조립 경로가 이미 완성됐다는 결론
- Slice 1A 또는 Slice 1B의 구현 완료
