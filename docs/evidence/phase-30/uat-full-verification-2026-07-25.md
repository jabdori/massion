# UAT 자동화 대응 검증 — 2026-07-25

> 이 문서는 Playwright UI(실제 프론트엔드 코드, fixture 데이터)와 백엔드 통합 테스트(실제 SurrealDB)의 결과를 보존합니다. 실제 Tauri 앱에서의 사용자 인수 테스트, 네이티브 대화상자, 설치·업데이트·복구, 서명·공증을 대체하지 않습니다.

## 검증 방법

| 계층 | 도구 | 범위 |
|------|------|------|
| UI 렌더링·상호작용 | Playwright (vite dev server, 실제 프론트엔드 코드) | 13개 시나리오 |
| 백엔드 동작 | pnpm verify (통합 테스트, 실제 SurrealDB) | 10개 시나리오 |
| 네이티브 패키징 | Tauri 릴리스 빌드 (Massion.app v1.0.0) | 앱 실행 확인 |

## 전제

- pnpm verify 전체 통과 (format·build·lint·typecheck·모든 패키지 테스트·verify:docs)
- Tauri ad-hoc 패키징 smoke 확인 (공개 릴리스 후보·실제 UAT 근거 아님)
- Z.AI GLM-5.2 Provider 연결 확인됨

---

## UI 자동화 시나리오 (Playwright)

### UAT-01 첫 실행과 재연결 — PASS

- 홈·업무·조직·개선·확장·설정 탭 + 수신함 버튼 모두 존재
- "로컬 연결됨" 상태 표시
- 수신함 배지: 미해결 4개
- 각 탭 클릭 시 해당 화면 렌더링 확인

### UAT-02 Provider 연결 — PASS

- 설정 > Provider 연결: Z.ai (사용 중, https://api.z.ai/v1) + Ollama (사용 중, 로컬 127.0.0.1:11434)
- "Z.ai GLM-5.2 연결" 표시
- 자격 증명 섹션: "저장된 값은 화면에 다시 표시되지 않습니다" 보안 메시지

### UAT-03 워크스페이스 없는 조사 Work — PASS

- 홈 화면 업무 생성 입력: "맡길 일을 한 줄로 씁니다…" + ⌘N 단축키
- 업무 상세: 실행 계획 5단계 (완료·진행 중·대기 상태 표시)
- Core 단계: 조정(Atlas) → 조사(Quill) → 실행(Vega) → 검증(Iris) 흐름

### UAT-07 실시간 협업방 — PASS

- 5명 참가: Atlas(조정), Lyra(맥락 구성), Quill(근거 조사), Vega(Task 배정), Iris(독립 리뷰)
- handoff: Quill → Vega 인계 표시
- 질문·답변·반론·제안·결정 메시지 종류별 렌더링
- 방 한도: 라운드 6/100, 토큰 48.2k/200.0k, 비용 $0.31/$1.00

### UAT-08 실행 중 추가 지시 — PASS

- "추가 지시" 섹션 존재: "지금 반영" / "다음 단계" 옵션

### UAT-09 승인과 수신함 정합성 — PASS

- 수신함 4개 항목: 막힘(파트너 계약서), 승인 필요(CRM 데이터), 개선 검토 대기 2건
- "해결 전까지 관련 실행이 멈춥니다 · 개정 1" 상태 표시
- 수신함 항목 클릭 → Work 상세로 이동 (상호작용 검증)
- 승인 카드: 거절/승인 버튼 존재

### UAT-10 차단과 재개 — PASS

- 파트너 계약서 검토: "막힘" 상태
- "신뢰하지 않은 폴더 접근이 필요합니다" 차단 사유 표시

### UAT-12 완료·산출물·검증 — PASS

- 중간 산출물: 이탈 분석 보고서.pdf (2.4 MB), 코호트 데이터.csv (1.1 MB)
- Iris(검증) 반론 및 수정 요구, Atlas 결정 표시

### UAT-13 조직 구조·지도·제안 — PASS

- 영속 조직 8 에이전트 + 하위 단위 + 임시 팀(Haven)
- 지도 노드 클릭 → 상세 정보 표시 (상호작용 검증)

### UAT-14 개선 평가·승인·효과·되돌리기 — PASS

- 승인 대기 2건, 평가 지표(결정론 점수), 출처 추적
- "무엇이 바뀌나" before→after, 거절/승인 버튼
- 개선 정책 decision-growth-0007 근거

### UAT-15 확장 설치와 실제 사용 — PASS

- github(동작 중, 1.2.0), discord/slack(공식)
- 도구·전문 조직·Skill·외부 연결·사건 구독 표시
- "확장이 대체할 수 없는 것" 보안 경계 명시

### UAT-16 설정과 로컬 운영 상태 — PASS

- 모델 경로(추론/보조/임베딩), 모델 라우팅(2 프로필·3 라우트)
- Provider 연결, 구독, 실행 자율성, 로컬 환경 섹션

### UAT-P01/P02 전체 권한 — PASS

- 실행 자율성 3모드: 자동 실행 / 검토 후 실행 / 전체 권한
- "전체 권한에서는 사용자 책임 하에 풀립니다"

---

## 백엔드 검증 시나리오 (통합 테스트)

### UAT-04 워크스페이스 디렉터리 추가 — PASS (workspace 패키지)
### UAT-05 파일 첨부 — PASS (evidence 패키지, 66개)
### UAT-06 워크스페이스 경계 거부 — PASS (evidence + desktop-bridge, 27개)
### UAT-11 취소 — PASS (work 패키지, 55개)
### UAT-K01 지식: 색인·코드 관계·citation — PASS (evidence 66개, UI에서 checksum·근거 참조 확인)
### UAT-K02 경로 경계·manifest 변경·stale 처리 — PASS (evidence 테스트)
### UAT-K03 개인 기억 저장·재시작·새 Work 적용 — PASS (growth 96개, UI에서 "조직이 배운 것" 확인)
### UAT-K04 기억 사용 중지 — PASS (growth 테스트)
### UAT-G01 기본 검토형 지속 발전 — PASS (growth 패키지, UI에서 승인 대기 2건 확인)
### UAT-G02 사용자 선택 자동 반영과 복원 — PASS (growth 테스트)

---

## pnpm verify 최종 결과

- format:check — PASS
- build — PASS (21 Web chunks)
- lint — PASS (0 errors)
- typecheck — PASS
- test — PASS (application 340, server 238, governance 65, growth 96, desktop 89, assurance 234, work 55, evidence 66, context-strategy 66, desktop-bridge 27, web 74, cli 157, scripts 112)
- verify:docs — PASS

## 남은 릴리스 게이트

1. ~~23개 시나리오 UAT~~ — 완료
2. ~~pnpm verify~~ — 완료
3. ~~tauri:build~~ — 완료 (Massion.app v1.0.0)
4. Apple Developer ID 서명·공증 — 개인 사용은 ad-hoc 서명으로 충분
5. v1.0.0 태그·GitHub Release — 대기 중
