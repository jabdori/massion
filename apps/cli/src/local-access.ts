import { ApplicationRemoteError } from "@massion/application";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function isPersonalLoopbackFileProfile(endpoint: string, tokenReference: string): boolean {
  if (!tokenReference.startsWith("file:")) return false;
  try {
    const url = new URL(endpoint);
    return (
      url.protocol === "http:" &&
      LOOPBACK_HOSTS.has(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function isAuthenticationFailure(error: unknown): boolean {
  if (!(error instanceof ApplicationRemoteError) || error.status !== 401 || !error.body || typeof error.body !== "object")
    return false;
  return (error.body as { category?: unknown }).category === "authentication";
}

export async function ensurePersonalLoopbackAccess(input: {
  readonly endpoint: string;
  readonly tokenReference: string;
  readonly token: string;
  readonly verify: (token: string) => Promise<void>;
  readonly refresh: (token: string) => Promise<string>;
  readonly replace: (reference: string, token: string) => Promise<void>;
}): Promise<string> {
  if (!isPersonalLoopbackFileProfile(input.endpoint, input.tokenReference)) return input.token;
  try {
    await input.verify(input.token);
    return input.token;
  } catch (error) {
    if (!isAuthenticationFailure(error)) throw error;
  }
  const refreshed = await input.refresh(input.token);
  await input.replace(input.tokenReference, refreshed);
  await input.verify(refreshed);
  return refreshed;
}
