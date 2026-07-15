# Phase 24 — 구독 연결기 회고와 종료 조건

> **상태**: 이전 release 외부 UAT 부분 통과 · 현재 source의 Codex 실행·profile 재사용 재검증 대기
> **대상**: 개인용 Massion Core의 네이티브 구독 연결기와 로컬 릴리스
> **검토 기준**: `docs/evidence/phase-24/subscription-uat-2026-07-14.md`

## 이번 Phase에서 확인한 것

구독 계정 원장, quota 기반 라우팅, 계정별 fallback, Codex·Claude 연결기, Edge Connector, 승인 정책, runtime suspend/resume, CLI·TUI·Web 표면을 Core에 조립했습니다. 연결기와 계정의 비밀값은 공개 query·event·metric으로 노출하지 않는 계약을 유지합니다.

이 절의 로컬 release 결과는 이전 release receipt에 결속된 역사적 기록입니다. 현재 source의 최종 release 검증은 별도로 대기합니다. 당시 다음 흐름을 실제로 통과했습니다.

- 설치와 version 확인
- Connector doctor
- local daemon 시작, owner 초기화, readiness 확인
- provider catalog와 event watch
- daemon 재시작
- owner 전용 backup·restore
- uninstall 뒤 사용자 data 보존

## 검증 결과

구조화된 subscription UAT 영수증은 `massion.subscription-uat.v1`입니다. 최신 실제 Codex UAT는 `passed: 1`, `failed: 1`, `not-run: 9`이며, 경로에 공백이 포함된 tmux 작업공간에서도 설치·시작·재시작·backup·restore·uninstall data 보존을 통과했습니다. 공식 Codex CLI OAuth 인증·계정·doctor·quota·`adaptive` 자동 정책 조회도 통과했지만, 별도의 Massion 데이터 고지·동의 UI는 실행하지 않았습니다. 실제 subscription run은 15분 안에 terminal event를 받지 못해 `network` timeout으로 종료되었습니다. timeout 뒤 공개 runtime 계보 조회는 원시 출력 없이 UAT 계약 실패로 기록됐으며, 이 문제의 안전한 세부 분류를 후속 UAT에 추가했습니다. Claude·Z.AI와 복수 계정 시나리오는 외부 승인·계정 조건이 없어 실행하지 않았습니다. 최신 상세 근거는 `docs/evidence/phase-24/subscription-uat-2026-07-14.md`입니다.

이번 실행에서는 인증 완료를 확인했지만, 외부 모델 응답이 제한시간 안에 도착하지 않았으므로 실행 성공이나 fallback 성공으로 승격하지 않습니다.

## 결정과 교훈

1. 실제 자격 증명과 네트워크가 없는 경우 provider 실행 성공을 추측하지 않습니다.
2. 외부 제공자 승인 전에는 Claude·Z.AI를 공개 연결 가능한 상태로 표시하지 않습니다.
3. 로컬 Core는 Cloud 과금·관리 서버에 의존하지 않으며, 향후 Cloud는 별도 제품 경계로 둡니다.
4. UAT 영수증에는 원시 pane 출력, 이메일, token, 개인 경로를 저장하지 않습니다.
5. 2026-07-14 결정으로 Massion의 개인 Codex 데이터 처리 고지·동의 화면과 append-only 확인 기록을 제거합니다. OpenAI 모델 개선 데이터 제어는 사용자 OpenAI 계정의 선택이며 Massion이 별도 UX로 재확인하거나 저장하지 않습니다. 기존 설치에 남은 Massion 고지 기록 table도 migration으로 제거합니다. Massion 자체의 실사용 학습·shadow 실행·자동 최적화는 기존처럼 별도 동의 전까지 기본 거부입니다.
6. 비대화형 구독 UAT는 `automatic` 승인 정책으로 실제 실행 완료를 검증합니다. 사람 승인이 필요한 `review` 정책은 자동 UAT와 섞지 않고 별도의 상호작용 시나리오로 검증합니다.
7. 실제 제품의 Codex 연결은 새 격리 UAT의 반복 로그인과 분리합니다. `subscription.accounts`에서 기존 server 계정을 찾은 뒤 현재 사용자가 계정 소유자인지 `canManage: true`로 확인하고, 소유 계정만 재사용 후보로 계산합니다. 공유받은 비소유자는 profile·인증 자료·로그인 process에 접근하지 못합니다. 유효한 file profile은 다시 로그인하지 않고, doctor가 `reauth`이거나 계정 상태가 `needs-reauth`일 때만 해당 profile에서 재인증합니다. Codex app-server의 `requiresOpenaiAuth: true`와 `account: null` 조합만 재인증 신호입니다. OpenAI 인증이 필요 없는 provider, API key·Bedrock 등 ChatGPT가 아닌 계정, 유료 plan을 증명할 수 없는 응답은 자동 로그인 없이 유료 구독 불가로 실패 폐쇄합니다. 건강 증명은 직접 quota 관측 증거를 반환해야 하며, 새 계정에서는 이 관측이 model profile·Core route candidate 저장보다 먼저 성공해야 합니다. 관측 불가는 재로그인이나 offline 전이 없이 재시도 가능한 연결 실패가 되고 새 route를 만들지 않습니다. 이전 keyring/`auto` 방식으로 안전한 owner-only `auth.json`이 없는 profile은 전역 keyring을 읽거나 복사하지 않고 동일 profile의 일회성 Massion file-store override 로그인으로 처리합니다. 안전한 기존 `config.toml`은 보존하고 실행마다 override를 적용합니다. Codex 계정이 없을 때의 첫 연결은 기본 명령이고, 기존 계정이 있을 때 새 계정 추가만 `--new-account`로 명시합니다.
8. tmux·실제 child process가 있는 검증은 제품 동시성 정책과 분리합니다. UAT script test file은 순차 실행하고, CLI의 실제 child E2E는 단일 worker에서 실행합니다. 이는 저장소에 고정한 검증 환경 정책이며, 제품의 agent·provider 병렬 실행을 제한하지 않습니다. 상세 근거는 `codex-profile-reuse-contract-2026-07-14.md`에 남깁니다.
9. 2026-07-15에 격리 source snapshot에서 품질·보안·강건성·아키텍처·release 검증의 종료 코드 0을 관측했습니다. 그러나 그 snapshot의 source commit·digest·명령 로그 digest가 저장소에 고정되지 않았고 이후 profile 재사용·quota 코드가 변경되었습니다. 이 기록은 조사 이력일 뿐 현재 source의 전수 검증 근거가 아닙니다. 최종 clean source commit에서 검증을 다시 실행하고 receipt를 고정합니다. 이는 실제 Codex OAuth·모델 실행·복수 계정 fallback UAT와도 별개입니다.

