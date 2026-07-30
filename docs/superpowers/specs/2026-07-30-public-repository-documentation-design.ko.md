# 공개 저장소 문서 정합성 설계

[English](2026-07-30-public-repository-documentation-design.md) | [한국어](2026-07-30-public-repository-documentation-design.ko.md)

> 기준 소스: `51a39660f1b6a00a1f79027a4f39a6b0e5061394`
> 대상 독자: Massion을 처음 방문한 사용자와 기여자

## 목적

공개 저장소의 첫 화면에서 Massion이 활발히 개발 중인 사전 릴리스(pre-release) AgentOS임을 분명히 알립니다. 제품 설명, 아키텍처, 검증 기록이 서로 다른 책임을 갖게 하여 설계 문장의 `구현됨` 표현이나 오래된 테스트 수가 현재 출시 상태로 오해되지 않게 합니다.

## 문서 역할

공개 정본 문서는 영어로 작성하고 같은 경로의 `.ko.md` 파일을 한국어 동반 문서로 제공합니다. 두 문서는 상단에서 서로 연결합니다. 날짜별 과거 기록과 증거는 원문을 보존합니다.

- `README.md`: 제품의 핵심 가치, 개발 상태, 공개 릴리스 경계, 개발 시작점
- `PRODUCT.md`와 `docs/product/`: 제품 목적과 변하지 않는 판단 기준
- `docs/architecture/`: 구성요소, 책임 경계, 데이터 흐름, 아키텍처 결정
- `apps/desktop/DESIGN.md`: 데스크톱 시각 언어와 경험 원칙
- `docs/operations/`: 특정 운영 문제를 해결하는 절차
- `docs/superpowers/specs/`: 날짜에 결속된 설계 의도
- `docs/superpowers/plans/`와 `docs/phases/`: 실행 과정과 역사적 계획
- `docs/evidence/`: 날짜·후보 SHA·명령에 결속된 검증 결과

아키텍처와 제품 설계는 완료 여부를 판정하지 않습니다. `구현됨`, `구현 완료`, 고정 테스트 수와 같은 상태 표현은 README와 아키텍처에서 제거합니다. 검증 결과는 `docs/evidence/`에서만 주장하며, README는 공개 릴리스가 없다는 현재 경계만 요약합니다.

## 용어

처음 등장할 때 사람의 의미를 먼저 쓰고 내부 용어를 괄호에 병기합니다.

- 업무(Work)
- 독립 검증(Assurance)
- 기록(Records)
- 자가개선(Growth)
- 지식(Knowledge)
- 제공자(Provider)
- 실행 계층(Runtime)
- 시연 데이터(fixture)

같은 문서 안에서는 첫 정의 이후 영문 식별자만 사용할 수 있습니다. `완료`는 검증된 Work의 도메인 상태에만 사용하고, 프로젝트 개발 상태에는 사용하지 않습니다.

## README 시각 자료

기준 SHA의 브라우저 fixture를 1440×900으로 실행해 다음 네 화면을 캡처합니다.

1. 하나의 Work에서 협업·승인·산출물·검증을 읽는 핵심 화면
2. 영속 조직과 Work별 임시 조직의 책임을 보여주는 Organization 화면
3. Work와 파일·문서 관계를 탐색하는 Knowledge 화면
4. 근거·반대 증거·채택·되돌리기를 보여주는 Growth 화면

이미지는 `docs/assets/readme/`에 저장합니다. README의 캡션은 fixture가 제품 방향을 설명하는 시연이며 실제 Provider 실행이나 공개 릴리스 증거가 아니라고 명시합니다. 이미지 안에 비밀값, 사용자 경로, 계정 식별자를 포함하지 않습니다.

## 범위와 보존

이번 변경은 README, 문서 분류 인덱스, 아키텍처 개요, 제품 헌법의 상태 표현, 데스크톱 문서 안내와 README 이미지에 한정합니다. 날짜와 SHA에 결속된 `docs/evidence/`, 과거 Phase 회고와 실행 계획은 사실 기록이므로 내용을 다시 쓰지 않습니다.

## 수용 기준

- README 첫 화면에서 사전 릴리스와 공개 설치본 부재를 즉시 확인할 수 있습니다.
- README와 아키텍처 문서에 `구현 완료` 표와 고정 테스트 수가 없습니다.
- 아키텍처 도표는 상태 색 대신 책임과 흐름을 표현합니다.
- 문서 역할과 현재 상태의 증거 위치가 `docs/README.md`에서 한 번만 정의됩니다.
- 네 README 이미지가 GitHub Markdown에서 상대 경로로 렌더링됩니다.
- 수정 Markdown의 Prettier 검사와 `git diff --check`가 통과합니다.
- 영어 기본 문서와 `.ko.md` 한국어 문서의 언어 전환 링크가 동작합니다.
- 저장소 루트에 MIT 라이선스 전문이 있고 README는 해당 파일만 연결합니다.
