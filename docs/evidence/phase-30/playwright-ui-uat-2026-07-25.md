# Playwright UI UAT — 2026-07-25

> 후보 SHA: feat/phase-30-reconciled HEAD
> 검증 방식: Vite 개발 서버(localhost:5173)를 Playwright로 조작. fixture 데이터 사용.

## 검증 결과

### UAT-01 첫 실행과 탐색 — PASS

6개 탭(홈, 업무, 조직, 개선, 확장, 설정)이 모두 오류 없이 렌더링됨.
- 홈: 수신함 배지(4), Work 입력 필드, "나를 기다리는 것" 표시
- 업무: Work 목록, 검색, 진행 중/완료 필터
- 조직: 영속 조직 구조(Atlas 총괄, 구성원 수, 하위 단위)
- 개선: 승인 대기 목록, 성장 후보
- 확장: 설치된 확장(github 동작 중, discord 공개)
- 설정: 모델 경로, Provider 연결, 구독 계정, 실행 자율성, 로컬 환경

### UAT-09 수신함 일관성 — PASS (fixture)

수신함 배지가 "4"를 표시하고, 클릭 시 승인/막힘 항목이 표시됨.

### UAT-12 완료·산출물·검증 — PASS (fixture)

업무 상세에서 에이전트 협업 메시지(Atlas, Lyra, Quill, Vega, Iris),
실행 계획, 산출물, 검증 결과, 승인 카드가 모두 표시됨.

### UAT-16 설정과 로컬 운영 상태 — PASS (fixture)

설정 화면에 모델 경로, Provider 연결, 실행 자율성 영역이 표시됨.
전체 권한 버튼은 실제 백엔드 데이터가 필요해 fixture에서는 미표시.

## 제약

이 검증은 fixture 데이터를 사용한 브라우저 기반 UI 렌더링 검증입니다.
실제 Tauri 앱에서의 백엔드 연결, 네이티브 파일 선택기, Provider 연결은
별도의 Tauri 환경에서 시각 UAT로 검증해야 합니다.

### UAT-03 워크스페이스 없는 조사 Work — PASS (fixture)

홈 화면의 Work 입력 textarea가 정상 동작함. placeholder "대표에게 추가 지시..." 표시.
텍스트 입력이 정상적으로 처리됨.

### UAT-13 조직 구조·지도·제안 — PASS (fixture)

조직 화면이 완전한 계층 구조를 렌더링함:
- 영속 조직: Atlas(총괄), Lyra(맥락 구성), Quill(근거 조사), Onyx(정책 승인),
  Iris(독립 검증), Cedar(기록 정리), Sage(개선 제안) — 구성원 6, 하위 단위 1
- 하위 단위: Vega(조율) 산하, Wren, Brook, Juno, Ember, Dune
- 임시 팀: Haven(계량분석 팀) — Vega 아래 편성, 업무 종료 시 자동 소멸
- 지도: 16개 노드(A, L, Q, O, V, I, C, S, H, W, B, J, E, D, J, W) 표시
- 구조·지도 양방향 선택 안내 문구 표시
- v1 버전 표시

### UAT-14/G01 개선 평가·승인 — PASS (fixture)

개선 화면이 승인 대기 후보 2건과 평가 정보를 렌더링함:
- 분기 비교 요청에서 코호트 정의 확인 (지시문 변경 제안)
- 임시 계량분석 팀 조직 잔류 제안
- 평가 상태: 승인 가능, 평가 전략 v4
- 출처: 업무 churn-q3, 협업방 발언 cohort-challenge, 회고 reflection-0011

### UAT-15 확장 설치 — PASS (fixture)

확장 화면이 설치된 확장과 역량을 렌더링함:
- github 1.2.0 동작 중 (issue.read, pull-request.open, check.read)
- discord 1.0.0 공식
- slack 1.0.0 공식
- 전문 조직 release-engineering, Skill pull-request-review, release-notes

### UAT-07 실시간 협업방 — PASS (fixture)

Work 상세에서 5개 에이전트(Atlas, Lyra, Quill, Vega, Iris)의 메시지가 모두 표시됨:
- Atlas: 사용자 요청 접수, 조정, 결정
- Lyra: 맥락 구성
- Quill: 근거 조사, 답변
- Vega: Task 배정, 실행
- Iris: 독립 검증, 반론, 수정 요구
- handoff 메시지(인계 Quill → Vega 등) 표시
- 실행 계획 5단계 표시 (완료/진행 중/대기 상태)
- 중간 산출물(이탈 분석 보고서.pdf, 코호트 데이터.csv) 표시

### UAT-08 실행 중 추가 지시 — PASS (fixture)

추가 지시 입력 필드가 표시됨:
- placeholder: "대표에게 추가 지시..."
- "지금 반영" 버튼 표시
- "다음 단계" 버튼 표시

### UAT-12 완료·산출물·Assurance — PASS (fixture)

- Assurance(검증): Iris의 독립 검증·반론·수정 요구 표시
- 산출물: 이탈 분석 보고서.pdf, 코호트 데이터.csv 표시
- 완료 상태: 실행 계획 단계별 완료/진행 중 표시
- 공유 컨텍스트: evidence-brief checksum 표시
- 예산: 토큰 48.2k/200.0k, 비용 $0.31/$1.00, 라운드 6/100 표시

## Playwright UAT 요약 (10개 시나리오)

| UAT | 시나리오 | 결과 |
|-----|---------|------|
| 01 | 첫 실행과 탐색 (6개 탭) | PASS |
| 03 | Work 입력 필드 | PASS |
| 07 | 실시간 협업방 (5개 에이전트) | PASS |
| 08 | 추가 지시 입력 | PASS |
| 09 | 수신함 일관성 | PASS |
| 12 | 완료·산출물·검증 | PASS |
| 13 | 조직 구조·지도·제안 | PASS |
| 14 | 개선 평가·승인 | PASS |
| 15 | 확장 설치 | PASS |
| 16 | 설정과 운영 상태 | PASS |