## 2026-07-14 기존 profile 재사용 보강

현재 작업 트리에서는 기존 profile의 재사용 조건을 계정 소유권, doctor의 provider·별칭·Connector 계보와 quota 응답 형식까지 확장했습니다. 연결 뒤에는 서버가 같은 계정에서 직접 quota 관측을 성공시켰다는 공개 증거와 `codex:` / `reported` quota, 유효한 `exhausted`가 모두 확인되어야 ready를 반환하며, 선택적인 잔여 비율은 존재할 때만 0~1 범위로 검증합니다. health 뒤 직접 quota 관측은 진행 중인 scheduler 결과를 재사용하지 않고 새 관측을 요구합니다. 관측 불가는 재로그인이나 offline 전이 없이 재시도 가능한 연결 실패가 됩니다. 새 계정의 prepare·health 실패는 배치된 같은 profile과 동일 command envelope에서 재개해, 실패 command 재생이 새 계정 추가를 잠그지 않게 합니다. 이 흐름은 Connector provision, account/provider/credential transaction, offline 보상으로 구성된 보상 saga입니다. 첫 연결은 기본 명령으로 시작하며, 두 번째 같은 alias 연결은 비대화형으로 실행되어 `connectionDisposition: "reused"`, 동일 account·Connector, provider 계정 1개, 재연결 뒤 quota 관측을 UAT 계약으로 확인합니다.

재개 호환성과 profile 경계도 함께 보강했습니다. 이전 `v1` 재개 파일에 의도 필드가 없으면 이를 새 계정 추가로 해석하지 않고 기존 연결로만 재개합니다. 또한 CLI는 profile의 최종 디렉터리뿐 아니라 상위 경로의 심볼릭 링크를 검사해, 외부 경로에 config를 쓰거나 재인증 process를 시작하기 전에 실패 폐쇄합니다.

이 변경의 자동화 검증은 `docs/evidence/phase-24/codex-profile-reuse-contract-2026-07-14.md`와 `docs/evidence/phase-24/prepare-retry-atomicity-2026-07-15.md`에 분리했습니다. 이 기록은 실제 OAuth UAT 영수증이 아니므로, Phase 24 종료 조건의 실제 사용자 계정 검증을 통과로 바꾸지 않습니다.

## Phase 24 종료 조건

다음 조건이 모두 충족되면 Phase를 `completed`로 변경합니다.

1. 사용자 OAuth 인증 후 Codex subscription run의 성공 또는 명확한 provider 실패 계보를 새 receipt로 기록합니다.
2. 실제 연결된 복수 계정에 대해 rotation·quota·offline·429·fallback·중단·재개·재시작을 검증합니다.
3. 외부 계정이 승인된 경우에만 Claude·Z.AI 시나리오를 추가하고, 승인되지 않은 경우에는 현재 `provider-approval-required` 근거를 유지합니다.
4. 최종 source commit, release manifest, UAT receipt가 서로 가리키도록 고정합니다.
