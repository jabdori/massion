#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ApplicationHttpClient } from "@massion/application";

import { replaceCliFileToken } from "./init.js";
import { ensurePersonalLoopbackAccess } from "./local-access.js";
import { defaultLocalEndpoint } from "./local-entrypoint.js";
import { resolveLocalPaths } from "./local.js";
import { connectLocalServerSubscription } from "./subscription-login.js";
import { resolveTokenReference } from "./token.js";

export function parseDesktopLoginArguments(argv: readonly string[]): {
  readonly alias: string;
  readonly newAccount: boolean;
} {
  const [rawAlias, intent] = argv;
  const alias = rawAlias?.trim() ?? "";
  if (
    argv.length !== 2 ||
    !alias ||
    [...alias].length > 128 ||
    /[\0\r\n]/u.test(alias) ||
    (intent !== "reuse" && intent !== "new")
  ) {
    throw new Error("Desktop Codex login 입력이 유효하지 않습니다");
  }
  return { alias, newAccount: intent === "new" };
}

export async function runDesktopLogin(
  argv: readonly string[] = process.argv.slice(2),
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const input = parseDesktopLoginArguments(argv);
  const endpoint = defaultLocalEndpoint(environment);
  const paths = resolveLocalPaths(environment);
  const tokenReference = `file:${paths.accessToken}`;
  const token = await resolveTokenReference(tokenReference);
  const access = await ensurePersonalLoopbackAccess({
    endpoint,
    tokenReference,
    token,
    verify: async (candidate) => {
      await new ApplicationHttpClient({ baseUrl: endpoint, token: candidate }).status();
    },
    refresh: async (candidate) =>
      (
        await ApplicationHttpClient.refreshLocalAccess(endpoint, candidate, {
          commandId: randomUUID(),
        })
      ).token,
    replace: replaceCliFileToken,
  });
  await connectLocalServerSubscription(
    new ApplicationHttpClient({ baseUrl: endpoint, token: access }),
    { providerId: "openai-codex", alias: input.alias, newAccount: input.newAccount },
    { endpoint, connectorDirectory: paths.connectorDirectory, environment },
  );
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  try {
    await runDesktopLogin();
  } catch {
    process.stderr.write("Codex 계정 연결을 완료하지 못했습니다\n");
    process.exitCode = 1;
  }
}
