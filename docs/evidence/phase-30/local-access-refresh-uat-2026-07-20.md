# Phase 30 개인 local access token 갱신 UAT — 2026-07-20

> **결과:** 통과
> **범위:** 깨끗한 local runtime의 만료 token 자동 갱신

1. 빈 HOME에서 `init`으로 native SurrealDB sidecar와 application server를 시작했습니다.
2. 실제 application API로 60초 수명의 개인 access token을 발급해 기존 0600 file profile에 넣었습니다.
3. token 만료 뒤 같은 `massion status --json`을 실행했습니다.
4. 상태는 정상으로 응답했고, token file은 0600을 유지한 채 새 token으로 교체됐습니다.
5. 같은 profile로 `massion --web`의 local Web URL 발급과 TUI의 live 연결 화면도 확인했습니다.

이 검증은 profile 재사용과 연결만 포함합니다. TUI·Web 전체 기능 동등성은 별도 parity UAT에서 확인합니다.
