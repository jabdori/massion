// Surface 공통 명령 팔레트 계약 (Phase 30 원칙 13).
// 팔레트 항목은 화면 코드가 아니라 이 계약이 정본이며, TUI(Ctrl+P)·Web(Cmd/Ctrl+K)이 같은 목록을 소비합니다.

export type SurfacePaletteCategory = "이동" | "명령" | "설정";
export type SurfaceKind = "tui" | "web";

export interface SurfacePaletteItem {
  readonly id: string;
  readonly title: string;
  readonly category: SurfacePaletteCategory;
  readonly keywords: readonly string[];
  readonly keyHint?: string;
  readonly risky?: boolean;
  readonly surfaces: readonly SurfaceKind[];
}

export const SURFACE_PALETTE_ITEMS: readonly SurfacePaletteItem[] = [
  // 이동
  {
    id: "view.works",
    title: "작업 화면 열기",
    category: "이동",
    keywords: ["works", "작업", "업무"],
    keyHint: "Tab",
    surfaces: ["tui", "web"],
  },
  {
    id: "view.approvals",
    title: "확인 대기 열기",
    category: "이동",
    keywords: ["approvals", "승인", "확인"],
    keyHint: "Tab",
    surfaces: ["tui", "web"],
  },
  {
    id: "view.chat",
    title: "대화 화면 열기",
    category: "이동",
    keywords: ["chat", "대화", "메시지"],
    keyHint: "Tab",
    surfaces: ["tui", "web"],
  },
  {
    id: "view.overview",
    title: "개요 화면 열기",
    category: "이동",
    keywords: ["overview", "개요", "요약"],
    keyHint: "Tab",
    surfaces: ["tui", "web"],
  },
  {
    id: "view.agents",
    title: "협업 에이전트 열기",
    category: "이동",
    keywords: ["agents", "협업", "에이전트", "조직"],
    keyHint: "Tab",
    surfaces: ["tui", "web"],
  },
  {
    id: "view.operations",
    title: "운영 화면 열기",
    category: "이동",
    keywords: ["operations", "운영", "라우팅"],
    keyHint: "Tab",
    surfaces: ["tui", "web"],
  },
  {
    id: "view.subscriptions",
    title: "구독 화면 열기",
    category: "이동",
    keywords: ["subscriptions", "구독", "모델", "provider"],
    keyHint: "Tab",
    surfaces: ["tui", "web"],
  },
  // 명령
  {
    id: "work.start",
    title: "새 작업 시작",
    category: "명령",
    keywords: ["new", "work", "작업", "요청"],
    keyHint: "n",
    surfaces: ["tui", "web"],
  },
  {
    id: "message.post",
    title: "메시지 보내기",
    category: "명령",
    keywords: ["message", "메시지", "질문"],
    keyHint: "m",
    surfaces: ["tui", "web"],
  },
  {
    id: "refresh",
    title: "새로고침",
    category: "명령",
    keywords: ["refresh", "reload", "새로고침"],
    keyHint: "r",
    surfaces: ["tui", "web"],
  },
  {
    id: "search",
    title: "현재 화면 검색",
    category: "명령",
    keywords: ["search", "찾기", "검색"],
    keyHint: "/",
    surfaces: ["tui"],
  },
  {
    id: "work.cancel",
    title: "업무 취소",
    category: "명령",
    keywords: ["cancel", "취소", "중단"],
    keyHint: "c",
    risky: true,
    surfaces: ["tui", "web"],
  },
  // 설정
  {
    id: "workspace.scope.toggle",
    title: "워크스페이스 스코프 전환",
    category: "설정",
    keywords: ["workspace", "scope", "워크스페이스", "전체"],
    keyHint: "g",
    surfaces: ["tui", "web"],
  },
  {
    id: "inspector.toggle",
    title: "자세히 보기 전환",
    category: "설정",
    keywords: ["inspector", "detail", "자세히", "기술"],
    keyHint: "d",
    surfaces: ["tui"],
  },
  {
    id: "help",
    title: "키보드 도움말",
    category: "설정",
    keywords: ["help", "도움말", "키"],
    keyHint: "?",
    surfaces: ["tui"],
  },
];

export function filterPaletteItems(items: readonly SurfacePaletteItem[], query: string): readonly SurfacePaletteItem[] {
  const tokens = query
    .toLowerCase()
    .split(/\s+/u)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return items;
  return items.filter((item) => {
    const haystack = [item.title, item.id, ...item.keywords].join(" ").toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}
