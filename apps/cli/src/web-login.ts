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
  // Frictionless 로컬 진입: access 토큰으로 세션을 직접 발급해 서버에 보관시킵니다.
  // 브라우저가 콘솔 root를 GET하면 서버가 이 세션 쿠키를 자동으로 내려줍니다.
  // 일회성 코드를 URL이나 터미널에 노출하지 않습니다.
  await issueLocalSession(input);
  const url = `${baseUrl}/`;
  await (input.openBrowser ?? defaultOpenBrowser)(url).catch(() => undefined);
  return { url, code: "", expiresAt: new Date(Date.now() + 28_800_000).toISOString() };
}

export interface DesktopSession {
  readonly origin: string;
  // 브라우저 쿠키 저장소에 그대로 주입할 name=value 쌍입니다.
  readonly cookie: string;
  readonly maxAgeSeconds: number;
}

// Frictionless 로컬 진입: access 토큰으로 /api/v1/web/local-session 을 호출해 세션을 발급받습니다.
// 서버는 발급한 세션을 잠깐 보관(pendingLocalSession)하고, 브라우저가 콘솔 root를
// GET하면 자동으로 세션 쿠키를 내려줍니다. 일회성 코드를 URL/터미널에 노출하지 않습니다.
export async function issueLocalSession(input: WebLoginInput): Promise<void> {
  const baseUrl = endpoint(input.endpoint);
  const response = await (input.fetcher ?? fetch)(`${baseUrl}/api/v1/web/local-session`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${input.token}`,
      // 서버의 Fetch Metadata/Origin CSRF 방어를 브라우저와 동일하게 충족시킵니다.
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
    },
    body: JSON.stringify({ commandId: randomUUID() }),
  });
  await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(`Local session 발급에 실패했습니다 (${String(response.status)})`);
}

// 데스크톱 shell 전용: 티켓을 서버측에서 즉시 교환해 세션 쿠키를 확보합니다.
// WKWebView는 fetch 응답의 Set-Cookie를 신뢰성 있게 저장하지 못하므로, shell이 이 쿠키를
// document.cookie로 주입한 뒤 콘솔 root를 로드하면 로그인 마찰 없이 인증 상태로 진입합니다.
export async function issueDesktopSession(input: WebLoginInput): Promise<DesktopSession> {
  const baseUrl = endpoint(input.endpoint);
  const ticket = await issueWebLoginTicket(input);
  const response = await (input.fetcher ?? fetch)(`${baseUrl}/api/v1/web/sessions`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      // 서버의 Fetch Metadata/Origin CSRF 방어를 브라우저와 동일하게 충족시킵니다.
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
    },
    body: JSON.stringify({ code: ticket.code }),
  });
  await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(`Web session 교환에 실패했습니다 (${String(response.status)})`);
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("Web session 쿠키를 받지 못했습니다");
  const nameValue = /^(?:__Host-)?massion_session=[^;]+/u.exec(setCookie);
  if (!nameValue) throw new Error("Web session 쿠키 형식이 예상과 다릅니다");
  const maxAge = /max-age=(\d+)/iu.exec(setCookie);
  return { origin: baseUrl, cookie: nameValue[0], maxAgeSeconds: maxAge ? Number(maxAge[1]) : 900 };
}
