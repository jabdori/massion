---
version: "4.0"
name: "Massion — 협업방"
description: "에이전트 조직이 서로 묻고 반론하고 인계하는 장면을 사람이 읽고 개입하는 로컬 AgentOS"
colors:
  bg-0: "#0E0E10"
  bg-1: "#141416"
  bg-2: "#1A1A1D"
  bg-3: "#232327"
  line: "#26262A"
  line-strong: "#35353B"
  fg: "#EDEDEF"
  fg-2: "#A0A0A8"
  fg-3: "#6E6E76"
  agent-representative: "#E4E4E8"
  agent-strategy: "#7C9EFF"
  agent-research: "#4FC3A1"
  agent-delivery: "#C99BFF"
  agent-assurance: "#F58FB0"
  agent-temporary: "#9BA8C4"
  gate: "#F5C451"
  gate-wash: "#231D0E"
  gate-border: "#4A3C15"
  halt: "#FF6B6B"
  user: "#3A3A40"
typography:
  screen-title:
    fontFamily: "Pretendard Variable, Pretendard, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: "600"
    lineHeight: "24px"
    letterSpacing: "-0.02em"
  detail-title:
    fontFamily: "Pretendard Variable, Pretendard, ui-sans-serif, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: "600"
    lineHeight: "24px"
    letterSpacing: "-0.02em"
  speaker:
    fontFamily: "Pretendard Variable, Pretendard, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: "500"
    lineHeight: "18px"
    letterSpacing: "normal"
  body:
    fontFamily: "Pretendard Variable, Pretendard, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: "400"
    lineHeight: "20px"
    letterSpacing: "normal"
  label:
    fontFamily: "Pretendard Variable, Pretendard, ui-sans-serif, system-ui, sans-serif"
    fontSize: "10px"
    fontWeight: "600"
    lineHeight: "14px"
    letterSpacing: "0.08em"
  message-type:
    fontFamily: "Pretendard Variable, Pretendard, ui-sans-serif, system-ui, sans-serif"
    fontSize: "10px"
    fontWeight: "600"
    lineHeight: "14px"
    letterSpacing: "0.06em"
  figure:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, monospace"
    fontSize: "11px"
    fontWeight: "400"
    lineHeight: "16px"
    letterSpacing: "normal"
rounded:
  tag: "3px"
  control: "5px"
  panel: "7px"
  avatar: "5px"
spacing:
  nav-row: "27px"
  message: "13px"
  gutter: "9px"
  pad: "13px"
  section: "16px"
components:
  message:
    backgroundColor: "transparent"
    textColor: "{colors.fg-2}"
    rounded: "{rounded.panel}"
    padding: "0"
  message-avatar:
    backgroundColor: "{colors.agent-research}"
    textColor: "{colors.bg-0}"
    rounded: "{rounded.avatar}"
    size: "18px"
  message-type-tag:
    backgroundColor: "transparent"
    textColor: "{colors.fg-3}"
    rounded: "{rounded.tag}"
    padding: "0 5px"
  proposal-block:
    backgroundColor: "{colors.gate-wash}"
    textColor: "{colors.fg}"
    rounded: "{rounded.panel}"
    padding: "11px 13px"
  org-node:
    backgroundColor: "{colors.bg-1}"
    textColor: "{colors.fg}"
    rounded: "6px"
    padding: "6px 9px"
  org-node-proposed:
    backgroundColor: "transparent"
    textColor: "{colors.agent-temporary}"
    rounded: "6px"
    padding: "6px 9px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.fg-2}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "{spacing.nav-row}"
  button-primary:
    backgroundColor: "{colors.fg}"
    textColor: "{colors.bg-0}"
    rounded: "{rounded.control}"
    padding: "4px 12px"
  button-gate:
    backgroundColor: "{colors.gate}"
    textColor: "#241D07"
    rounded: "{rounded.control}"
    padding: "4px 12px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.fg-2}"
    rounded: "{rounded.control}"
    padding: "4px 12px"
---

# Massion 데스크톱 — 협업방

## Overview

이 제품이 소유한 장면은 **에이전트들이 서로 묻고, 반론하고, 인계하는 것을 사람이 읽고 그 자리에서 개입하는 것**이다. 실행하는 AI는 흔하다. 서로 반론하는 조직은 흔하지 않고, 그것이 "AI 하나가 아니라 조직"이라는 주장의 유일한 시각적 증거다.

