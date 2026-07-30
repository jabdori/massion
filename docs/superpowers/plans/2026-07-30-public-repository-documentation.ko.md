# 공개 저장소 문서 정합성 Implementation Plan

[English](2026-07-30-public-repository-documentation.md) | [한국어](2026-07-30-public-repository-documentation.ko.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 공개 저장소가 영어 기본·한국어 동반 문서로 Massion의 제품 가치와 사전 릴리스 상태를 정확히 설명하고, 아키텍처 문서가 구현 완료 여부 대신 책임과 흐름을 설명하게 합니다.

**Architecture:** 공개 진입점, 제품 원칙, 아키텍처, 역사적 설계, 검증 증거의 문서 책임을 분리합니다. 기준 SHA의 실제 fixture 네 화면을 README 자산으로 사용하되 출시 증거와 구분합니다.

**Tech Stack:** Markdown, Mermaid, Vite fixture, agent-browser, Prettier, Git

---

### Task 1: 문서 책임과 용어 정본을 세운다

**Files:**
- Create: `docs/README.md`
- Modify: `docs/product/constitution.md`
- Modify: `apps/desktop/README.md`

- [ ] **Step 1: 문서 분류와 용어 규칙을 작성한다**

`docs/README.md`에 현재 정본, 아키텍처, 운영 안내, 날짜별 설계, 역사 기록, 검증 증거를 구분하고 `완료`가 Work 도메인 상태 또는 SHA 결속 증거에서만 쓰인다는 규칙을 기록합니다.

- [ ] **Step 2: 제품 헌법에서 구현 상태 소유권을 제거한다**

헌법이 제품 원칙을, 아키텍처가 책임 경계를, evidence가 검증 상태를 소유하도록 문장을 바꿉니다. Core Office의 책임 설명은 유지하되 `구현되어 있습니다` 같은 상태 문장을 제거합니다.

- [ ] **Step 3: 데스크톱 안내를 공개 문서 분류에 연결한다**

`apps/desktop/README.md`에서 실행 방법과 fixture 경계를 설명하고 `docs/README.md`와 `DESIGN.md`를 연결합니다.

- [ ] **Step 4: 공개 문서를 영어 기본·한국어 동반 구조로 만든다**

현재 공개 정본은 영어 파일명을 유지하고, 한국어 문서는 같은 위치에 `.ko.md` 접미사로 둡니다. 각 문서 상단에서 두 언어를 오갈 수 있게 합니다.

### Task 2: README를 사전 릴리스 제품 소개로 다시 구성한다

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 최상단 개발 경고를 GitHub callout으로 바꾼다**

공개 설치 가능한 안정 버전이 없고 API·데이터·경험이 바뀔 수 있으며 저장소의 빌드가 출시를 뜻하지 않는다고 명시합니다.

- [ ] **Step 2: 구현 완료 표와 고정 테스트 수를 제거한다**

제품이 해결하려는 문제와 Work 중심 세로 흐름을 설명하고, 상태 수치는 evidence로만 연결합니다.

- [ ] **Step 3: 핵심 화면과 fixture 캡션을 배치한다**

`docs/assets/readme/agentos-work.png`와 `docs/assets/readme/agentos-knowledge.png`를 제품 설명 직후 표시하고 출시 증거가 아님을 명시합니다.

### Task 3: 아키텍처를 상태표에서 책임 지도로 바꾼다

**Files:**
- Modify: `docs/architecture/README.md`
- Modify: `docs/architecture/desktop-clean-sheet.md`

- [ ] **Step 1: 구현 상태 범례와 상태 색을 제거한다**

Mermaid 노드는 중립적인 계층 색만 사용하고 `implemented`, `planned`, Phase 완료 표기를 제거합니다.

- [ ] **Step 2: 구성요소·Work·Provider·데이터·Extension 흐름을 보존한다**

각 절은 무엇이 어떤 정본을 소유하고 어떤 경계를 넘는지만 설명합니다. 현재 결함과 완료 판정은 evidence와 날짜별 설계로 이동시킵니다.

- [ ] **Step 3: 완료 체크리스트를 수용 기준으로 바꾼다**

`desktop-clean-sheet.md`의 `구현 완료 체크리스트`를 `전환 수용 기준`으로 바꾸고 규범 문장으로 유지합니다.

### Task 4: 기준 SHA의 fixture 이미지를 만든다

**Files:**
- Create: `docs/assets/readme/agentos-work.png`
- Create: `docs/assets/readme/agentos-organization.png`
- Create: `docs/assets/readme/agentos-knowledge.png`
- Create: `docs/assets/readme/agentos-growth.png`

- [ ] **Step 1: 설치된 Vite를 직접 실행한다**

Run: `../../node_modules/.bin/vite --host 127.0.0.1`
Expected: `http://127.0.0.1:5173/`에서 브라우저 fixture가 열립니다.

- [ ] **Step 2: Work 핵심 화면을 캡처한다**

Run: `npx -y agent-browser --session massion-readme set viewport 1440 900`
Run: `npx -y agent-browser --session massion-readme open http://127.0.0.1:5173/`
Run: `npx -y agent-browser --session massion-readme screenshot docs/assets/readme/agentos-work.png`
Expected: 협업방, 참가자, 승인, 산출물이 개인정보 없이 렌더링됩니다.

- [ ] **Step 3: Knowledge 화면을 캡처한다**

주요 탐색의 `지식` 버튼을 열고 Work별 지도를 표시한 뒤 `agentos-knowledge.png`로 캡처합니다.

- [ ] **Step 4: Organization과 Growth 화면을 캡처한다**

조직의 영속·임시 책임 구조와 개선 제안의 근거·반대 증거·채택 제어가 보이도록 각각 `agentos-organization.png`, `agentos-growth.png`로 캡처합니다.

### Task 5: 문서 묶음을 검증하고 공개 브랜치에 반영한다

**Files:**
- Verify: all modified Markdown and `docs/assets/readme/*.png`

- [ ] **Step 1: 상태 표현과 고정 테스트 수를 검사한다**

Run: `rg -n '구현 완료|:::implemented|classDef implemented|test 통과' README.md docs/architecture docs/product/constitution.md`
Expected: 결과 없음

- [ ] **Step 2: 형식과 이미지 참조를 검사한다**

Run: `../phase-30-reconciled/node_modules/.bin/prettier --check README.md docs/README.md docs/architecture/README.md docs/architecture/desktop-clean-sheet.md docs/product/constitution.md apps/desktop/README.md docs/superpowers/specs/2026-07-30-public-repository-documentation-design.md docs/superpowers/plans/2026-07-30-public-repository-documentation.md`
Run: `git diff --check`
Expected: 모두 exit 0

- [ ] **Step 3: 문서 커밋을 만든다**

Run: `git add README.md docs/README.md docs/architecture docs/product/constitution.md apps/desktop/README.md docs/assets/readme docs/superpowers/specs/2026-07-30-public-repository-documentation-design.md docs/superpowers/plans/2026-07-30-public-repository-documentation.md`
Run: `git commit -m "docs(readme): 사전 릴리스 제품 경계를 명확히 정리"`
Expected: 문서와 이미지 자산만 포함된 커밋

- [ ] **Step 4: main을 fast-forward하고 원격에 올린다**

Run: `git -C <main-worktree> merge --ff-only codex/public-docs-snapshot-20260730`
Run: `git -C <main-worktree> push origin main`
Expected: `main`이 문서 커밋을 가리키고 원격 push 성공

### Task 6: MIT 라이선스를 명시한다

**Files:**
- Create: `LICENSE`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `README.ko.md`

- [ ] **Step 1: 표준 MIT 라이선스 전문을 저장소 루트에 추가한다**

저작권 표기는 개인 정보를 추정하지 않고 `Massion contributors`로 둡니다.

- [ ] **Step 2: 패키지 메타데이터와 README를 연결한다**

루트 `package.json`에 `MIT`를 선언하고 README는 권리 설명을 반복하지 않은 채 `LICENSE`만 연결합니다.
