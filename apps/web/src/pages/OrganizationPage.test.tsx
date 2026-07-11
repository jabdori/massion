import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../services.js", () => ({ consoleStore: {} }));
vi.mock("../hooks.js", () => ({
  useQueryData: () => ({
    schemaVersion: "massion.collaboration.snapshot.v1",
    revision: "a".repeat(64),
    nodes: [
      {
        handle: "representative",
        name: "대표 에이전트",
        responsibility: "사용자 요청을 조직에 연결",
        capabilities: ["routing", "coordination"],
        status: "active",
        role: "representative",
      },
      {
        handle: "documentarian",
        name: "문서화 에이전트",
        responsibility: "결정과 근거를 추적 가능하게 기록",
        capabilities: ["documentation"],
        status: "active",
        role: "specialist",
      },
    ],
  }),
}));

import OrganizationPage from "./OrganizationPage.js";

describe("OrganizationPage", () => {
  it("시각 그래프와 같은 에이전트를 keyboard 접근 가능한 명부로 제공한다", () => {
    render(<OrganizationPage />);
    expect(screen.getByRole("img", { name: /Massion 에이전트 조직 관계/u })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "에이전트 명부" })).toBeInTheDocument();
    expect(screen.getAllByText("대표 에이전트")).toHaveLength(2);
    expect(screen.getAllByRole("listitem")[1]).toHaveAttribute("tabindex", "0");
  });
});
