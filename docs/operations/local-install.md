# 개인용 데스크톱 설치·운영 안내

> **현재 상태:** 설치 가능한 공개 artifact가 없습니다. 이 문서는 개인용 macOS arm64 1.0 후보의 운영 계약이며, GitHub Release가 새로 게시되기 전에는 `curl | bash`나 과거 `v1.0.0` 링크를 사용하면 안 됩니다.

## 1. 첫 릴리스 설치 경로

첫 메인 릴리스는 Developer ID로 서명하고 Apple 공증을 마친 `Massion.app` 또는 DMG입니다. 공개 시 GitHub Release에서 내려받고, macOS의 응용 프로그램 폴더에 설치합니다. 최종 artifact 이름과 지원 macOS 범위는 실제 서명 후보를 검증한 뒤 이 문서에 기록합니다.

다음 조건이 모두 충족되기 전에는 다운로드 명령을 추가하지 않습니다.

- 같은 후보 SHA의 전체 검증과 실제 Tauri UAT 통과
- 앱과 Node.js·SurrealDB sidecar의 서명, 공증, Gatekeeper 통과
- 깨끗한 Mac 최초 실행, 후보 교체 업데이트, 제거·재설치 통과
- 개인 데이터 백업→복구와 daemon·sidecar 강제 종료 복구 통과
- 키보드·VoiceOver 실측 통과

## 2. 개발 실행

개발자는 저장소에서 다음처럼 실행합니다.

```sh
corepack enable
corepack prepare pnpm@11.13.0 --activate
pnpm install --frozen-lockfile
pnpm --filter @massion/desktop tauri:dev
```

이 실행은 개발 빌드이며 공개 설치 검증을 대신하지 않습니다.

## 3. 업데이트와 제거 계약

1.0의 최소 업데이트 경로는 서명·공증된 새 앱으로 기존 `Massion.app`을 교체하는 수동 업데이트입니다. 앱 bundle과 사용자 데이터의 수명은 분리합니다.

- 앱 교체·삭제는 사용자 데이터와 Provider 설정을 지우지 않습니다.
- 새 앱은 기존 데이터 epoch와 schema를 확인한 뒤 연결합니다.
- 호환할 수 없는 데이터는 자동 삭제하지 않고 실행을 중단합니다.
- 자동 업데이트는 수동 교체가 실제 사용자 흐름을 충족하지 못할 때 별도 사양으로 추가합니다.

앱 제거는 `/Applications/Massion.app`을 삭제합니다. 전체 데이터 삭제는 검증된 백업을 만든 뒤 사용자가 별도로 명시해야 하며, 첫 1.0에서 앱 제거와 함께 자동 수행하지 않습니다.

## 4. 로컬 데이터 위치

현재 로컬 daemon은 XDG 환경 변수가 없을 때 다음 경로를 사용합니다.

- 설정과 비밀 키: `$HOME/.config/massion-v1`
- 데이터와 백업: `$HOME/.local/share/massion-v1`
- 프로세스 상태와 로그: `$HOME/.local/state/massion-v1`

`XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`을 지정하면 각 기준 경로 아래의 `massion-v1`을 사용합니다. 이 값은 `packages/local-control/src/daemon.ts`의 `resolveLocalPaths()`가 소유합니다.

## 5. 백업·복구 상태

개인 백업은 내부 `LocalDaemonManager.backup()`과 CLI 경로가 존재하지만, 개인용 데스크톱 복구 진입점과 실제 앱 왕복 UAT는 아직 없습니다. 따라서 현재 백업만으로 복구 가능하다고 안내하지 않습니다. 구현·검증 기준은 [백업·복구 Runbook](backup-restore.md)을 따릅니다.

## 6. 레거시 경로

루트 `install.sh`, `massion` CLI/TUI launcher, `massion --web`, Compose·Kubernetes 문서는 과거 배포 코드입니다. 개인용 데스크톱 1.0이 확정될 때까지 공식 사용자 설치 경로가 아닙니다.
