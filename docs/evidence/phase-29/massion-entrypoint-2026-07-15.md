# Phase 29 증거: 단일 진입점과 설치 UX

## 범위

이번 변경은 사용자가 기억해야 할 명령을 `massion`으로 통일하고, 초기화 전 안내·TUI·Web Console·릴리스 설치 경로를 하나의 사용자 흐름으로 연결합니다. `mass`와 `massion-tui` 호환 별칭은 만들지 않습니다.

## 확인된 구현

- 인자 없이 대화형 터미널에서 `massion`을 실행하면 번들 TUI를 실행합니다. 종료 시 화면 트리를 먼저 분리해 OpenTUI 정리 경고를 남기지 않습니다.
- 초기화 전 TUI 설정이 없으면 원시 파일 시스템 오류 대신 `massion init` 예시를 안내합니다.
- `massion --web`은 선택된 기존 profile의 token으로 5분짜리 일회성 Web 로그인 티켓을 만들고, 코드를 URL에 넣지 않은 채 브라우저를 엽니다.
- 로컬 서버는 `MASSION_WEB_ROOT` 아래의 정적 Web 파일만 같은 origin에서 제공하며, API·health·경로 탈출(path traversal)은 정적 파일 처리에서 제외합니다.
- 릴리스 prefix에는 `massion`, `massion-connector`, `massion-server`만 공개 심볼릭 링크로 설치합니다.
- 저장소 루트 `install.sh`는 GitHub Releases의 버전 고정 매니페스트·아카이브를 내려받고 SHA-256을 검증한 뒤 번들 설치기로 위임합니다.

## 자동 검증

다음 검증은 2026-07-15 작업 트리에서 실행했습니다.

```text
CI=true pnpm --filter @massion/tui exec vitest run src/main.test.ts       # 3 passed
CI=true pnpm --filter @massion/cli exec vitest run src/web-login.test.ts  # passed
CI=true pnpm --filter @massion/application exec vitest run src/http-web.test.ts # passed
node --test scripts/local-release-install.test.mjs scripts/install-script.test.mjs # 11 passed
CI=true pnpm --filter @massion/web build                                  # success
```

`scripts/install-script.test.mjs`는 실제 네트워크 대신 loopback HTTP 릴리스 서버를 사용해 매니페스트·아카이브·해시 검증과 설치 링크를 확인합니다. 공개 GitHub Release 자산을 통한 최종 설치는 릴리스 tag와 자산을 게시한 뒤 별도로 수행해야 합니다.

## 추가로 확인한 로컬 릴리스 검증

clean commit `b1ab796160aac1dbd5a149f8c0a98044f0d456a5`에서 다음을 실행했습니다.

```text
CI=true pnpm release:build /private/tmp/massion-release-20260715-entrypoint
CI=true pnpm verify:release /private/tmp/massion-release-20260715-entrypoint
```

릴리스 검증은 빈 임시 prefix에서 `massion version`·Connector doctor·local start·owner init·limited status·Work 접수·backup·restore·uninstall 및 데이터 보존을 확인하고 `status: passed`를 반환했습니다. 생성된 개인용 아카이브는 382,064,125 bytes이며 매니페스트에 SHA-256이 기록됐습니다.

## 외부 환경에서 남은 검증

- 실제 macOS·Linux 계정에서 `massion`, `massion --web`, 연결기·quota·fallback 시나리오
- GitHub Release 자산 게시 후 공개 URL의 `curl | bash` 설치
