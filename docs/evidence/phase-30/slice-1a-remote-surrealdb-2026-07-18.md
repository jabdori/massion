# Phase 30 — Slice 1A 원격 SurrealDB 3.2.1 검증 증거

> **검증 범위:** 원격 배포 SurrealDB 3.2.1 계약(Slice 1A)과 깨끗한 복제본(clean clone) 릴리스 복구
> **최종 검증 소스 커밋(source commit):** `0dff1f3a3ead8e005fe45058196b845e70344934`
> **안전 커밋(safety commit):** `9b049f72a96457c46139811f86d36589f073df64`

## 실행 기록

> **검증 시작:** 2026-07-18T15:18:52Z
> **검증 종료:** 2026-07-18T15:45:39Z (26분 47초)

최종 소스 커밋을 새 임시 디렉터리에 복제해 검증했습니다. 검증 스크립트는 source와 release archive를 각각 해석하고, 모든 임시 이미지·Compose 자원·임시 디렉터리를 소유 표식으로 정리했습니다. 검증한 clean clone의 Git 상태는 깨끗했습니다(clean).

| 항목 | 확인값 |
| --- | --- |
| Node.js | v24.8.0 |
| pnpm | 11.13.0 |
| Bun | 1.3.14 |
| Docker client/server | 29.4.0 / 29.4.0 |
| kubectl | v1.33.9 |
| 현재 Docker context endpoint | local Unix socket 확인 |
| Buildx driver | `docker` |
| Buildx target platform | `linux/amd64`, `linux/arm64` 확인 |

| 명령 또는 단계 | 종료 코드 | 확인 범위 |
| --- | ---: | --- |
| 깨끗한 복제본의 정적 배포 해석 | 0 | source와 release archive의 Compose image, Kubernetes Kustomize image, archive Dockerfile 계약 |
| `linux/arm64` 원격 SurrealDB image build·runtime smoke | 0 | `surreal version`: `3.2.1 for linux on aarch64`, entrypoint readiness, Compose runtime, 읽기 전용 root filesystem |
| `linux/amd64` 원격 SurrealDB image build·runtime smoke | 0 | `surreal version`: `3.2.1 for linux on x86_64`, entrypoint readiness, Kubernetes runtime parity, 읽기 전용 root filesystem |
| `pnpm install --frozen-lockfile` | 0 | 깨끗한 복제본의 고정 lockfile 설치 |
| `pnpm verify` | 0 | format, 전체 build, lint, typecheck, root·workspace test, 문서 검증 |
| `pnpm verify:security` | 0 | 보안 게이트 |
| `pnpm verify:hardening` | 0 | 서버 강건성 test와 부하 검사(500 requests, concurrency 32, failures 0) |
| `pnpm release:build` | 0 | release manifest, local archive, deploy archive 생성 |
| `env -u SURREAL_TEST_URL CI=true pnpm verify:release artifacts/release-1.0.0` | 0 | 설치·복구·제거 시나리오와 deploy archive 무결성 |

릴리스 복구 검증의 최종 상태는 `passed`였고, connector는 `ready`, backup은 `restored`, 제거 뒤 사용자 data는 `preserved`였습니다. 이 호출만 `CI=true`로 실행해 pnpm 11이 production-only 의존성 상태를 복구할 때의 TTY 확인을 비대화형으로 처리했습니다. 의존성 상태 검사(`verify-deps-before-run`)를 끄거나 사용자 전역 pnpm 설정을 바꾸지 않았습니다.

## 검증한 배포 계약

