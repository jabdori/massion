import { ApplicationRemoteError } from "@massion/application";
import { describe, expect, it, vi } from "vitest";

import { ensurePersonalLoopbackAccess } from "./local-access.js";

describe("개인 local access token", () => {
  it("만료된 loopback file profile만 갱신한 token으로 교체하고 다시 확인한다", async () => {
    const verify = vi
      .fn<(token: string) => Promise<void>>()
      .mockRejectedValueOnce(new ApplicationRemoteError(401, { category: "authentication" }))
      .mockResolvedValueOnce(undefined);
    const refresh = vi.fn<(token: string) => Promise<string>>().mockResolvedValue("mat_refreshed-token");
    const replace = vi.fn<(reference: string, token: string) => Promise<void>>().mockResolvedValue(undefined);

    await expect(
      ensurePersonalLoopbackAccess({
        endpoint: "http://127.0.0.1:7331",
        tokenReference: "file:/tmp/massion.token",
        token: "mat_expired-token",
        verify,
        refresh,
        replace,
      }),
    ).resolves.toBe("mat_refreshed-token");
    expect(verify).toHaveBeenNthCalledWith(1, "mat_expired-token");
    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith("mat_expired-token");
    expect(replace).toHaveBeenCalledWith("file:/tmp/massion.token", "mat_refreshed-token");
    expect(verify).toHaveBeenNthCalledWith(2, "mat_refreshed-token");
  });

  it("원격 또는 file이 아닌 profile은 token 갱신을 시도하지 않는다", async () => {
    const verify = vi.fn<(token: string) => Promise<void>>().mockResolvedValue(undefined);
    const refresh = vi.fn<(token: string) => Promise<string>>().mockResolvedValue("mat_refreshed-token");
    const replace = vi.fn<(reference: string, token: string) => Promise<void>>().mockResolvedValue(undefined);

    await expect(
      ensurePersonalLoopbackAccess({
        endpoint: "https://massion.example",
        tokenReference: "env:MASSION_TOKEN",
        token: "mat_remote-token",
        verify,
        refresh,
        replace,
      }),
    ).resolves.toBe("mat_remote-token");
    expect(verify).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});
