import { createHash } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

import type { ExtensionTrustLevel } from "@massion/extension-sdk";

export interface SandboxReceipt {
  readonly backendId: string;
  readonly backendVersion: string;
  readonly policyDigest: string;
  readonly processId: number;
  readonly appliedAt: string;
}

export interface SandboxSpawnInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly policyDigest: string;
}

export interface SandboxBackend {
  spawn(input: SandboxSpawnInput): Promise<{
    readonly child: ChildProcessWithoutNullStreams;
    readonly receipt: SandboxReceipt;
  }>;
}

export function nodePermissionArguments(versionDirectory: string, entrypoint: string): readonly string[] {
  const root = realpathSync(versionDirectory);
  if (isAbsolute(entrypoint) || entrypoint.includes("\\") || entrypoint.split("/").includes("..")) {
    throw new Error("Extension worker entrypoint가 유효하지 않습니다");
  }
  const target = resolve(root, entrypoint);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error("Extension worker entrypoint가 version directory를 벗어났습니다");
  }
  return ["--permission", `--allow-fs-read=${root}`, target];
}

export function extensionSandboxPolicyDigest(input: {
  readonly versionDirectory: string;
  readonly entrypoint: string;
}): string {
  const policy = JSON.stringify({
    childProcess: false,
    entrypoint: input.entrypoint,
    fileReadRoot: realpathSync(input.versionDirectory),
    fileWrite: false,
    nativeAddons: false,
    network: "broker-only",
    wasi: false,
    workerThreads: false,
  });
  return createHash("sha256").update(policy).digest("hex");
}

export function assertSandboxEligibility(
  trustLevel: ExtensionTrustLevel,
  expectedPolicyDigest: string,
  receipt?: SandboxReceipt,
): SandboxReceipt | undefined {
  if (trustLevel === "built-in" && !receipt) return undefined;
  if (!receipt) throw new Error(`${trustLevel} Extension은 OS sandbox 없이 실행할 수 없습니다`);
  if (!receipt.backendId || !receipt.backendVersion)
    throw new Error("Extension sandbox backend identity가 유효하지 않습니다");
  if (receipt.policyDigest !== expectedPolicyDigest)
    throw new Error("Extension sandbox policy digest가 일치하지 않습니다");
  if (!Number.isSafeInteger(receipt.processId) || receipt.processId <= 0) {
    throw new Error("Extension sandbox process ID가 유효하지 않습니다");
  }
  if (!Number.isFinite(Date.parse(receipt.appliedAt)))
    throw new Error("Extension sandbox 적용 시각이 유효하지 않습니다");
  return structuredClone(receipt);
}
