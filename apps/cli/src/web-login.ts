import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const WEB_TICKET = /^mwt_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/u;

export interface WebLoginTicket {
  readonly ticketId: string;
  readonly code: string;
  readonly expiresAt: string;
}

export interface WebLoginInput {
  readonly endpoint: string;
  readonly token: string;
  readonly fetcher?: typeof fetch;
}

export interface OpenWebConsoleInput extends WebLoginInput {
  readonly openBrowser?: (url: string) => Promise<void>;
}

function endpoint(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Web Console endpoint가 유효하지 않습니다");
  }
  if (
    !new Set(["http:", "https:"]).has(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Web Console endpoint는 자격 증명·query·fragment 없이 HTTP(S) URL이어야 합니다");
  }
  return parsed.toString().replace(/\/$/u, "");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Web login ticket 응답이 object가 아닙니다");
  return value as Record<string, unknown>;
}

export async function issueWebLoginTicket(input: WebLoginInput): Promise<WebLoginTicket> {
  const baseUrl = endpoint(input.endpoint);
  const response = await (input.fetcher ?? fetch)(`${baseUrl}/api/v1/web/login-tickets`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${input.token}`,
    },
    body: JSON.stringify({ commandId: randomUUID(), ttlSeconds: 300 }),
  });
  const body = (await response.json().catch(() => undefined)) as unknown;
  if (!response.ok) throw new Error(`Web login ticket 발급에 실패했습니다 (${String(response.status)})`);
  const value = object(body);
  if (
    typeof value.ticketId !== "string" ||
    !value.ticketId ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    typeof value.code !== "string" ||
    !WEB_TICKET.test(value.code)
  ) {
    throw new Error("Web login ticket 응답이 유효하지 않습니다");
  }
  return { ticketId: value.ticketId, code: value.code, expiresAt: value.expiresAt };
}

async function defaultOpenBrowser(url: string): Promise<void> {
  const executable =
    process.platform === "darwin" ? "/usr/bin/open" : process.platform === "linux" ? "xdg-open" : undefined;
  if (!executable) return;
  await executeFile(executable, [url], { encoding: "utf8", maxBuffer: 16 * 1024 });
}

export async function openWebConsole(
  input: OpenWebConsoleInput,
): Promise<{ readonly url: string; readonly code: string; readonly expiresAt: string }> {
  const baseUrl = endpoint(input.endpoint);
  const ticket = await issueWebLoginTicket(input);
  // 티켓 코드를 URL에 포함하여 브라우저가 자동으로 로그인할 수 있게 합니다
  const url = `${baseUrl}/login?code=${encodeURIComponent(ticket.code)}`;
  await (input.openBrowser ?? defaultOpenBrowser)(url).catch(() => undefined);
  return { url, code: ticket.code, expiresAt: ticket.expiresAt };
}
