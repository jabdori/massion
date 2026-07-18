import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "./main.js";

describe("massion CLI entrypoint", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("--help는 표준 CLI 사용법·옵션·명령 목록을 출력한다", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(runCli(["--help"])).resolves.toBe(0);
    const output = write.mock.calls.map(([value]) => String(value)).join("");
    expect(output).toContain("Usage: massion");
    expect(output).toContain("Options:");
    expect(output).toContain("Commands:");
    expect(output).toContain("--version");
  });

  it("--version과 -v는 버전을 출력한다", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(runCli(["--version"])).resolves.toBe(0);
    await expect(runCli(["-v"])).resolves.toBe(0);
    expect(write.mock.calls.map(([value]) => String(value)).join("")).toBe(
      "Massion AgentOS 1.0.0\nMassion AgentOS 1.0.0\n",
    );
  });

  it("명령별 --help는 표준 사용법을 stdout으로 출력하고 성공한다", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const error = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(runCli(["status", "--help"])).resolves.toBe(0);

    expect(write.mock.calls.map(([value]) => String(value)).join("")).toContain("Usage: massion status");
    expect(error).not.toHaveBeenCalled();
  });
});