그래서 화면의 중심은 **협업방(Collaboration Room)**이다. 도메인이 이미 이 화면을 위해 설계돼 있다 — 메시지 타입 10종, `coordinator`/`participant`/`observer`, `reply_to`/`caused_by` 인과 계보, 방 단위 라운드·토큰·비용 예산. 이걸 쓰지 않으면 도메인에서 가장 비싼 부분이 화면에 한 픽셀도 나오지 않는다.

**동적 조직도 방 안에서 일어난다.** "현재 조직으로 처리 불가 → 새 팀 제안 → 영향·승인 → 적용"은 도메인에서 `proposal` 메시지 → `ImpactReport` → `decision` 메시지 → `OrganizationVersion`이다. 전부 대화다.

**6단계는 화면의 골격이 아니라 챕터 구분선이다.** `intake · context-strategy · evidence · delivery · assurance · records`는 실재하고 `blocked`가 여기 붙지만, 방은 `delivery` 하나 안에서 여러 라운드를 돈다. 단계는 어디쯤인지 알려주는 표시이지 대화를 담는 그릇이 아니다.

크래프트 기준선은 **Linear · Claude Code Desktop · Vercel**이다. 이 화면이 그 셋 옆에 놓였을 때 밀도·정렬·타이포 위계에서 밀리면 안 된다.

방문자 모드는 **Operate**.

거부하는 것: 아날로그 은유, 스큐어모피즘, 마스코트, 사람 얼굴 아바타, 네온 글로우, 그라디언트, 시간축 격자를 메인 뷰로 올리는 것.

## Colors

**UI는 무채이고 색은 에이전트에게만 준다.** 에이전트 OS이므로 색이 나르는 정보는 "지금 누가 말하고 있나"다. 색을 장식에 쓰는 순간 화자 식별이 죽는다.

**색은 역할이 아니라 정체성(handle)에 붙는다.** 역할에 붙이면 같은 역할이 병렬로 셋 돌 때 색이 전부 같아져서 구분이 불가능해진다. 슬롯 배정은 `@massion/application`의 `agentIdentityToken`이 소유하며, Core Office 8개는 슬롯이 고정되고 동적 노드는 handle 해시로 배정된다. 결정론적이므로 재시작이나 표면 전환 후에도 같은 색이다.

| 토큰                | 고정 배정                                          |
| ------------------- | -------------------------------------------------- |
| `agent-0` 실버      | `representative` — Atlas                           |
| `agent-1` 블루      | `context-strategy` — Lyra                          |
| `agent-2` 틸        | `evidence-research` — Quill                        |
| `agent-3` 퍼플      | `governance` — Onyx                                |
| `agent-4` 시안      | `delivery-coordination` — Vega                     |
| `agent-5` 핑크      | `assurance` — Iris                                 |
| `agent-6` 마젠타    | `records-documentation` — Cedar                    |
| `agent-7` 스틸      | `growth` — Sage                                    |
| `agent-provisional` | 색이 아니라 **점선 전용**. `scope:"work"`와 미승인 |
| `user`              | 사람 참가자. 무채                                  |

**화자 팔레트에 노랑·초록 계열을 넣지 않는다.** 노랑은 gate 예약어와 충돌하고 초록은 성공 표시로 오독된다. `styles.test.ts`가 hex의 R·G·B 관계로 이를 검사한다.

에이전트 색이 쓰이는 곳은 **아바타 · 화자 이름 · 좌측 세로 레일 · 진행률 막대** 넷뿐이다. 버튼·테두리·배경에는 쓰지 않는다.

**이름이 정체성이고 역할은 배지다.** 화자는 언제나 `이름 + 역할 배지`로 표시한다. 이름은 영어 고유명사이므로 어떤 로케일에서도 번역하지 않는다. 호출부호 24개는 첫 글자가 서로 겹치지 않으므로 아바타 한 글자가 동시 24명까지 유일하다.

색 하나만 예약어다. **`gate`(노랑) = 사람이 필요함.** 승인 요청, 조직 변경 제안, 신뢰 확인 외에 어디에도 쓰지 않는다. 화면에 노랑이 보이면 그것은 언제나 "네가 해야 할 일이 있다"는 뜻이다.

