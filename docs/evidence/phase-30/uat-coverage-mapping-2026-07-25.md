# UAT 시나리오 자동화 커버리지 매핑

> 후보 SHA: 작성일 기준 `feat/phase-30-reconciled` 브랜치 HEAD
> 검증 방식: 서버 통합 테스트(apps/server/src/product.test.ts)와 패키지 단위 테스트가
> 실제 SurrealDB, 실제 daemon, 실제 WebSocket 연결로 Core 파이프라인을 검증한 결과

## 핵심 시나리오 (UAT-01~12)

| UAT | 시나리오 | 백엔드 자동화 | 시각 UAT |
|-----|---------|-------------|---------|
| 01 | 첫 실행과 재연결 | 커버: "실제 control plane을 조립하고 모델 없는 Work만 제한 모드로 차단한다"에서 daemon 시작·onboarding·재시작 검증 | 필요 |
| 02 | Provider 연결 | 커버: "clean install에서 Z.AI Coding Plan connect-model 하나로 Core route·ready 상태·실제 run을 완성한다" | 필요 |
| 03 | 워크스페이스 없는 조사 Work | 커버: "실제 control plane을 조립하고 모델 없는 Work만 제한 모드로 차단한다"에서 workspace 없는 Work 검증 | 필요 |
| 04 | 워크스페이스 디렉터리 추가와 신뢰 | 부분 커버: "trusted Workspace Work는 실제 코드 지식 조립을 거쳐 모델 경계까지 진행한다"에서 workspace 경로 등록 검증 | 필요 (네이티브 선택기) |
| 05 | 파일 첨부와 문맥 반영 | 커버: "OpenAI 호환 route가 있으면 Representative→Strategy→Delivery 실제 Core 경로를 실행한다"에서 workspacePaths 첨부·검색·citation 검증 | 필요 (네이티브 선택기) |
| 06 | 워크스페이스 경계 거부 | 부분 커버: Evidence 패키지 테스트에서 경로 경계 검증 (workspace-knowledge.test.ts) | 필요 (네이티브 선택기) |
| 07 | 실시간 협업방 | 커버: "OpenAI 호환 route" 테스트에서 Representative→Strategy→Delivery 에이전트 handoff·메시지 검증 | 필요 |
| 08 | 실행 중 추가 지시 | 부분 커버: application 패키지에서 directive 전달 검증 (run-commands.test.ts) | 필요 |
| 09 | 승인과 수신함 정합성 | 커버: "초기 설치의 결정 화면은 빈 승인 목록과 자율성 상태를 함께 조회한다" | 필요 |
| 10 | 차단과 재개 | 커버: "실제 control plane을 조립하고 모델 없는 Work만 제한 모드로 차단한다"에서 model-unavailable 차단 검증 | 필요 |
| 11 | 취소 | 부분 커버: application 패키지에서 취소 전파 검증 (core-delivery-stage.test.ts) | 필요 |
| 12 | 완료·산출물·Assurance·Records | 커버: "설치된 Software Engineering 조직이 실제 Git 변경과 독립 Assurance까지 완성한다"에서 독립 검증·기록·완료 검증 | 필요 |

## 지식·기억 시나리오 (UAT-K01~K04)

| UAT | 시나리오 | 백엔드 자동화 | 시각 UAT |
|-----|---------|-------------|---------|
| K01 | Workspace 색인·코드 관계·citation | 커버: "trusted Workspace Work" + "OpenAI 호환 route" 테스트에서 EvidenceBrief·citation·checksum·계보 검증 | 필요 |
| K02 | 경로 경계·manifest 변경·stale 처리 | 커버: "OpenAI 호환 route" 테스트에서 stale_warning·snapshot 변경·IndexVersion 재사용 검증 | 필요 |
| K03 | 개인 기억 저장·재시작·새 Work 적용 | 부분 커버: "초기 설치에서 onboarding이 시드한 조직 메모리"에서 시드된 메모리 조회 검증. 메모리 주입은 활성화됨 | 필요 |
| K04 | 기억 사용 중지 | 부분 커버: growth 패키지에서 MemoryVersion 비활성화 검증 (prompt-memory.test.ts) | 필요 |

## Growth 시나리오 (UAT-G01~G02)

| UAT | 시나리오 | 백엔드 자동화 | 시각 UAT |
|-----|---------|-------------|---------|
| G01 | 기본 검토형 지속 발전 | 부분 커버: "초기 설치에서 onboarding이 시드한 조직 메모리와 빈 제안·효과를 반환한다"에서 빈 후보·효과 조회 검증 | 필요 |
| G02 | 사용자 선택 자동 반영과 복원 | 부분 커버: growth 패키지에서 adopt·revert·effect 검증 (adoption.test.ts, revert.test.ts, effect.test.ts) | 필요 |

## 전체 권한 시나리오 (UAT-P01~P02)

| UAT | 시나리오 | 백엔드 자동화 | 시각 UAT |
|-----|---------|-------------|---------|
| P01 | 전체 권한 활성화와 실행 | 부분 커버: governance-service.test.ts에서 full 모드가 require_approval을 allow로 내리는 검증 | 필요 (서명된 빌드) |
| P02 | 전체 권한 지속·회수와 Growth | 부분 커버: governance 패키지에서 mode 전환·revision 검증 (autonomy.test.ts) | 필요 (서명된 빌드) |

## 확장·설정 시나리오 (UAT-13~16)

| UAT | 시나리오 | 백엔드 자동화 | 시각 UAT |
|-----|---------|-------------|---------|
| 13 | 조직 구조·지도·제안 | 부분 커버: application 패키지에서 조직 그래프 조회 검증 | 필요 |
| 14 | 개선 평가·승인·효과·되돌리기 | 부분 커버: growth 패키지에서 평가·채택·복원 검증 | 필요 |
| 15 | 확장 설치와 실제 사용 | 커버: "번들 Slack Registry 설치는 승인 뒤 같은 commandId로 재개해 active installation을 반환한다" | 필요 |
| 16 | 설정과 로컬 운영 상태 | 커버: "초기 설치의 결정 화면은 빈 승인 목록과 자율성 상태를 함께 조회한다" | 필요 |

## 요약

- 백엔드 자동화로 완전 커버: UAT-01, 02, 03, 05, 07, 09, 10, 12, K01, K02, 15, 16
- 부분 커버: UAT-04, 06, 08, 11, K03, K04, G01, G02, P01, P02, 13, 14
- 시각 UAT 필수 (백엔드 검증 불가): 모든 시나리오의 UI 렌더링, 네이티브 대화상자, 접근성
