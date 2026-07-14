# Phase 24 — 네이티브 구독 연결기와 실제 사용자 인수 검증 설계

> **상태**: approved
> **승인일**: 2026-07-12
> **검수 근거**: `docs/phases/24-native-subscription-connectors/provider-surface-review.md`
> **선행 단계**: Phase 0~23 completed

## 1. 목적

Massion이 외부 Gateway 설치를 전제하지 않고 ChatGPT Codex와 공식적으로 허용된 구독·OAuth·Coding Plan 계정을 네이티브로 연결합니다. 같은 제공자의 여러 계정을 개인 또는 조직 공유 pool로 운영하고 할당량·reset·health를 반영해 회전·fallback합니다. Anthropic 소비자 로그인과 Z.AI Coding Plan은 제공자의 사전 승인이 확인될 때까지 실패 폐쇄(fail-closed)합니다.

## 2. 제품 경계

- 구독 계정의 소유권·공유 동의·철회와 사용 계보를 Massion이 소유합니다.
- 공식 SDK·CLI·OAuth·Coding endpoint만 사용하며 다른 프로그램의 token을 역추출하지 않습니다.
- 조직 공용 계정은 서버 연결기, 사용자가 제공한 계정은 사용자 기기 연결기를 기본값으로 사용합니다.
- 모델 제공자와 자체 Tool·sandbox를 가진 Agent runtime을 구분합니다.
- OmniRoute, LiteLLM, Portkey는 선택 가능한 외부 Gateway이며 필수 dependency가 아닙니다.

## 3. 요구사항

- `REQ-SUBSCRIPTION-001`: 복수 구독 계정을 개인·조직 범위와 server·edge 위치로 등록·공유·철회·연결 해제할 수 있습니다.
- `REQ-SUBSCRIPTION-002`: `adaptive` 정책이 복수 quota window, reset 시각, health, sticky와 실시간 실패를 결정론적으로 반영합니다.
- `REQ-SUBSCRIPTION-003`: Hermes Agent의 기본 제공자 범위를 참고한 공식 구독·OAuth·Coding Plan 연결기를 Massion이 직접 제공합니다.
- `REQ-SUBSCRIPTION-004`: 공식적으로 실행이 허용된 실제 계정과 최종 release artifact를 `tmux` 사용자 시나리오로 검증하고 비밀이 제거된 영수증을 남깁니다. 사전 승인이 필요한 Claude 소비자 로그인과 Z.AI는 성공으로 가장하지 않고 `provider-approval-required` 영수증을 남깁니다.
- `REQ-SUBSCRIPTION-005`: Codex 소비자 구독은 유료 ChatGPT 플랜, 계정별 실제 모델 목록과 할당량을 Codex app-server로 직접 확인합니다. 모델 프로필은 실행 시점 가용성, OpenAI 공식 능력 계약, 고정된 bundled runtime 증명을 서로 독립된 불변 근거로 보존한 뒤에만 Core route에 들어갑니다.
- `REQ-SUBSCRIPTION-006`: 승인 방식은 Provider 전체가 아니라 실제 연결 표면별 능력을 지켜야 합니다. Codex 서버 연결은 `automatic`·`review`·`deny`, Codex Edge 연결은 `automatic`·`deny`만 지원하며, `review` 정책에서는 Edge 계정을 라우팅 후보에서 제외합니다.
- `REQ-SUBSCRIPTION-007`: 사람 승인 화면은 실행 파일·인수·작업 경로·변경 요약·제공자 이유만 정규화·비밀 제거해 표시합니다. 자동 반영 정책은 승인함을 거치지 않습니다.
- `REQ-SUBSCRIPTION-008`: 개인 Codex 로그인은 Massion의 별도 데이터 처리 고지·동의 화면·확인 기록 없이 공식 Codex 로그인 흐름으로 진행합니다. OpenAI의 모델 개선 데이터 제어는 사용자가 OpenAI 계정에서 직접 선택하며, Massion은 그 선택을 재확인·대리 설정·저장하지 않습니다. 이전 버전이 남긴 고지 기록 table은 migration으로 삭제합니다. Massion 자체의 실사용 학습·shadow 실행·자동 최적화는 별도 정책에서 기본 거부를 유지합니다.
- `REQ-SUBSCRIPTION-009`: MiniMax Token Plan의 현재 Core 경로는 서버 관리형 OpenAI 호환 `https://api.minimax.io/v1`과 인증된 `MiniMax-M2.7` 모델 목록으로 한정합니다. Edge Connector와 미검증 제공자 표면은 Credential 생성 전에 거부합니다.

