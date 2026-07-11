import { EXTENSION_RPC_PROTOCOL, type ExtensionHandshake, type ExtensionRpcFrame } from "./contracts.js";

function inspect(value: unknown, depth: number, maximum: number): void {
  if (depth > maximum) throw new Error("Extension RPC payload 깊이 상한을 초과했습니다");
  if (!value || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value))
      throw new Error("Extension RPC number가 유효하지 않습니다");
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new Error("Extension RPC payload에 prototype key를 사용할 수 없습니다");
    }
    inspect(child, depth + 1, maximum);
  }
}

export function createRpcFrameParser(options: { readonly maxFrameBytes?: number; readonly maxDepth?: number } = {}): {
  parse(line: string): ExtensionRpcFrame;
} {
  const maximumBytes = options.maxFrameBytes ?? 64 * 1024;
  const maximumDepth = options.maxDepth ?? 12;
  let lastSequence = 0;
  const requestIds = new Set<string>();
  return {
    parse(line: string): ExtensionRpcFrame {
      if (Buffer.byteLength(line, "utf8") > maximumBytes)
        throw new Error("Extension RPC frame byte 상한을 초과했습니다");
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        throw new Error("Extension RPC stdout은 JSON frame만 허용합니다");
      }
      inspect(value, 0, maximumDepth);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Extension RPC frame이 유효하지 않습니다");
      const frame = value as Record<string, unknown>;
      const allowed = new Set(["protocol", "requestId", "sequence", "operation", "payload"]);
      const unknown = Object.keys(frame).find((key) => !allowed.has(key));
      if (unknown) throw new Error(`Extension RPC frame에 알 수 없는 필드가 있습니다: ${unknown}`);
      if (frame.protocol !== EXTENSION_RPC_PROTOCOL) throw new Error("Extension RPC protocol이 유효하지 않습니다");
      if (typeof frame.requestId !== "string" || frame.requestId.length === 0 || frame.requestId.length > 128) {
        throw new Error("Extension RPC requestId가 유효하지 않습니다");
      }
      if (!Number.isSafeInteger(frame.sequence) || (frame.sequence as number) <= lastSequence) {
        throw new Error("Extension RPC sequence는 단조 증가해야 합니다");
      }
      if (requestIds.has(frame.requestId)) throw new Error("Extension RPC requestId가 중복됐습니다");
      if (typeof frame.operation !== "string" || !/^[a-z][a-z0-9]*(?:\.[a-z0-9]+)*$/u.test(frame.operation)) {
        throw new Error("Extension RPC operation이 유효하지 않습니다");
      }
      lastSequence = frame.sequence as number;
      requestIds.add(frame.requestId);
      return value as ExtensionRpcFrame;
    },
  };
}

export function validateHandshake(actual: ExtensionHandshake, expected: ExtensionHandshake): ExtensionHandshake {
  if (actual.nonce !== expected.nonce) throw new Error("Extension handshake nonce가 일치하지 않습니다");
  if (actual.manifestDigest !== expected.manifestDigest) {
    throw new Error("Extension handshake manifest digest가 일치하지 않습니다");
  }
  if (actual.sdkVersion !== expected.sdkVersion) throw new Error("Extension handshake SDK version이 일치하지 않습니다");
  if (
    actual.contributions.length !== expected.contributions.length ||
    actual.contributions.some((value, index) => value !== expected.contributions[index])
  ) {
    throw new Error("Extension handshake contribution이 일치하지 않습니다");
  }
  return structuredClone(actual);
}
