# Phase 28 — pnpm 11 도구 체인 검증 증거

> **검증일**: 2026-07-15
> **구현 source commit**: `32bc0993a1ad88c790e4855be733852de8a12f25`
> **Git tree**: `beb8130e9741448235379c669ee989d5e5973ce5`
> **Git archive SHA-256**: `sha256:0a15b20c8cf67c179bba42eb0eeaac22f6b2afa1351aef4b6ccae2d9c550afd4`
> **release source digest**: `sha256:856073baeeaa84810924041d6da5d5d07c0361a2cc56cff205db7990f12c295a`

이 문서는 원시 터미널 출력, 개인 경로, 자격 증명과 token을 저장하지 않고 종료 코드·요약·로그 digest만 기록합니다.

## 도구 체인 계약

| 진입점 | 확인 결과 |
|---|---|
| root `package.json` `packageManager` | `pnpm@11.13.0` |
| `pnpm-workspace.yaml` | `overrides`와 `allowBuilds: { protobufjs: false }` 사용 |
| CI·release workflow | pnpm 11.13.0으로 통일 |
| Dockerfile 두 경로 | pnpm 11.13.0으로 통일 |
| README 개발 안내 | pnpm 11.13.0으로 통일 |
| 계약 테스트 | `scripts/toolchain-contract.test.mjs`, 통과 |

## source commit 검증

| 단계 | 결과 |
|---|---|
| `pnpm install --frozen-lockfile` | 종료 코드 0 |
| `pnpm verify` | 종료 코드 0; format, build, lint, typecheck, workspace test, 문서 검증 통과 |
| `pnpm verify:security` | 종료 코드 0; moderate/high/critical 0, low 1 |
| 보안 회귀 테스트 | 감사 error envelope가 성공으로 처리되지 않음, 통과 |
| `pnpm verify:hardening` | 종료 코드 0; 500 requests, concurrency 32, failures 0, p95 14.72ms, clean shutdown |
| `pnpm release:build` | 종료 코드 0 |
| `pnpm verify:release` | 종료 코드 0; `status: passed`, `connector: ready`, `backup: restored`, `uninstall: data-preserved` |

release manifest의 toolchain은 Node `24.8.0`, Bun `1.3.14`, pnpm `11.13.0`입니다. source release artifact는 다음 digest로 고정되었습니다.

| artifact | bytes | SHA-256 |
|---|---:|---|
| `massion-deploy-1.0.0.tar.gz` | 18091 | `sha256:504541d7a77f7ef432db43f4303cc038712ed10bffcd0e00b9c7ddbdc1e57203` |
| `massion-local-1.0.0.tar.gz` | 381326392 | `sha256:25fed3117367da57a97c2ac57930da36ceaa7e9f7c431928cba21b49131aec26` |

## Docker 검증

| 경로 | 결과 |
|---|---|
| root `build` stage cache-only | 종료 코드 0 |
| Caddy `web` stage cache-only | 종료 코드 0; web bundle 17 chunks, 각 250KiB 이하 |
| Caddy 최종 image build | 종료 코드 0; image digest `sha256:76c827d111630e9eb80bb759090828b9ad443af01eeecbc6415ea487302f38df`, 23414010 bytes |
| root production stage OCI export | 종료 코드 0; OCI archive `524460544` bytes, digest `sha256:72ec3049792374675a3df13bdc66fcddef44d26710339581734636875d1a7bbc` |
| root daemon-tag 최종 image unpack | Docker storage `no space left on device`로 실패; 코드 오류로 기록하지 않음 |

최종 image tag와 OCI 임시 archive는 digest 기록 후 삭제했습니다. 공유 Docker cache, 기존 image와 다른 프로젝트 컨테이너는 전역 prune하지 않았습니다.

## clean clone 검증

원본 저장소를 빈 임시 디렉터리에 `git clone --no-local --branch main`으로 복제하고 같은 source commit을 확인했습니다. pnpm store는 프로젝트 외부의 격리 경로(`/private/tmp` 아래)로 지정해 원본 저장소와 섞이지 않게 했습니다.

| 단계 | 결과 |
|---|---|
| clone 및 commit assert | 종료 코드 0 |
| `pnpm install --frozen-lockfile` | 종료 코드 0 |
| `pnpm verify` | 종료 코드 0 |
| `pnpm verify:security` | 종료 코드 0; moderate/high/critical 0, low 1 |
| `pnpm release:build` | 종료 코드 0 |
| `pnpm verify:release` | 종료 코드 0; `status: passed`, `connector: ready`, `backup: restored`, `uninstall: data-preserved` |

clean clone release manifest도 같은 source digest와 pnpm 11.13.0을 가리키며, clean clone artifact digest는 deploy `sha256:6798bba8d3a0df8741dd1b85e3ad816c4c2f977287fbe1ba7b766d2394e75b34`, local `sha256:ff0b4fbee1220d85429f95d9b8329ee08fa4a7522602f2edc8f53f322c90b3f5`입니다.

## 로그 digest

로그 원문은 임시 검증 경로에만 보관했고 저장소에는 digest만 남깁니다.

| 로그 | SHA-256 |
|---|---|
| source verify | `sha256:64d43165cb1172f2f76845ab6eaa313ad8584f2b737599aa8a40b3738d1b953e` |
| source release·hardening | `sha256:600efd9f63db0a04c5de9d7f7a7be875bcf2ef81734ffa5fa3b7fc1408628df7` |
| Docker stages | `sha256:164e4e860064a033560fa2470e6b85e45486f76a93bd4e844474a7cba4be4381` |
| Docker Caddy final | `sha256:9597136ed17f4593ff82e2e35375373321a963211a56f1391d28ed011831af18` |
| Docker daemon retry | `sha256:743ccd57b95f83cf95973e14a674a2ffe57ea84d9847a1c8488be74eedf085cc` |
| Docker production OCI | `sha256:7d2f78fa3409ef297e83390ade053c8296c1a9057f4974520a0e089d15a5b78b` |
| clean clone | `sha256:298b411bf919168b0a8b4c4884392556c2bbf0985ab9dec4714e5090e09b5b06` |

## 범위 밖

이 증거는 Phase 24의 실제 사용자 계정 UAT를 대신하지 않습니다. Codex OAuth 실행, 기존 profile 재사용, Claude 소비자 로그인, Z.AI Coding Plan, 복수 계정 quota·rotation·429·fallback은 사용자 계정과 네트워크가 준비된 별도 UAT에서만 완료로 승격합니다.
