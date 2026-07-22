---
version: "1.0"
name: "Massion Desktop"
description: "조직형 AgentOS를 위한 로컬 우선 데스크톱 운영 표면"
colors:
  canvas: "#11181f"
  chrome: "#10171d"
  surface: "#151c22"
  raised: "#1b2227"
  border: "#2b353b"
  foreground: "#ecedeb"
  primary: "#eaa820"
  secondary: "#a7adb0"
  muted: "#7f898e"
  accent: "#eaa820"
  accent-ink: "#171b1d"
  success: "#87b977"
  danger: "#d9776f"
typography:
  page-title:
    fontFamily: "Pretendard Variable, Pretendard, ui-sans-serif, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: "600"
    lineHeight: "28px"
    letterSpacing: "-0.025em"
  row-title:
    fontFamily: "Pretendard Variable, Pretendard, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: "500"
    lineHeight: "20px"
  body:
    fontFamily: "Pretendard Variable, Pretendard, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: "400"
    lineHeight: "20px"
  metadata:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, monospace"
    fontSize: "12px"
    fontWeight: "400"
    lineHeight: "18px"
  section-label:
    fontFamily: "Pretendard Variable, Pretendard, ui-sans-serif, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: "500"
    lineHeight: "16px"
    letterSpacing: "0.04em"
rounded:
  row: "4px"
  control: "6px"
  surface: "8px"
spacing:
  1: "4px"
  2: "8px"
  3: "12px"
  4: "16px"
  5: "24px"
  6: "32px"
components:
  app-shell:
    backgroundColor: "{colors.canvas}"
  sidebar:
    backgroundColor: "{colors.chrome}"
  sidebar-active-item:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.row}"
  focus-ring:
    backgroundColor: "{colors.accent}"
  divider:
    backgroundColor: "{colors.border}"
  list-row-selected:
    backgroundColor: "{colors.raised}"
    rounded: "{rounded.row}"
  list-row-metadata:
    textColor: "{colors.muted}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  input:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.control}"
  dialog:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.surface}"
  status-success:
    textColor: "{colors.success}"
  status-danger:
    textColor: "{colors.danger}"
---

## Overview

Massion Desktop은 AI 채팅 화면이나 일반 SaaS 대시보드가 아니라, 사용자가 조직·Work·결정·성장을 운영하는 로컬 우선 AgentOS입니다. 화면은 “AI가 무엇을 생각하는가”보다 “조직이 무엇을 책임지고, 지금 무엇이 진행되며, 사람이 어디에서 통제하는가”를 먼저 보여야 합니다.

시각 언어는 Linear의 고밀도 목록과 분할 상세 보기, Vercel Geist의 절제된 타이포그래피·명확한 상태를 참고합니다. 그러나 VS Code의 아이콘 밀도나 AI 제품의 그라데이션·대시보드 카드를 복제하지 않습니다. 기본 밀도는 매일 사용하는 데스크톱 운영 도구 수준이며, 카드가 아니라 목록 행·구분선·여백으로 구조를 구분합니다.

## Colors

`canvas`는 작업 본문, `chrome`은 항상 남아 있는 탐색 영역, `surface`는 목록·표·세부 정보, `raised`는 선택 행·popover·dialog에만 사용합니다. 일반 콘텐츠에 그림자를 두지 않습니다. `accent`는 현재 선택, 키보드 focus, 한 화면의 가장 중요한 행동 하나에만 사용합니다. 성공·위험 색은 상태 텍스트와 아이콘을 보조하며 색만으로 상태를 구분하지 않습니다.

## Typography

인터페이스 본문과 한국어 문구는 Pretendard를 사용합니다. Geist Mono는 버전, 식별자, 명령, 시각, 수치처럼 정렬과 정확한 판독이 중요한 값에만 사용합니다. 한 화면에는 페이지 제목 하나만 `page-title`을 쓰며, 큰 마케팅식 제목을 만들지 않습니다. 섹션 라벨은 작고 조용해야 하며, 실제 의미는 행 제목과 상태가 담당합니다.

## Layout

넓은 데스크톱의 기본 셸은 접히는 전역 사이드바, 현재 표면의 목록/필터 영역, 본문, 필요할 때만 열리는 상세 inspector로 구성합니다. 사이드바는 넓은 상태에서 제품명·그룹·항목명을 보이고, 축소 상태에서는 아이콘과 tooltip만 보입니다. 헤더는 제품·조직 맥락과 빠른 이동을, 푸터는 로컬 연결 상태·설정 진입을 소유합니다.

