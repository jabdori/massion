# Phase 30 Slice 1B — 개인용 로컬 런타임 기록

> **상태:** 완료. 범위는 새 개인 설치의 local runtime 전환입니다.

## 결정

- 개인용 설치는 clean reset입니다. 이전 local data를 이식하거나 migration하지 않습니다.
- native SurrealDB 3.2.1 binary는 release에 포함되고, 설치 시 사용자 data 경로에 배치됩니다.
- `massion`은 TUI, `massion --web`은 Web Console을 엽니다. 설정이 없으면 둘 다 owner onboarding을 시작합니다.
- application server는 인증된 loopback WebSocket으로 sidecar에 연결합니다.
- 설치기는 `massion`, `massion-connector`만 공개합니다. `massion-server`는 내부 runtime 파일이며 사용자 명령이 아닙니다.

## 구현과 검증

1. binary digest·version·loopback lifecycle을 검증하고, health 뒤 `massion` namespace와 database를 준비했습니다.
2. local application server를 authenticated WebSocket endpoint로 전환했습니다.
3. installer가 현재 platform native binary를 배치하고 launcher에 검증 metadata를 전달하게 했습니다.
4. macOS 시스템 경로 별칭에서도 시작 때 기록한 sidecar를 정상 종료하도록 canonical executable attestation을 사용했습니다.
5. 구독 UAT와 개인용 설치 안내에서 공개되지 않은 `massion-server`·직접 RocksDB 복구 경로를 제거했습니다.
6. 새 release artifact를 빈 HOME에 설치해 다음 흐름을 tmux에서 실행했습니다.

```text
install → massion → owner onboarding → TUI live
install → massion --web → owner onboarding → Web Console HTTP 200
Web session → snapshot / me 200 → 같은 organization 확인
local stop → application·sidecar 포트 종료
```

UAT 테스트 30개와 `CI=true pnpm verify:release`도 같은 릴리스 artifact에서 자동 runtime 준비, 초기화, 상태, backup, 중지, 제거를 통과했습니다. tmux lifecycle UAT는 release 1건 성공·실패 0건으로 끝났고, provider 인증이 필요한 9개 시나리오는 미실행으로 기록했습니다. 이 기록에는 token, Web login code, 개인 경로를 남기지 않습니다.

## 경계

이 Slice는 local runtime 전환만 닫습니다. Cloud, migration, legacy data 보존, 모델 평가실과 추가 provider 기능은 여기에 포함하지 않습니다.