`halt`(코랄)은 차단과 실패에만 쓴다. 초록은 없다 — 완료는 색이 아니라 `fg-3`으로 가라앉히고 타입 태그로 말한다.

깊이는 `bg-0`~`bg-3` 네 단계와 1px `line`으로만 만든다. 그림자는 없다.

## Typography

`Pretendard Variable` + 시스템 스택 한 벌. 한글과 라틴을 같은 얼굴로 처리한다.

**모든 수치·시각·토큰·비용·개정은 `font-variant-numeric: tabular-nums`.** 라운드 `4 / 12`, 토큰 `48.2k`, 진행 `2,116 / 3,412`가 흔들리면 스캔이 불가능해진다.

`Geist Mono`는 checksum·경로·핸들·버전 식별자에만 쓴다.

화면 제목은 16px을 넘지 않는다. 위계는 크기가 아니라 **무게와 색**으로 만든다. 화자 이름 12px/500 + 에이전트 색, 본문 13px/400 `fg-2`, 메타 11px mono `fg-3`.

## Layout

4열 셸: **표면 레일(150) · 업무 목록(242) · 방(가변) · 컨텍스트(300).**

각 열이 다른 질문에 답한다. 레일은 어디에 있나, 목록은 무엇을 보고 있나, 방은 조직이 무슨 말을 하고 있나, 컨텍스트는 누가 참가했고 한도는 얼마나 남았나.

최소 창 1180×720. 이 폭에서 레일은 아이콘 모드로 접히고 컨텍스트는 닫을 수 있다. 각 열은 독립 스크롤한다.

밀도가 우선이다. 네비 행 27px, 메시지 간격 13px. 여백으로 고급스러움을 만들지 않는다.

### 열 규칙 — 모든 표면이 같은 골격을 쓴다

3열을 쓰는 표면은 치수를 공유한다. 표면마다 다르면 표면을 옮길 때마다 눈이 다시 자리를 찾아야 한다.

| 요소          | 값                                                                |
| ------------- | ----------------------------------------------------------------- |
| 목록 열       | 242px (1440px 이상 264px)                                         |
| 컨텍스트 열   | 300px (1440px 이상 332px)                                         |
| **헤더 밴드** | **46px, 세 열 모두 동일.** 가로선이 화면을 가로질러 이어져야 한다 |
| 목록 패딩     | `p-2`, 행 `px-2.5 py-2`                                           |
| 본문 패딩     | `px-5 py-4`                                                       |
| 컨텍스트 패딩 | `p-3`                                                             |

**제목은 헤더 밴드에 있고 스크롤되지 않는다.** 본문을 내려도 지금 무엇을 보고 있는지가 남아야 한다.

### 목록 열의 문법

모든 표면의 목록 열은 같은 세 구역을 같은 순서로 쓴다: **헤더(46px) · 필터 · 행**.

행은 두 줄이다.

```
제목                        ← 13px/500, truncate
● 상태            시각      ← 11px, 상태는 좌·색 있음, 시각은 우·mono
```

분류값(팀, 대상 종류 같은 것)은 행에 넣지 않는다. 그건 상세 헤더의 배지 자리다. 행은 **무엇을·언제·어떤 상태**만 말한다.

**목록 컨테이너에 `grid`를 쓰지 않는다.** grid 아이템은 `min-width: auto`가 기본이라 긴 제목이 열 폭을 밀어내고, 우측 정렬된 상태·시각이 조용히 잘린다. DOM에는 남아 있으므로 코드로는 보이지 않는다.

**행은 전폭이고, 사이는 여백이 아니라 1px 선으로 가른다.** `divide-y`를 쓰고 행 자체에는 `rounded`를 주지 않는다. 여백으로만 가르면 두 줄짜리 행이 붙어 보여서 어디가 한 행인지 세어야 한다. 둥근 행에 여백을 주면 카드가 나열된 것처럼 보이고, 그건 이미 «읽는 흐름 안의 카드»에서 다른 뜻을 가진 모양이다.

### 화면은 코드가 아니라 화면으로 검증한다

코드는 *무엇을 그리라고 했는지*를 보여주고 화면은 *무엇이 그려졌는지*를 보여준다. 둘은 다를 수 있다.

