import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  marketplacePayload: undefined as unknown,
  refresh: vi.fn(),
}));

vi.mock("../services.js", () => ({
  consoleStore: {
    refresh: testState.refresh,
  },
}));

vi.mock("../hooks.js", () => ({
  useQueryData: (_store: unknown, operation: string, payload?: unknown) => {
    if (operation === "registry.search") {
      testState.marketplacePayload = payload;
      const query = (payload as { query: string }).query;
      return {
        items: query
          ? [
              {
                versionId: "version-search-result",
                packageName: "검색 결과 확장",
                packageVersion: "1.0.0",
                provenance: "verified",
                visibility: "public",
              },
            ]
          : [],
      };
    }
    return [];
  },
}));

import ExtensionsPage from "./ExtensionsPage.js";

beforeEach(() => {
  testState.marketplacePayload = undefined;
  testState.refresh.mockReset().mockResolvedValue({ items: [] });
});

afterEach(() => cleanup());

describe("ExtensionsPage", () => {
  it("검색을 완료하면 제출한 payload identity의 결과를 표시한다", async () => {
    const user = userEvent.setup();
    render(<ExtensionsPage />);

    await user.type(screen.getByRole("textbox", { name: "Marketplace 검색" }), "agent");
    await user.click(screen.getByRole("button", { name: "검색" }));

    await waitFor(() =>
      expect(testState.refresh).toHaveBeenCalledWith("registry.search", { query: "agent", limit: 20 }),
    );
    await waitFor(() => expect(testState.marketplacePayload).toEqual({ query: "agent", limit: 20 }));
    expect(screen.getByText("검색 결과 확장")).toBeInTheDocument();
  });
});
