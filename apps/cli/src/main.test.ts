import { cancel, isCancel, select, text } from "@clack/prompts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveProviderLoginOnboarding, runCli } from "./main.js";
import type { CliInvocation } from "./parser.js";

vi.mock("@clack/prompts", () => ({
  cancel: vi.fn(),
  isCancel: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
}));

describe("massion CLI entrypoint", () => {
  const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

  afterEach(() => {
    if (stdinTty) Object.defineProperty(process.stdin, "isTTY", stdinTty);
    else Reflect.deleteProperty(process.stdin, "isTTY");
    if (stdoutTty) Object.defineProperty(process.stdout, "isTTY", stdoutTty);
    else Reflect.deleteProperty(process.stdout, "isTTY");
    vi.resetAllMocks();
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

  it("사람용 init 취소는 runtime이나 config를 만들지 않고 130으로 끝난다", async () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    const cancelled = Symbol("cancelled");
    vi.mocked(text).mockResolvedValueOnce(cancelled);
    vi.mocked(isCancel).mockImplementation((value) => value === cancelled);
    const error = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(runCli(["init"])).resolves.toBe(130);

    expect(cancel).toHaveBeenCalledWith("온보딩을 취소했습니다.");
    expect(error).not.toHaveBeenCalled();
  });

  it("JSON init은 TTY여도 대화형 질문을 열지 않고 사용법 오류로 끝난다", async () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    const error = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(runCli(["init", "--json"])).resolves.toBe(2);

    expect(text).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("사용법: massion init"));
  });

  it("비대화형 auth login은 Provider 선택 UI를 열지 않는다", async () => {
    const invocation: CliInvocation = {
      command: "auth",
      subcommand: "login",
      arguments: [],
      output: "json",
      detach: false,
      wait: false,
      retryBlocked: false,
      newAccount: false,
    };

    await expect(resolveProviderLoginOnboarding(invocation)).rejects.toThrow("사용법: massion auth login");

    expect(select).not.toHaveBeenCalled();
  });
});
