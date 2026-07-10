import { access, mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfinedCommandRunner } from "./index.js";

describe("제한된 delivery command runner", () => {
  let root: string;
  let runner: ConfinedCommandRunner;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "massion-command-runner-"));
    await mkdir(join(root, "nested"));
    runner = await ConfinedCommandRunner.create({
      workspaceRoot: root,
      executables: { node: process.execPath },
      environmentAllowlist: ["TEST_ALLOWED"],
      maxTimeoutMs: 2_000,
      maxOutputBytes: 4_096,
      maxExcerptBytes: 1_024,
    });
  });

  afterEach(async () => rm(root, { recursive: true, force: true }));

  it("shell 없이 argument array를 그대로 전달하고 stdin과 inherited environment를 닫는다", async () => {
    const marker = join(root, "injected");
    const metacharacter = `; touch ${marker}`;
    const result = await runner.run({
      stage: "validation",
      executable: "node",
      args: [
        "-e",
        "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(`${process.argv[1]}|${process.env.TEST_ALLOWED}|${process.env.NODE_OPTIONS ?? ''}`));",
        metacharacter,
      ],
      cwd: "nested",
      timeoutMs: 1_000,
      maxOutputBytes: 2_048,
      environment: { TEST_ALLOWED: "visible" },
    });

    expect(result.evidence).toMatchObject({
      stage: "validation",
      executable: "node",
      cwd: "nested",
      exitCode: 0,
      timedOut: false,
      outputLimited: false,
    });
    expect(result.evidence.argumentsHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.output).toContain(`${metacharacter}|visible|`);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("executable, cwd와 environment allowlist 밖 입력을 실행 전에 거부한다", async () => {
    const base = {
      stage: "red" as const,
      executable: "node",
      args: ["--version"],
      cwd: ".",
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      environment: {},
    };
    await expect(runner.run({ ...base, executable: "sh" })).rejects.toThrow("executable allowlist");
    await expect(runner.run({ ...base, cwd: "../outside" })).rejects.toThrow("작업 directory");
    await expect(runner.run({ ...base, environment: { SECRET_VALUE: "no" } })).rejects.toThrow("environment allowlist");

    const outside = await mkdtemp(join(tmpdir(), "massion-command-outside-"));
    await symlink(outside, join(root, "linked"));
    await expect(runner.run({ ...base, cwd: "linked" })).rejects.toThrow("workspace 밖");
    await rm(outside, { recursive: true, force: true });
  });

  it("timeout이면 하위 process group까지 종료한다", async () => {
    const marker = join(root, "grandchild-survived");
    const result = await runner.run({
      stage: "green",
      executable: "node",
      args: [
        "-e",
        "const {spawn}=require('node:child_process'); spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{}); setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'bad'),500)\",process.argv[1]],{stdio:'ignore'}); setInterval(()=>{},1000);",
        marker,
      ],
      cwd: ".",
      timeoutMs: 100,
      maxOutputBytes: 1_024,
      environment: {},
    });
    expect(result.evidence.timedOut).toBe(true);
    expect(result.evidence.exitCode).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 700));
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stdout·stderr flood를 byte 제한에서 중단하고 non-UTF8을 안전하게 표현한다", async () => {
    const flooded = await runner.run({
      stage: "validation",
      executable: "node",
      args: ["-e", "process.stdout.write(Buffer.alloc(100_000, 65)); setInterval(()=>{},1000)"],
      cwd: ".",
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      environment: {},
    });
    expect(flooded.evidence.outputLimited).toBe(true);
    expect(Buffer.byteLength(flooded.output)).toBeLessThanOrEqual(1_024);

    const invalidUtf8 = await runner.run({
      stage: "validation",
      executable: "node",
      args: ["-e", "process.stdout.write(Buffer.from([0xff,0xfe,0x41]))"],
      cwd: ".",
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      environment: {},
    });
    expect(invalidUtf8.output).toContain("��A");
    expect(invalidUtf8.evidence.stdoutHash).toBe("e338b52c1bba42031362180fb1465d6e8b382881cb2f2601e30e971f21e4901c");
  });

  it("credential 원문을 반환하지 않고 raw byte hash와 bounded redacted excerpt만 남긴다", async () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const result = await runner.run({
      stage: "red",
      executable: "node",
      args: ["-e", `process.stdout.write(${JSON.stringify(`token=${secret}`)})`],
      cwd: ".",
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      environment: {},
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.output).toContain("token=***");
    expect(result.evidence.credentialRedacted).toBe(true);
    expect(Buffer.byteLength(result.evidence.outputExcerpt)).toBeLessThanOrEqual(1_024);
    expect(result.evidence.stdoutHash).toMatch(/^[a-f0-9]{64}$/u);
  });
});
