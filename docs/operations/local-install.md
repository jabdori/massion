# 개인용 설치·운영 안내

Massion AgentOS 1.0은 macOS·Linux의 사용자 계정 아래에 설치됩니다. 관리자 권한은 필요하지 않습니다.

## 1. 준비

- Node.js 24 이상
- Bun 1.3 이상
- SHA-256 검사 도구(`sha256sum` 또는 `shasum`)

받은 `massion-local-1.0.0.tar.gz`의 크기와 SHA-256이 함께 제공된 `release-manifest.json`과 일치하는지 먼저 확인합니다. 압축을 푼 디렉터리에서는 설치기가 `SHA256SUMS`를 다시 검사합니다.

## 2. 설치와 첫 실행

```sh
mkdir massion-local-1.0.0
tar -xzf massion-local-1.0.0.tar.gz -C massion-local-1.0.0
cd massion-local-1.0.0
./install.sh
export PATH="$HOME/.local/bin:$PATH"
mass version
mass local start
mass init http://127.0.0.1:7331 owner@example.com "내 이름"
mass status
```

다른 사용자 경로에 설치하려면 설치와 제거 때 같은 `MASSION_PREFIX`를 지정합니다.

```sh
MASSION_PREFIX="$HOME/apps/massion" ./install.sh
```

모델 공급자 자격 증명(model provider credential)이 없어도 제어 기능은 제한 모드(limited mode)로 정상 실행됩니다. 실제 모델 호출이 필요한 작업만 명시적으로 차단됩니다.

## 3. 일상 명령

```sh
mass local status
mass run "요청 내용" --detach
mass local backup "$HOME/massion-backup.json"
mass local stop
```

백업 명령은 실행 중인 로컬 서버를 안전하게 멈추고 백업한 뒤 다시 시작합니다. 백업 파일은 소유자만 읽을 수 있는 권한(0600)으로 생성되며 기존 파일을 덮어쓰지 않습니다.

## 4. 데이터 위치

XDG 환경 변수를 지정하지 않은 기본 위치는 다음과 같습니다.

- 설정과 비밀 키: `$HOME/.config/massion`
- 데이터와 백업: `$HOME/.local/share/massion`
- 프로세스 상태와 로그: `$HOME/.local/state/massion`

`XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`을 지정하면 해당 경로를 사용합니다.

## 5. 제거와 복구

설치된 버전의 제거 스크립트를 실행합니다.

```sh
$HOME/.local/lib/massion/1.0.0/uninstall.sh
```

제거는 Massion 실행 파일과 자신이 만든 심볼릭 링크(symbolic link)만 삭제합니다. 사용자 데이터·설정·백업은 보존합니다. 전체 데이터 삭제는 백업을 확인한 뒤 사용자가 직접 수행해야 합니다.

복구는 빈 데이터베이스를 대상으로 `massion-server restore /절대/경로/backup.json`을 실행합니다. 기존 데이터베이스를 덮어쓰는 복구는 지원하지 않습니다.
