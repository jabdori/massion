# Growth 효과 관찰 루프 증분 검증 — `ca6096b47`

> 이 문서는 공개 릴리스나 실제 데스크톱 UAT 완료 증거가 아닙니다. 동일 후보 SHA에서 Growth 효과 계보·metric adapter·worker 경계와 미해결 product 통합 테스트를 기록합니다.

## 후보와 변경 범위

- 후보 SHA: `ca6096b47`
- 포함 커밋: `fcf10924a`, `f69552740`, `9d06da5f6`, `57a64830f`, `201f722b8`, `33dcbc8b6`
- 확인한 경계:
  - baseline은 Adoption 이전 target, observation은 이후 target에 결속
  - Work·terminal Assurance·Verification·MetricObservation 계보와 checksum 저장
  - `massion.growth.assurance-pass-rate.v1`은 서버가 artifact와 Assurance verdict를 재조회해 `ratio`를 계산
  - trigger가 없는 tick에도 observing Adoption의 효과 루프 실행
  - pending baseline은 recovery scan 대상에 포함
  - `degraded`는 기존 Growth Revert 경로로 전달

## 재실행 결과

통과:

```text
pnpm --filter @massion/server exec vitest run src/growth-worker.test.ts --no-file-parallelism --maxWorkers=1
Test Files 1 passed, Tests 5 passed

pnpm --filter @massion/growth exec vitest run src/effect.test.ts src/revert.test.ts --no-file-parallelism --maxWorkers=1
Test Files 2 passed, Tests 9 passed

pnpm --filter @massion/growth exec vitest run src/recovery.test.ts --no-file-parallelism --maxWorkers=1
Test Files 1 passed, Tests 13 passed

pnpm verify:docs
문서 구조 검증 통과
```

서버 타입 검사도 이 증분에서 통과했습니다.

## 아직 실패하거나 실행하지 않은 검증

`src/product.test.ts`와 Growth worker 테스트를 같은 명령으로 실행했을 때 16개 중 5개가 실패했습니다. 실패는 ApplicationRun startup recovery 1건, control plane snapshot 1건, Core 경로 snapshot 2건, Software Engineering index fixture 1건입니다. 이 문서에서는 이를 통과로 집계하지 않습니다. 각 실패는 현재 Growth 효과 코드의 성공 근거가 아니며, 별도 공통 원인 분석이 필요합니다.

이 후보에서 실제 Tauri 앱·실제 Provider·재시작·파일 첨부·workspace directory context·10개 이상 최종 시나리오를 다시 실행하지 않았습니다. 이전 `d4f3b44f9` Tauri/API 증거는 이 SHA의 완료 증거로 재사용하지 않습니다. Computer Use 초기화도 계속 `@oai/cdp-browser-backend` 누락으로 차단된 상태입니다.

공개 GitHub Release는 만들지 않았습니다.