- `surrealdb/surrealdb:v3.2.1`은 OCI digest `sha256:a0ef3252ec197a31a262423241061390f51ba95509a68f1866f0783ad8f39ea1`로 Dockerfile에 고정됐습니다.
- source와 deploy archive의 resolved Compose image는 각각 한 번의 `massion-surrealdb:3.2.1` 참조를 가졌고, source와 archive의 Kubernetes Kustomize 출력도 각각 한 번의 같은 image 참조를 가졌습니다.
- archive의 SurrealDB Dockerfile은 같은 OCI digest, non-root `surreal` 사용자, Massion entrypoint를 포함하는지 검증했습니다.
- 두 architecture image에서 실제 `docker run --entrypoint /usr/local/bin/surreal … version` 출력을 재캡처했습니다. `linux/arm64`는 `3.2.1 for linux on aarch64`, `linux/amd64`는 `3.2.1 for linux on x86_64`였습니다. entrypoint readiness와 `/data/massion.db` RocksDB 상태를 확인했고, root filesystem 쓰기 시도는 두 smoke에서 모두 거부됐습니다.
- release workflow 계약 test는 QEMU·고정 binfmt digest와 `linux/amd64`, `linux/arm64` 다중 architecture 게시 설정을 확인했습니다. 이 로컬 검증은 registry push를 실행하지 않았습니다.
- `CHANGELOG.md`의 원격 배포 버전 표기와 release bundle의 배포 참조도 같은 3.2.1 계약으로 검증했습니다.

Slice 1A 코드·테스트 근거는 다음과 같습니다.

| 커밋 | 역할 |
| --- | --- |
| `462cb7b06390a0875d951fd9d9f535e90de086fc` | 원격 SurrealDB 3.2.1 image와 배포·release contract 고정 |
| `74d1c95b0351bb4c0ae6559890bb932605158422` | 원격 runtime hardening 계약 test 추가 |
| `d7b58c14a57dcc8a34059b09e52ea683ce8f7f1f` | release init container 계약 보강 |
| `775e902f1e52fea3d73ececc8c695e75855eed62` | release deployment contract lint 정리 |
| `0bd3a2f0d96d313bb37c13da5c06b1206ecefbfc` | 깨끗한 복제본에서 재현 가능한 reconciliation test 보강 |
| `0dff1f3a3ead8e005fe45058196b845e70344934` | 릴리스 복구 검증의 pnpm 비대화형 회귀 test와 한정된 CI 호출 고정 |

## GitHub 공개 상태 재관측

2026-07-18T15:47:16Z에 읽기 전용 GitHub 조회를 수행했습니다.

- 공개 `v1.0.0` tag는 `ecd35b1b34e4e8797da6e458c4d69e857bd90656`을 가리켰습니다.
- [Massion AgentOS 1.0.0 공개 릴리스](https://github.com/jabdori/massion/releases/tag/v1.0.0)는 2026-07-15T18:05:57Z에 게시됐고 draft·prerelease 모두 `false`였습니다.
- [Massion 1.0 Release 실행 29439133101](https://github.com/jabdori/massion/actions/runs/29439133101)은 같은 커밋에서 `completed`/`failure`였습니다. `전체 품질 검증` 단계가 실패했고, 그 뒤 보안·강건성, 설치·배포 묶음, Docker Buildx, registry 로그인, 세 image build·publish, image·bundle 증명과 bundle 보관은 모두 skipped였습니다.

따라서 이 Slice 1A의 로컬 검증을 공개 registry 게시, attestation, 새 release 성공으로 해석하지 않습니다. 기존 `v1.0.0` tag를 이동하거나 재생성하지 않았고, 새 version·tag도 결정하지 않았습니다.

## 증명하지 않는 범위

- 인증된 원격 SurrealDB 사용자 인수 테스트(UAT): opt-in CLI 시나리오의 기대 version literal만 호환되게 보정했으며 실제 외부 database 연결은 실행하지 않았습니다.
- 실제 Kubernetes cluster apply, rollout 또는 restore job 실행
- GitHub Container Registry push, SBOM·provenance·attestation의 외부 관측, 새 공개 Release
- 개인용 로컬 RocksDB runtime version 전달(Slice 1B)과 extension 호환성 경로
- Buildx action이 내려받는 runtime Buildx, Docker-container BuildKit image, Dockerfile frontend image의 supply-chain 고정
