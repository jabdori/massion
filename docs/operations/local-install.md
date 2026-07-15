# 개인용 설치·운영 안내

Massion AgentOS 1.0은 macOS·Linux의 사용자 계정 아래에 설치됩니다. 관리자 권한은 필요하지 않습니다.

## 1. 준비

- Node.js 24 이상
- Bun 1.3 이상
- SHA-256 검사 도구(`sha256sum` 또는 `shasum`)

## 2. 권장 설치: curl 파이프라인

공개 릴리스는 다음 명령으로 설치합니다.

```sh
curl -fsSL https://raw.githubusercontent.com/jabdori/massion/main/install.sh | bash
```

스크립트를 먼저 검토하려면 저장한 뒤 실행합니다.

```sh
curl -fsSL https://raw.githubusercontent.com/jabdori/massion/main/install.sh -o /tmp/massion-install.sh
less /tmp/massion-install.sh
sh /tmp/massion-install.sh
```

`MASSION_VERSION`은 릴리스 버전(기본 `1.0.0`), `MASSION_PREFIX`는 설치 prefix(기본 `$HOME/.local`)입니다.

```sh
curl -fsSL https://raw.githubusercontent.com/jabdori/massion/main/install.sh \
  | MASSION_VERSION=1.0.0 MASSION_PREFIX="$HOME/apps/massion" bash
```

설치에는 `curl`, `tar`, Node.js 24 이상, Bun 1.3 이상과 `sha256sum` 또는 `shasum`이 필요합니다.

## 3. 수동 설치와 첫 실행

```sh
mkdir massion-local-1.0.0
tar -xzf massion-local-1.0.0.tar.gz -C massion-local-1.0.0
cd massion-local-1.0.0
./install.sh
export PATH="$HOME/.local/bin:$PATH"
massion version
massion
```

`massion init`은 소유자 이메일과 표시 이름을 묻습니다. 설정이 없는 상태에서 `massion`을 실행해도 같은 온보딩을 거칩니다. 자동화에서는 다음 형식을 사용합니다.

```sh
massion init http://127.0.0.1:7331 owner@example.com "내 이름"
```

다른 사용자 경로에 설치하려면 설치와 제거 때 같은 `MASSION_PREFIX`를 지정합니다.

```sh
MASSION_PREFIX="$HOME/apps/massion" ./install.sh
```

## 4. 화면과 일상 명령

```sh
massion
massion --web
```

`massion --web`은 저장된 profile로 5분 유효한 로그인 티켓을 발급합니다.

TUI는 대화형 TTY와 최소 `80×24` 터미널이 필요합니다. 화면이 보이지 않으면 `command -v massion`, `massion version`, `stty size`를 확인하세요.

```sh
massion local status
massion run "요청 내용" --detach
massion local backup "$HOME/massion-backup.json"
massion local stop
```

백업 명령은 실행 중인 로컬 서버를 안전하게 멈추고 백업한 뒤 다시 시작합니다. 백업 파일은 소유자만 읽을 수 있는 권한(0600)으로 생성되며 기존 파일을 덮어쓰지 않습니다.

## 5. 데이터 위치

XDG 환경 변수를 지정하지 않은 기본 위치는 다음과 같습니다.

- 설정과 비밀 키: `$HOME/.config/massion`
- 데이터와 백업: `$HOME/.local/share/massion`
- 서버 연결기 계정별 프로필: `$HOME/.local/share/massion/connectors`
- 프로세스 상태와 로그: `$HOME/.local/state/massion`

`XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`을 지정하면 해당 경로를 사용합니다.
연결기 프로필 디렉터리는 시작할 때 소유자만 접근할 수 있는 권한(0700)인지 검사합니다.

## 6. 사용자 기기 연결 수신

개인 로컬 모드의 연결 장치 WebSocket 수신은 기본적으로 꺼져 있습니다. 같은 컴퓨터에서만 엣지 연결 장치(edge connector)를 시험해야 할 때 다음처럼 명시적으로 켤 수 있습니다. 로컬 서버는 계속 loopback 주소에만 묶이므로 다른 컴퓨터에서는 접근할 수 없습니다.

```sh
MASSION_EDGE_CONNECTOR_ENABLED=true \
MASSION_CONNECTOR_HEARTBEAT_MS=45000 \
massion local start
```

연결 장치 심박 유효 시간(heartbeat TTL)의 기본값은 30,000ms이고 허용 범위는 1,000~300,000ms입니다. 팀원의 다른 기기를 연결하려면 이 로컬 설정을 외부에 노출하지 말고 TLS가 적용된 팀 배포를 사용합니다.

## 7. 제거와 복구

설치된 버전의 제거 스크립트를 실행합니다.

```sh
$HOME/.local/lib/massion/1.0.0/uninstall.sh
```

제거는 Massion 실행 파일과 자신이 만든 심볼릭 링크(symbolic link)만 삭제합니다. 사용자 데이터·설정·백업은 보존합니다. 전체 데이터 삭제는 백업을 확인한 뒤 사용자가 직접 수행해야 합니다.

복구는 빈 데이터베이스를 대상으로 `massion-server restore /절대/경로/backup.json`을 실행합니다. 기존 데이터베이스를 덮어쓰는 복구는 지원하지 않습니다.
