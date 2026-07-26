# Phase 30 지식·기억 증분 UAT — 2026-07-26

> **상태:** 부분 통과. 이 기록은 최종 공개 후보·서명·공증·동일 후보 SHA의 UAT-K01~K04 완료를 뜻하지 않습니다.

## 이번에 확인한 사실

| 범위 | 실제 관측 | 판정 |
|---|---|---|
| 실제 Provider 지식 경로 | 격리된 임시 Workspace에서 실제 GLM Core Work가 완료됐고, 준비 상태는 `ready`, 허용한 상대 경로는 `src/order.ts` 하나였으며 Representative·Strategy·Delivery 입력에 같은 코드 근거가 존재했습니다. | 부분 통과 |
| 개인 기억 계보 | 실제 GLM Work에서 기억 저장 뒤 새 RuntimeExecution의 `memory_version_ids`에 새 version이 들어가고, 사용 중지 뒤 만든 Work에서는 빠지는 것을 확인했습니다. | 부분 통과 |
| Desktop 지식 빈 상태 | 격리된 `Massion Knowledge UAT.app`에서 Workspace 없는 Work의 `지식` 탭이 지식 전용 안내만 표시했습니다. | 통과 |
| 앱 격리·종료 | 기존 Massion GUI 프로세스가 없는 상태에서 검증용 번들 하나만 실행했고, 확인 직후 종료했습니다. 종료 뒤 GUI 프로세스 0개를 확인했습니다. | 통과 |

## Desktop 관측

릴리스 번들은 다음 설정으로 만들었습니다.

```sh
cargo tauri build --bundles app \
  --config src-tauri/tauri.release.conf.json \
  --config '{"productName":"Massion Knowledge UAT","identifier":"dev.massion.desktop.knowledge-uat"}'
```

실제 앱에서 새 Work를 만들고 `지식` 탭을 선택했을 때 다음 문구를 확인했습니다.

- `이 Work는 워크스페이스 지식을 사용하지 않았습니다.`
- `워크스페이스를 선택한 새 Work에서 코드 근거를 사용할 수 있습니다.`

이전 공용 빈 화면의 `실행이 산출물을 만들면 여기에 표시됩니다.`는 이 탭에 없었습니다. 이 관측으로 공용 `InspectorEmpty`의 고정 상세 문구를 상태별로 전달하도록 보정했고, 해당 실패만 회귀 검사 하나로 고정했습니다.

## 자동 검증

- `pnpm --filter @massion/desktop exec vitest run src/desktop-service.test.ts -t 'Work의 사용한 지식은 typed work.knowledge 조회로 반환한다'` — 통과 (1개 통과, 17개 이름 필터 skip)
- `pnpm --filter @massion/desktop exec vitest run src/app.integration.test.tsx -t '워크스페이스 없는 Work의 지식 빈 상태는 산출물 안내를 재사용하지 않는다'` — 통과 (1개 통과, 31개 이름 필터 skip)
- `pnpm --filter @massion/desktop typecheck` — 통과

## 아직 통과로 표시하지 않는 항목

- 동일 커밋 SHA에서 실제 Tauri 앱과 Provider 설정을 사용한 UAT-K01~K04 전체
- K01의 화면상 1-hop reference와 Core Office 공유 출처 이동, 세 Agent citation checksum 대조
- K02의 manifest 변경·stale 표시·첨부 경로 밖 source 미노출
- K03의 앱·daemon 재시작 뒤 기억 지속 및 새 Work 적용
- K04의 과거 PromptVersion·Records checksum 보존을 포함한 완전한 사용 중지 비교

Provider 키, 실제 파일 절대 경로, 기억 원문, 사용자 식별 정보는 이 기록에 남기지 않았습니다.