목록·표·열을 만든 뒤에는 실제로 띄워서 보고, 잘림이 의심되면 `getBoundingClientRect().width`를 컨테이너 폭과 비교한다.

**본문 폭은 내용 성격을 따른다.** 메시지 스트림은 860px, 산문 문서는 76ch. 이건 일관성보다 가독성이 이기는 지점이다.

**중앙 열의 성격은 표면마다 다를 수 있다.** `업무`는 아래로 자라는 스트림이고 `개선`은 위에서 아래로 한 번 읽는 문서다. 골격이 같다고 읽는 방식까지 같아야 하는 것은 아니며, 반대로 읽는 방식이 다르다고 골격을 버릴 이유도 없다.

### 조직의 구조와 지도

조직 표면은 구조와 지도를 **55:45**로 나눕니다. A가 읽기의 중심임을 유지하되 지도도 조직 전체를 판독할 폭을 가집니다. 우측 안에서는 지도와 선택 상세가 남은 높이를 반씩 씁니다. 구조의 상하 단위는 기본으로 펼치고 각 헤더의 disclosure 버튼으로 접습니다. 구조를 접어도 지도는 전체 조직을 유지합니다.

구조에서 노드를 고르면 지도는 현재 확대율을 유지하며 같은 노드를 중앙에 놓습니다. 지도에서 고르면 접힌 상위 단위를 먼저 펼친 뒤 구조의 해당 행으로 이동하고, 선택 상세도 같은 노드를 보여줍니다.

`NodeRole`의 `coordinator`는 조율 책임이지 부서 종류가 아닙니다. 조직 단위 종류 계약이 생기기 전에는 화면에서 `부서`·`팀`을 추측하지 않고 `총괄`·`조율`·`실행` 역할만 말합니다.

## Elevation & Depth

그림자 없음. `bg-0` → `bg-3` 네 단계와 1px `line`이 깊이의 전부다.

모달만 예외로 바탕을 `rgba(0,0,0,.6)`으로 덮되 자체 그림자는 갖지 않고 `line-strong` 테두리로 분리한다.

## Shapes

태그 3px · 컨트롤 5px · 패널 7px · 아바타 5px. **그 이상 쓰지 않는다.**

**점선 테두리는 예약어다: `scope:"work"` 또는 아직 승인되지 않은 것.** 임시 팀 노드, 제안된 참가자, 미승인 변경이 전부 점선이고 승인되면 실선이 된다. 이 하나로 "조직에 실재하는 것"과 "제안 중인 것"이 구분된다.

## Components

### 메시지 — 타입이 곧 시각 문법

메시지 타입 10종은 색이 아니라 **배치와 표기**로 구분한다. 타입 태그는 10px 대문자, 기본 `fg-3` 테두리.

| 타입             | 표기                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `question`       | 수신자를 `→ 조사`로 표시                                                                    |
| `answer`         | 질문 아래 27px 들여쓰기, 짝이 눈에 보임                                                     |
| `challenge`      | **원본을 인용해 위에 붙이고** 화자 색 태그. 반론은 무엇에 대한 반론인지 없이 존재할 수 없다 |
| `change_request` | 대상 산출물·작업을 명시한 태그                                                              |
| `review_request` | 수신자 표시 + 대기 상태                                                                     |
| `proposal`       | 아래 제안 블록을 동반                                                                       |
| `decision`       | 확정 표기 + 서명자 + 개정 번호                                                              |
| `evidence`       | 첨부 줄, checksum 축약 표시                                                                 |
| `handoff`        | **가로 전환선.** 좌우 그라디언트가 넘긴 쪽 색 → 받는 쪽 색                                  |
| `status`         | 중앙 정렬 한 줄, `fg-3`. 발언이 아니므로 아바타를 주지 않는다                               |

### 제안 블록 — 조직 변경

`proposal` 메시지에 붙는다. 네 가지를 **버튼보다 먼저** 보인다: 추가되는 역량 / 이 업무가 끝나면 어떻게 되는가 / 영향(노드 수·참조 수·대상 핸들) / 되돌리기(버전 n→n+1, Revert 가능 여부).

