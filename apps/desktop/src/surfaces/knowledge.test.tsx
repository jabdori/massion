import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createFixtureDesktopService } from "@/desktop-service";

import { KnowledgeSurface } from "./knowledge";

describe("지식 표면", () => {
  it("근거가 인용된 Work 판정과 실행자 분리를 원장에 표시한다", async () => {
    render(<KnowledgeSurface onOpenWork={vi.fn()} service={createFixtureDesktopService()} />);

    expect(await screen.findByRole("main", { name: "지식" })).toBeInTheDocument();
    expect(screen.getByText("3분기 고객 이탈 원인 분석")).toBeInTheDocument();
    expect(screen.getByText("판정 Iris")).toBeInTheDocument();
    expect(screen.getByText("data-accuracy")).toBeInTheDocument();
    expect(screen.getByText("src/analytics/cohort.ts")).toBeInTheDocument();
    expect(screen.getAllByText(/실행 기여자 아님/).length).toBeGreaterThan(0);
  });
});
