import { describe, expect, it, vi } from "vitest";

import { createNativeContextPicker } from "./native-context-picker";

describe("native context picker", () => {
  it("폴더 선택의 단일 경로와 취소를 정규화한다", async () => {
    const open = vi.fn().mockResolvedValueOnce("/Users/me/project").mockResolvedValueOnce(null);
    const picker = createNativeContextPicker(open);

    await expect(picker.pickDirectory()).resolves.toBe("/Users/me/project");
    await expect(picker.pickDirectory()).resolves.toBeUndefined();
    expect(open).toHaveBeenNthCalledWith(1, { directory: true, multiple: false });
    expect(open).toHaveBeenNthCalledWith(2, { directory: true, multiple: false });
  });

  it("파일 선택의 단일·복수 경로와 취소를 배열로 정규화한다", async () => {
    const open = vi
      .fn()
      .mockResolvedValueOnce("/Users/me/project/src/index.ts")
      .mockResolvedValueOnce(["/Users/me/project/src/a.ts", "/Users/me/project/src/b.ts"])
      .mockResolvedValueOnce(null);
    const picker = createNativeContextPicker(open);

    await expect(picker.pickFiles()).resolves.toEqual(["/Users/me/project/src/index.ts"]);
    await expect(picker.pickFiles()).resolves.toEqual(["/Users/me/project/src/a.ts", "/Users/me/project/src/b.ts"]);
    await expect(picker.pickFiles()).resolves.toEqual([]);
    expect(open).toHaveBeenNthCalledWith(1, { directory: false, multiple: true });
    expect(open).toHaveBeenNthCalledWith(2, { directory: false, multiple: true });
    expect(open).toHaveBeenNthCalledWith(3, { directory: false, multiple: true });
  });
});