`ComplianceFinding` 결과를 한 줄로 요약한다 — `조직 검사 통과 · 부모 없는 노드 없음 · 순환 없음 · 코어 오피스 8팀 보존`. 위반이 있으면 `suggestedCommand`를 그대로 보인다.

부모·영향 노드는 handle이 아니라 **이름**으로 말한다(`Vega 아래 · 실행 역할 · 이 업무에서만`). 아래 «식별자는 사람의 말 뒤에 선다»를 따른다.

### 챕터 구분선

6단계 전환 지점에만 놓는다. 10px 대문자 라벨 + 1px 선 + 시각 범위. 대화를 접거나 담지 않는다.

### 컨텍스트 열

참가자(역할·발언 수·상태), 방 한도(라운드·토큰·비용, 각각 얇은 막대), 공유 컨텍스트(`SharedContextReference`를 checksum 축약과 함께). 승인 대기 중인 항목은 `gate` 색으로.

### 업무 목록 행

제목 + **참가 에이전트 색 점 줄** + 지금 필요한 것 한 줄. 색 점만 봐도 어느 업무에 누가 붙어 있는지 읽힌다. 제안 중인 임시 팀은 점선 사각으로 그 줄에 나타난다.

### 목록을 자를 때

**잘린 사실을 감추지 않습니다.** `slice(0, n)`은 화면에서 가장 조용한 거짓말입니다. 타입도 테스트도 안 잡고 화면도 안 깨지고, 사실만 사라집니다.

- 아바타 줄은 `SpeakerRow`를 씁니다. 상한을 넘으면 `+N` 사각형이 서고 hover하면 나머지 이름이 나옵니다.
- 항목 목록은 보이는 수가 아니라 **전체 수**를 말합니다. `작업 3 / 5`처럼 분수로 씁니다.
- 축약한 식별자(checksum, ID)는 축약임이 보이게 씁니다.

자를 자리와 상한: 탭 2 · 인라인 방 참조 3 · 업무 행 4 · Work 헤더 5. 그 이상은 `+N`.

### 읽는 흐름 안의 카드

**대화나 목록을 읽는 도중에 놓이는 카드는 통째로 버튼이 되지 않습니다.** 오클릭 한 번에 읽던 맥락이 사라지고, 사용자는 읽는 내내 "지금 누르면 어디로 가지"를 신경 써야 합니다. 밀도가 높을수록 이 비용이 큽니다.

- 진입은 `열기 ›` 같은 **명시적 컨트롤**로만 합니다.
- 카드 안의 행동(승인·거절)은 카드 안 버튼으로 그 자리에서 처리합니다. 다른 화면으로 보내지 않습니다.
- **예외: 목록 행.** 업무 목록처럼 행 선택이 목적인 곳은 행 전체가 클릭 대상입니다. 잘못 눌러도 옆 항목을 보게 될 뿐 맥락이 날아가지 않습니다.

### 식별자는 사람의 말 뒤에 선다

화면에 나오는 문자열은 **세 종류**이고, 셋을 같은 방식으로 다루면 둘 중 하나가 망가집니다. 전부 지우면 감사 추적이 끊기고, 전부 그대로 두면 사람이 시스템의 내부를 읽어야 합니다.

| 종류              | 예                                                        | 규칙                                                                                                                                  |
| ----------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **조직 핸들**     | `evidence-research`, `delivery-coordination`              | `agentIdentityToken(handle)`으로 **이름으로 완전히 대체**한다. 원문은 `title`로 내린다                                                |
| **도메인 열거값** | `operator`, `work`, `orphan`, `cycle`                     | 한글 문구 표로 **완전히 대체**한다. 표는 화면 코드가 소유하고, `Record<도메인타입, string>`이라 값이 늘면 타입이 깨져 번역을 강제한다 |
| **감사 식별자**   | `evaluation-0031`, `approval-crm-access`, `work:churn-q3` | **지우지 않는다.** 사람이 읽는 말을 앞에 세우고 식별자를 mono·`fg-3`로 뒤에 붙인다. `title`에 무엇의 식별자인지 쓴다                  |

값 자체는 도메인 것을 그대로 들고 있습니다. 뷰 타입에 한글 문구를 굳히면 정렬·필터·비교가 문구에 묶입니다.

### 같은 것은 같게 보입니다

