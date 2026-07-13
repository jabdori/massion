# Phase 24 구독 UAT 증거

> **실행일**: 2026-07-13
> **실행 방식**: 최종 local release archive를 격리 tmux 세션에서 실행
> **민감정보**: 원시 pane 출력과 계정 식별자는 저장하지 않음

## 계보

- Git commit: `5f1b0822bfbdddced82c15b2f7cc44170bb6fa18`
- Release artifact: `sha256:6959a71b803cae07909432f2ce1fe00394712d26b00f036ee5da9d0deb0e1a92`
- Receipt schema: `massion.subscription-uat.v1`
- Receipt summary: `passed: 1`, `failed: 1`, `not-run: 9`

## 통과한 사용자 흐름

- release 설치와 version 확인
- bundled Connector doctor
- local daemon 시작·owner 초기화·status/readiness
- subscription provider catalog
- SSE event watch 연결
- daemon 재시작과 상태 확인
- owner-only backup 생성과 restore
- uninstall 후 사용자 data 보존

## 외부 계정 때문에 실행하지 못한 흐름

- Claude consumer login: `provider-approval-required`
- Z.AI Coding Plan: `provider-approval-required`
- 두 번째 계정, 두 번째 사용자, 공개 failure injection과 승인 재개: 각 외부 전제조건 필요

Codex consumer 연결은 로그인 동의와 계정·doctor·quota·adaptive policy 조회까지 통과했지만, 실제 `run subscription acceptance`가 180초 제한에 도달해 `network` 실패로 분류되었습니다. 따라서 실행 계보와 fallback 성공을 통과로 기록하지 않았습니다. Codex 로그인은 브라우저 인증 URL에서 추가 사용자 인증이 필요합니다.

## 후속 새 Core release preflight

모델 평가실·확장 registry를 포함한 새 release도 별도 tmux 세션에서 설치·실행 preflight를 시작했습니다.

- Git commit: `4a833fe19617e84139213a89c3fb1d0afa5c6afa`
- Source digest: `sha256:984a9cf28771f1fc1dc61a6af2f5ad5b20fcdf2567dcb5255f130d24e7690db1`
- Local archive: `sha256:23d7cefa13ad6b30a68f7c18e913d8ba426384db8c318881dd158ad2380799f3`
- release lifecycle 설치 preflight는 진행되었고, Codex OAuth는 이메일 입력 화면에서 실제 사용자 인증이 없어 중단했습니다.
- 이 시도는 새 receipt를 생성하지 않았으므로 위 구조화 receipt의 결과를 변경하지 않았습니다.

처음 실행에서 발견된 SSE drain 종료 문제는 `2cb4f65`에서 수정했습니다. 수정 후 최종 receipt의 `restart-stop`과 모든 lifecycle command가 종료 코드 0입니다.
