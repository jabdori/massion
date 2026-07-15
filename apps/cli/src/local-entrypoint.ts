const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function configuredPort(environment: Readonly<Record<string, string | undefined>>): string {
  const value = environment.MASSION_LOCAL_PORT ?? "7331";
  if (!/^[0-9]+$/u.test(value)) return "7331";
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 65_535 ? String(number) : "7331";
}

export function defaultLocalEndpoint(environment: Readonly<Record<string, string | undefined>> = process.env): string {
  return `http://127.0.0.1:${configuredPort(environment)}`;
}

export function shouldEnsureLocalEndpoint(
  endpoint: string | undefined,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (endpoint === undefined) return true;
  try {
    const url = new URL(endpoint);
    return (
      url.protocol === "http:" &&
      LOOPBACK_HOSTS.has(url.hostname) &&
      url.port === configuredPort(environment) &&
      (url.pathname === "/" || url.pathname === "") &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

export async function ensureLocalEndpoint(
  endpoint: string | undefined,
  input: {
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly start: () => Promise<unknown>;
  },
): Promise<boolean> {
  if (!shouldEnsureLocalEndpoint(endpoint, input.environment)) return false;
  await input.start();
  return true;
}