각 표면은 동일한 페이지 헤더 높이, 검색·필터 위치, 목록 행 높이, 분할선과 빈 상태 규칙을 공유합니다. 임의의 새 패널이나 3열 카드 그리드는 만들지 않습니다. 리스트 선택은 inspector를 열 수 있지만, 목록의 문맥과 스크롤 위치를 잃지 않아야 합니다.

## Elevation & Depth

깊이는 네 단계뿐입니다: canvas, chrome, surface, raised. Popover와 dialog만 약한 그림자와 1px 경계를 가질 수 있습니다. 선택된 행은 `raised`와 왼쪽 2px accent indicator로 충분하며, glowing border·glass effect·gradient는 사용하지 않습니다.

## Shapes

행 4px, 입력·버튼 6px, dialog·popover 8px를 넘지 않습니다. 부모와 자식의 radius는 동심으로 맞춥니다. pill은 상태 badge처럼 짧은 상태 토큰에만 사용하며, 필터·본문·컨테이너를 pill로 만들지 않습니다.

## Components

shadcn의 Base UI 기반 소스 구성요소를 기본 재료로 사용합니다. 새 UI 라이브러리를 추가하지 않습니다. Sidebar, ScrollArea, Tabs, Command, DropdownMenu, Dialog, AlertDialog, Input, Button, Badge와 Resizable을 현재 코드베이스의 소스 구성요소로 조합합니다. 구현 시 토큰은 이 문서와 `src/styles.css`의 같은 CSS 변수에서만 읽습니다.

### App shell

사이드바는 헤더·스크롤되는 메뉴 그룹·푸터를 가진 하나의 컴포넌트입니다. `[` 단축키와 rail control로 열고 닫을 수 있어야 하며, 축소해도 현재 표면과 미결정 수는 식별할 수 있어야 합니다. 전역 `Cmd+K`는 빠른 표면 이동과 Work/확장 검색의 진입점으로만 쓰고, 별도 AI 명령창으로 확장하지 않습니다.

### Extensions

표면 이름은 언제나 **확장**입니다. 첫 진입에서 설치된 확장과 마켓플레이스 inventory를 함께 보여줍니다. 상단에는 하나의 검색 입력, `모두 · 설치됨 · 찾아보기` 필터, 정렬만 둡니다. 본문은 `설치됨` 목록을 먼저, 구분선 뒤에 `마켓플레이스` 목록을 같은 행 규격으로 표시합니다. 선택 항목의 출처·버전·권한 이유·상태는 inspector에서 확인합니다.

승인이 필요한 설치는 설치 행과 결정 표면에 `승인 대기` 상태만 보입니다. 사람이 결정을 저장하면 클라이언트가 동일한 idempotency identity로 설치 재개 명령을 자동 제출하고, 상태는 이벤트/조회 결과로 갱신합니다. 사용자가 “승인 반영 후 설치 재개”를 다시 누르는 행동은 존재하지 않습니다. 설치됨과 marketplace는 사용자 흐름상 분리된 제품 페이지가 아닙니다.

### Settings

설정은 Provider·계정 연결·모델 경로·실행 정책·로컬 데이터의 운영 투영입니다. 로컬 설치에 사용자 프로필 생성이나 로그인 흐름을 추가하지 않습니다. Provider credential 입력, 연결 상태, model route 우선순위는 table과 side detail로 다루며, form label은 항상 input 위에 둡니다.

## Do's and Don'ts

**해야 할 것**

- 빈 상태, sparse 상태, loading skeleton, 오류와 권한 대기를 각각 설계합니다.
- 키보드 focus, 24px 이상의 hit target, tooltip과 명시적 accessible label을 제공합니다.
- 동일 객체에는 목록·상세·결정에서 같은 이름·상태 라벨·색 의미를 사용합니다.
- 실제 도메인 이벤트와 조회 결과로 설치·승인·실행 상태를 갱신합니다.

**하지 말 것**

- 채팅 bubble, 사고 과정 타임라인, 보라/파랑 네온, 그라데이션 CTA, 장식용 AI 아이콘을 사용하지 않습니다.
- 모든 섹션을 큰 rounded card로 감싸지 않습니다.
- 승인 뒤 사람이 같은 요청을 재개하도록 요구하지 않습니다.
- 제품 철학과 무관한 가짜 metrics·추천 carousel·마케팅 copy를 넣지 않습니다.
- 새 UI 라이브러리로 Base UI/shadcn 토큰과 상호작용 규칙을 이원화하지 않습니다.
