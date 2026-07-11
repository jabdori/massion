function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Slack input이 object여야 합니다");
  return value as Record<string, unknown>;
}

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Z0-9][A-Z0-9._:-]{1,127}$/u.test(value))
    throw new Error(`${label}이 유효하지 않습니다`);
  return value;
}

function text(value: unknown, maximum = 4000): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    throw new Error("Slack text 상한이 유효하지 않습니다");
  return value.trim();
}

export async function invokeSlack(contribution: string, input: unknown): Promise<unknown> {
  await Promise.resolve();
  const source = record(input);
  if (contribution === "eventConsumers:slack-notification") {
    const message = text(source.text);
    if (/<!(?:channel|everyone|here)>|<@[A-Z0-9]+>/u.test(message))
      throw new Error("Slack notification mention을 허용하지 않습니다");
    return {
      method: "chat.postMessage",
      destination: id(source.destination, "Slack destination"),
      body: { text: message, unfurl_links: false, unfurl_media: false },
    };
  }
  if (contribution !== "surfaceConnectors:slack") throw new Error("지원하지 않는 Slack contribution입니다");
  const actorExternalId = id(source.userId, "Slack user ID");
  const destination = id(source.channelId, "Slack channel ID");
  if (source.kind === "interaction") {
    const action = text(source.actionId, 256).match(/^approval:([A-Za-z0-9_-]{8,128}):(approve|reject)$/u);
    if (!action) throw new Error("지원하지 않는 Slack interaction입니다");
    return {
      kind: "application-command",
      operation: "approval.decide",
      actorExternalId,
      destination,
      arguments: { handle: action[1], decision: action[2] },
    };
  }
  if (source.kind !== "command") throw new Error("지원하지 않는 Slack input kind입니다");
  const command = text(source.text);
  const patterns: readonly [RegExp, string, (match: RegExpMatchArray) => object][] = [
    [/^work create\s+(.+)$/su, "work.create", (match) => ({ request: match[1] })],
    [/^work status\s+([A-Za-z0-9._:-]{8,128})$/u, "work.status", (match) => ({ workId: match[1] })],
    [
      /^room post\s+([A-Za-z0-9._:-]{8,128})\s+(.+)$/su,
      "collaboration.post",
      (match) => ({ workId: match[1], message: match[2] }),
    ],
    [/^stop\s+([A-Za-z0-9._:-]{8,128})$/u, "runtime.stop", (match) => ({ runId: match[1] })],
  ];
  for (const [pattern, operation, project] of patterns) {
    const match = command.match(pattern);
    if (match)
      return { kind: "application-command", operation, actorExternalId, destination, arguments: project(match) };
  }
  throw new Error("지원하지 않는 Slack 명령입니다");
}
