import { EXTENSION_RPC_PROTOCOL, type ExtensionRpcFrame } from "./contracts.js";
import { createRpcFrameParser } from "./protocol.js";

export interface ExtensionWorkerHandlers {
  readonly health: () => Promise<unknown>;
  readonly invoke: (contribution: string, input: unknown) => Promise<unknown>;
  readonly stop?: () => Promise<void>;
}

export interface CreateExtensionWorkerInput {
  readonly manifestDigest: string;
  readonly sdkVersion: string;
  readonly contributions: readonly string[];
  readonly handlers: ExtensionWorkerHandlers;
  readonly maxFrameBytes?: number;
}

export interface ExtensionWorkerIo {
  readonly lines: AsyncIterable<string>;
  readonly writeLine: (line: string) => Promise<void>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} payload가 유효하지 않습니다`);
  return value as Record<string, unknown>;
}

function response(request: ExtensionRpcFrame, operation: string, payload: unknown): ExtensionRpcFrame {
  return {
    protocol: EXTENSION_RPC_PROTOCOL,
    requestId: request.requestId,
    sequence: request.sequence,
    operation,
    payload,
  };
}

export function createExtensionWorker(input: CreateExtensionWorkerInput): {
  run(io: ExtensionWorkerIo): Promise<void>;
} {
  if (!/^[a-f0-9]{64}$/u.test(input.manifestDigest)) throw new Error("manifest digest가 유효하지 않습니다");
  const contributions = new Set(input.contributions);
  if (contributions.size !== input.contributions.length) throw new Error("worker contribution이 중복됐습니다");
  const maximum = input.maxFrameBytes ?? 64 * 1024;
  return {
    async run(io: ExtensionWorkerIo): Promise<void> {
      const parser = createRpcFrameParser({ maxFrameBytes: maximum });
      let ready = false;
      for await (const line of io.lines) {
        const request = parser.parse(line);
        let outgoing: ExtensionRpcFrame;
        if (request.operation === "host.handshake") {
          if (ready) throw new Error("Extension worker handshake는 한 번만 허용합니다");
          const payload = object(request.payload, "handshake");
          if (typeof payload.nonce !== "string" || payload.nonce.length === 0 || payload.nonce.length > 256) {
            throw new Error("Extension worker handshake nonce가 유효하지 않습니다");
          }
          ready = true;
          outgoing = response(request, "worker.handshake", {
            nonce: payload.nonce,
            manifestDigest: input.manifestDigest,
            sdkVersion: input.sdkVersion,
            contributions: [...input.contributions],
          });
        } else {
          if (!ready) throw new Error("Extension worker는 handshake 전에 호출할 수 없습니다");
          if (request.operation === "health.check") {
            outgoing = response(request, "health.result", await input.handlers.health());
          } else if (request.operation === "contribution.invoke") {
            const payload = object(request.payload, "contribution");
            if (typeof payload.contribution !== "string" || !contributions.has(payload.contribution)) {
              throw new Error("선언하지 않은 Extension contribution입니다");
            }
            outgoing = response(
              request,
              "contribution.result",
              await input.handlers.invoke(payload.contribution, payload.input),
            );
          } else if (request.operation === "host.stop") {
            await input.handlers.stop?.();
            outgoing = response(request, "worker.stopped", {});
          } else {
            throw new Error(`지원하지 않는 Extension worker operation입니다: ${request.operation}`);
          }
        }
        const encoded = JSON.stringify(outgoing);
        if (Buffer.byteLength(encoded, "utf8") > maximum) throw new Error("Extension worker 응답 byte 상한을 초과했습니다");
        await io.writeLine(encoded);
        if (request.operation === "host.stop") return;
      }
    },
  };
}
