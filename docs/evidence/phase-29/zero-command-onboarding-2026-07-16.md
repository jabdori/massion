# Phase 29 증거: 첫 실행 온보딩과 자동 로컬 서버

## 구현 커밋

- `dc44307` — `feat(cli): automate personal onboarding and local startup`
- `6a58eaf` — `fix(cli): continue first launch into tui`

## 제품 동작

- `massion init`은 인자가 없으면 소유자 이메일과 표시 이름을 대화형으로 묻습니다.
- `massion init [endpoint] <email> <display name>`의 명시적 형식은 스크립트·자동화용으로 유지합니다.
- 개인용 loopback endpoint(`http://127.0.0.1:7331`)는 `massion init`, `massion`, `massion --web`에서 필요한 경우 자동으로 준비합니다.
- 원격 profile에서는 로컬 서버를 시작하지 않고, `massion local start`와 `massion local stop`은 진단·자동화용 명시적 수명주기 명령으로 남깁니다.
- 공개 설치 런처에서 설정 파일이 없는 첫 `massion`은 온보딩을 완료한 뒤 같은 실행에서 TUI를 엽니다.
- TUI는 설정 파일·서버 오류를 숨기지 않고 사람이 이해할 수 있는 안내를 출력합니다.

## 검증 결과

2026-07-16, source commit `6a58eafabd30214434b2837908a0947c4dd2fb29`에서 실행했습니다.

```text
CI=true pnpm test
# scripts 82 passed; workspace packages including CLI 115, server 217,
# TUI 54 (Bun renderer 13), Web 18 — failures 0

CI=true pnpm verify:security
# 14 test files, 67 passed, moderate/high/critical 0, low 1

CI=true pnpm verify:hardening
# 6 test files, 26 passed; load: {"requests":500,"concurrency":32,"failures":0,"p95Ms":15.43,"shutdown":"clean"}

CI=true pnpm release:build /private/tmp/massion-release-20260716-zero-command-final
CI=true pnpm verify:release /private/tmp/massion-release-20260716-zero-command-final
# status: passed, mode: limited, connector: ready, backup: restored,
# uninstall: data-preserved
```

최종 개인용 아카이브는 다음으로 고정되었습니다.

- `massion-local-1.0.0.tar.gz`
- `sha256:b298c933da46353b6008f732940abed78d0bf732c2775eba3f6a304a38e65ebf`
- source digest: `sha256:c339aff0b2efb3796100b3e2567050b7a18e21273b73611c8d54eb948e889cfe`

## 실제 tmux 첫 실행

빈 `HOME`·설치 prefix에서 최종 아카이브를 설치한 뒤 100×30 tmux에서 `massion`만 실행했습니다.

1. `소유자 이메일:` 온보딩 프롬프트가 표시되었습니다.
2. 이메일과 표시 이름을 입력했습니다.
3. 로컬 서버가 자동으로 준비되었습니다.
4. 같은 `massion` 프로세스가 TUI를 열고 조직 상태·연결 상태·도움말을 렌더링했습니다.
5. `massion local stop --json`으로 테스트 서버를 정상 종료했습니다.

이 검증은 `massion local start`를 사용하지 않았습니다.
