# 철회된 v1.0.0 GitHub Release 증거 — 2026-07-24

## 결론

현재 정정: 2026-07-15 게시됐던 `Massion AgentOS 1.0.0` GitHub Release는 2026-07-24 삭제됐고, 잘못된 원격 `v1.0.0` 태그도 삭제됐습니다. 아래 삭제 전 명령과 관측은 당시 상태를 보존한 역사 기록입니다.

철회 이유는 다음 두 가지입니다.

1. 태그에서 실행된 두 GitHub Actions 릴리스 workflow가 모두 실패했습니다.
2. 현재 메인 제품 표면인 개인용 데스크톱이 실제 Tauri UAT, 서명·공증, 깨끗한 설치·업데이트·제거, 데이터 지속성, 비정상 종료, 접근성 게이트를 통과하지 않았습니다.

따라서 과거 게시물을 개인용 1.0 완료로 유지하는 것은 실제 구현 상태와 맞지 않았습니다.

## 삭제 전 관측값

| 항목 | 관측값 |
|---|---|
| 릴리스 이름 | `Massion AgentOS 1.0.0` |
| 태그 | `v1.0.0` |
| 게시 시각 | `2026-07-15T18:05:57Z` |
| draft / prerelease | `false` / `false` |
| 대상 커밋 | `ecd35b1b34e4e8797da6e458c4d69e857bd90656` |
| `massion-deploy-1.0.0.tar.gz` | `sha256:82da…`, 다운로드 0 |
| `massion-local-1.0.0.tar.gz` | `sha256:a2a5…`, 다운로드 0 |
| `release-manifest.json` | `sha256:2f53…`, 다운로드 3 |

원문 digest는 삭제 전에 GitHub API로 확인했지만 이 문서는 현재 다운로드할 수 없는 철회 artifact를 복구 출처로 제시하지 않기 위해 앞부분만 식별값으로 남깁니다.

## 실패 workflow

- [GitHub Actions 실행 29439133101](https://github.com/jabdori/massion/actions/runs/29439133101): `completed` / `failure`. `전체 품질 검증` 실패 뒤 build·publish·attestation 단계가 실행되지 않았습니다.
- [GitHub Actions 실행 29253011084](https://github.com/jabdori/massion/actions/runs/29253011084): `completed` / `failure`.

workflow 실패와 별개로 수동 업로드된 자산이 존재했지만, 실패한 자동화와 미완료 개인용 게이트를 합쳐 정식 1.0의 근거로 볼 수 없습니다.

## 수행·검증

GitHub CLI 인증 계정과 저장소를 확인한 뒤 다음 범위만 삭제했습니다.

```sh
gh release delete v1.0.0 --cleanup-tag --yes
```

삭제 뒤 다음 상태를 다시 확인했습니다.

- `gh release view v1.0.0`: release not found
- `gh release list`: 공개 릴리스 없음
- `git ls-remote --tags origin`: 원격 태그 없음
- 로컬 태그: 없음

> 위 태그 부재는 2026-07-24 당시 관측이며 현시점에도 원격 `v1.0.0` 태그는 존재하지 않습니다.

대상 커밋은 `main`과 후속 브랜치 이력에 남아 있어 코드 계보는 보존됩니다.

## 재게시 조건

다음 `v1.0.0`은 [개인용 데스크톱 릴리스 기준](../../../apps/desktop/src-tauri/RELEASE.md)과 [Phase 30 v1 전달 기록](../../phases/30-surface-parity-agent-ux/v1-delivery/README.md)의 모든 게이트가 같은 후보 SHA에서 통과한 뒤 새 태그와 새 artifact로만 만들 수 있습니다.