## 4. Codex 모델·할당량 증명 계약

- 인증은 `account/read`의 `type=chatgpt`와 명시적인 유료 `planType`을 모두 요구합니다. `free`, `unknown`, 누락 값은 재인증 필요 상태로 실패 폐쇄합니다. API 사용 계정의 `type=apiKey`는 소비자 구독과 섞지 않습니다.
- 남은 할당량은 `account/rateLimits/read`의 기본·보조 시간 창(primary/secondary window)을 같은 구독 동기화 스케줄러에서 불변 snapshot으로 기록합니다.
- 선택 모델은 `model/list`가 해당 계정에 실제 반환한 GPT-5.6 계열로 제한합니다. 사용자가 모델을 지정하지 않으면 app-server 기본 모델을 먼저 사용하고, 기본값이 없으면 Sol → GPT-5.6 별칭 → Terra → Luna 순서로 선택합니다.
- 모델 능력과 1,050,000 token context는 [OpenAI GPT-5.6 최신 모델 안내](https://developers.openai.com/api/docs/guides/latest-model)와 각 GPT-5.6 모델 문서를 근거로 합니다. 현재 runtime 가용성은 [Codex app-server의 모델 목록 계약](https://learn.chatgpt.com/docs/app-server#list-models-modellist)으로 별도 증명합니다.
- 라우터의 모델 증명 근거(model verification evidence)는 갱신·삭제할 수 없습니다. 계정별 가용성 근거가 없는 Codex credential은 해당 모델의 순환·대체 경로 후보에서 제외합니다.

### 4.1 Codex 표면별 승인 계약

- 서버 연결기의 `review`는 Codex app-server의 서버 요청(server request)인 명령 실행 승인(`item/commandExecution/requestApproval`)과 파일 변경 승인(`item/fileChange/requestApproval`)을 Governance 승인함에 연결합니다.
- 승인·거부는 대화 prompt를 다시 실행하지 않고 보류 중인 같은 JSON-RPC 요청 ID에 응답합니다. 취소는 보류 요청을 `cancel`로 끝내고 같은 thread와 turn에 `turn/interrupt`를 보냅니다. 기존 session은 `thread/resume`으로 재개합니다.
- Edge Codex는 현재 영속 승인 재개 전달(persistent approval transport)이 없으므로 `review`를 공개하지 않습니다. Provider 공통 승인 목록은 하위 호환 client를 위한 교집합인 `automatic`·`deny`이고, 표면별 목록은 서버 `automatic`·`review`·`deny`, Edge `automatic`·`deny`입니다.
- Provider 정책이 `review`이면 라우터가 Edge credential을 선택 전에 제외합니다. 서버 credential이 있으면 그 계정을 선택하고, 없으면 실행 adapter까지 진행하지 않고 사용 가능한 모델 없음으로 실패 폐쇄합니다.

## 5. Claude 선택형 승인 재개 계약

- Claude Agent SDK 서버 runtime의 `review`는 공식 `PreToolUse` hook에서 `permissionDecision: "defer"`를 반환합니다. 일반 권한 callback을 거부하고 prompt를 다시 실행하지 않습니다.
- terminal result의 `stop_reason: "tool_deferred"`와 원 도구 정보(`deferred_tool_use`)가 hook에서 확인한 session·도구 호출 ID·도구 이름·입력 digest와 모두 일치할 때만 승인 대기로 기록합니다.
- 승인 후에는 새 사용자 turn을 넣지 않고 같은 session을 `--resume`합니다. 다시 호출된 `PreToolUse`가 동일 원 도구임을 확인한 경우에만 한 번 허용합니다.
- 거부·취소·process 재시작에서는 session을 재개하지 않습니다. 표식 불일치·다중 병렬 defer·재평가 누락은 실패 폐쇄하고 남은 승인을 취소합니다.
- 이 runtime 계약과 별개로 Anthropic 소비자 로그인은 제공자 사전 승인 전 `requires-provider-approval` 상태를 유지합니다.

## 6. 완료 조건

- 상세 설계 14절의 완료 조건을 모두 충족합니다.
- 기존 API key·Gateway·local model·Core Office·Software Engineering 경로에 회귀가 없습니다.
- 전체 품질·보안·강건성·설치 릴리스 검증을 다시 통과합니다.
- 미해결 CRITICAL·MAJOR finding이 0이며 실행하지 못한 실제 외부 계정은 명시합니다.