승인 게이트는 협업방·수신함·대표·홈 어디서 보든 같은 문법입니다: `◇` 기호, `gate-wash` 배경, 무엇이·왜·되돌리기를 버튼보다 먼저. 같은 모양이 화면마다 다르게 동작하면 사용자가 같은 것을 두 번 배워야 합니다. 수신함을 닫는 것은 읽음 처리나 해결이 아니며, 도메인 결정 전까지 항목과 전역 배지가 유지됩니다.

**수신함 항목은 해결 방식으로 종류를 가릅니다.** 승인 대기 = `◇` + `gate`(노랑, "사람 결정 필요") + 소유 화면 이동. 차단 = `⊘` + `halt`(빨강, "실행 막힘") + 업무 이동. 개선 검토 = `Star` + `gate` + 개선 상세 이동입니다. 수신함은 결정 버튼을 반복하지 않는 탐색 표면이며, 업무·확장처럼 근거를 소유한 화면에서 승인·거절합니다. 아직 소유 화면이 연결되지 않은 조직 전역 승인은 처리 불능을 막기 위해서만 수신함 결정을 임시 유지합니다. 연결 화면이 있는 항목은 상단 행을 `제목 — 상태 — 꺾쇠` 순서로 배치하고 맨 오른쪽 꺾쇠로 이동을 알립니다. 감사 식별자는 본문에 슬러그로 찍지 않고 `title` 툴팁으로만 둡니다.

**우측 시트는 가장자리에 딱 붙입니다.** 그림자로 띄우지 않고 왼쪽 1px 선으로 가릅니다(그림자 없음 원칙). `cn`은 tailwind-merge가 아니므로 시트/모달 base 클래스를 `sheet` 플래그로 분기해야 padding·rounded·shadow가 충돌하지 않습니다.

**소유 화면의 결정 버튼은 `DecisionActions` 하나뿐이고 문구는 `승인` / `거절` 고정입니다.** 거절은 왼쪽·중성 테두리, 승인만 `gate` 면. 버튼에 결과를 덧붙이지 않습니다(`승인하고 편성` ✗) — 무슨 일이 일어나는지는 카드 본문이 이미 말했습니다.

**다른 곳으로 보내는 일반 버튼은 `OpenButton` 하나뿐입니다.** 단, 수신함은 업무 제목·출처를 다시 `열기`라고 반복하지 않고 상단 행 전체를 클릭 영역으로 삼아 맨 오른쪽 꺾쇠로 이동을 알립니다. 카드 전체를 버튼으로 만들지는 않습니다.

### 빈 상태

일러스트와 마스코트 없음. 무엇을 할 수 있는지 한 줄과 실행 가능한 항목 하나.

### 로딩

스피너 없음. 골격을 `bg-2` 블록으로 두고 실제 높이를 유지한다.

## Do's and Don'ts

**한다**

- 반론은 반드시 원본을 인용해서 붙인다.
- 질문과 답변은 들여쓰기로 짝을 보인다.
- 인계는 화자 전환선으로 그린다. 조직이 일을 넘겼다는 사실은 한 줄 텍스트보다 크게 보여야 한다.
- 조직 변경은 영향과 되돌리기를 버튼보다 먼저 보인다.
- 점선은 `scope:"work"`와 미승인에만 쓴다.
- 노랑은 사람이 필요한 곳에만 쓴다.
- 라운드·토큰·비용 한도를 항상 보인다. 방에는 예산이 있고 사용자가 그걸 알아야 한다.
- 차단의 원인을 구별한다. `model-unavailable`과 `workspace-untrusted`는 사용자가 할 일이 다르다.

**하지 않는다**

- 사용자에게 내부 식별자를 입력시키지 않는다.
- 에이전트를 사람 얼굴 아바타로 그리지 않는다. 이들은 역할이지 인물이 아니다.
- 에이전트 대화를 사이드바로 밀어내지 않는다. 그것이 이 제품이다.
- 6단계를 화면 골격으로 올리지 않는다. 챕터 표시로 충분하다.
- 시간축 병렬 격자를 메인 뷰로 만들지 않는다. 필요하면 옵션 뷰로 둔다.
- 성공을 초록으로 칠하지 않는다.
- 그림자·그라디언트·글로우로 깊이를 만들지 않는다.
- 완료를 검증 없이 표시하지 않는다.
