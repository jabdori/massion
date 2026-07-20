import { describe, expect, it } from "vitest";

import { filterPaletteItems, SURFACE_PALETTE_ITEMS } from "./palette.js";

describe("Surface 명령 팔레트 계약", () => {
  it("모든 항목은 고유 ID·제목·분류를 갖는다", () => {
    const ids = SURFACE_PALETTE_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of SURFACE_PALETTE_ITEMS) {
      expect(item.title.length).toBeGreaterThan(0);
      expect(["이동", "명령", "설정"]).toContain(item.category);
      expect(item.surfaces.length).toBeGreaterThan(0);
    }
  });

  it("빈 질의는 전체를 반환하고, 질의 토큰은 제목·키워드에 모두 일치해야 한다", () => {
    expect(filterPaletteItems(SURFACE_PALETTE_ITEMS, "")).toHaveLength(SURFACE_PALETTE_ITEMS.length);

    const works = filterPaletteItems(SURFACE_PALETTE_ITEMS, "작업 화면");
    expect(works.some((item) => item.id === "view.works")).toBe(true);
    expect(works.every((item) => item.category === "이동" || item.id.includes("work"))).toBe(true);

    expect(filterPaletteItems(SURFACE_PALETTE_ITEMS, "존재하지않는기능")).toHaveLength(0);
  });

  it("영문 키워드도 대소문자 없이 일치한다", () => {
    const scoped = filterPaletteItems(SURFACE_PALETTE_ITEMS, "WORKSPACE");
    expect(scoped.some((item) => item.id === "workspace.scope.toggle")).toBe(true);
  });

  it("위험 항목은 risky로 표시된다", () => {
    const cancel = SURFACE_PALETTE_ITEMS.find((item) => item.id === "work.cancel");
    expect(cancel?.risky).toBe(true);
  });
});
