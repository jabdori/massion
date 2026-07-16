import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "./main.js";

describe("massion CLI entrypoint", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("--help는 사람이 읽는 섹션형 도움말을 출력한다", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(runCli(["--help"])).resolves.toBe(0);
    const output = write.mock.calls.map(([value]) => String(value)).join("");
    expect(output).toContain("사용법:");
    expect(output).toContain("주요 명령:");
    expect(output).toContain("공통 옵션:");
    expect(output).toContain("massion --version");
  });

  it("--version과 -v는 버전을 출력한다", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(runCli(["--version"])).resolves.toBe(0);
    await expect(runCli(["-v"])).resolves.toBe(0);
    expect(write.mock.calls.map(([value]) => String(value)).join("")).toBe(
      "Massion AgentOS 1.0.0\nMassion AgentOS 1.0.0\n",
    );
  });
});
