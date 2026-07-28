import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createFixtureDesktopService } from "@/desktop-service";

import { KnowledgeSurface } from "./knowledge";

describe("지식 표면", () => {
  it("근거가 인용된 Work 판정과 실행자 분리를 원장에 표시한다", async () => {
    render(<KnowledgeSurface onOpenWork={vi.fn()} service={createFixtureDesktopService()} />);

    expect(await screen.findByRole("main", { name: "지식" })).toBeInTheDocument();
    expect(screen.getByText("3분기 고객 이탈 원인 분석")).toBeInTheDocument();
    expect(screen.getByText("판정 Iris")).toBeInTheDocument();
    expect(screen.getByText(/최근 90일/)).toBeInTheDocument();
    expect(screen.getByText("data-accuracy")).toBeInTheDocument();
    expect(screen.getByText("src/analytics/cohort.ts")).toBeInTheDocument();
    expect(screen.getAllByText(/실행 기여자 아님/).length).toBeGreaterThan(0);
  });

  it("막힘은 위험 색과 전용 글리프로 표시하고 핸들은 모노 폰트로 구분한다", async () => {
    render(<KnowledgeSurface onOpenWork={vi.fn()} service={createFixtureDesktopService()} />);

    await screen.findByRole("main", { name: "지식" });

    const blockedCriterion = screen.getByText("improvement-feasibility");
    expect(blockedCriterion.parentElement).toHaveClass("text-danger");
    expect(blockedCriterion.parentElement?.querySelector('path[d="M4 7h6"]')).toBeInTheDocument();
    expect(screen.getByText("판정 onyx")).toHaveClass("font-mono", "text-[11px]");
  });

  it("승인 행과 중앙 근거 행은 다음 대상으로 이동하는 문이다", async () => {
    const onOpenWork = vi.fn();
    render(<KnowledgeSurface onOpenWork={onOpenWork} service={createFixtureDesktopService()} />);

    await screen.findByRole("main", { name: "지식" });

    const getLedger = () => screen.getByRole("region", { name: "인용 원장" });
    const approval = within(getLedger()).getByText("CRM 고객 데이터 읽기").closest("button");
    expect(approval).not.toBeNull();
    if (approval === null) return;
    expect(approval).toHaveTextContent("›");
    fireEvent.click(approval);
    expect(onOpenWork).toHaveBeenCalledWith("churn-q3");

    const evidence = within(getLedger()).getByRole("button", { name: /src\/analytics\/cohort\.ts/ });
    fireEvent.click(evidence);
    await waitFor(() =>
      expect(within(getLedger()).getByRole("button", { name: /src\/analytics\/cohort\.ts/ })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    await waitFor(() =>
      expect(
        within(screen.getByRole("complementary", { name: "근거" })).getByRole("button", { name: /^cohort\.ts1$/ }),
      ).toHaveAttribute("aria-pressed", "true"),
    );
    const selectedEvidence = within(getLedger()).getByRole("button", { name: /src\/analytics\/cohort\.ts/ });
    fireEvent.click(selectedEvidence);
    await waitFor(() =>
      expect(within(getLedger()).getByRole("button", { name: /src\/analytics\/cohort\.ts/ })).toHaveAttribute(
        "aria-pressed",
        "false",
      ),
    );
  });
});
