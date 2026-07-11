function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Discord input이 object여야 합니다");
  return value as Record<string, unknown>;
}
function snowflake(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9]{6,20}$/u.test(value)) throw new Error(`${label}이 유효하지 않습니다`);
  return value;
}
function text(value: unknown, maximum = 4000): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    throw new Error("Discord text 상한이 유효하지 않습니다");
  return value.trim();
}
export async function invokeDiscord(contribution: string, input: unknown): Promise<unknown> {
  await Promise.resolve();
  const source = record(input);
  if (contribution === "eventConsumers:discord-notification") {
    const content = text(source.text, 2000);
    if (/@(?:everyone|here)|<@[!&]?[0-9]+>/u.test(content))
      throw new Error("Discord notification mention을 허용하지 않습니다");
    return {
      method: "POST",
      destination: snowflake(source.channelId, "Discord channel ID"),
      body: { content, allowed_mentions: { parse: [] } },
    };
  }
  if (contribution !== "surfaceConnectors:discord") throw new Error("지원하지 않는 Discord contribution입니다");
  const actorExternalId = snowflake(source.userId, "Discord user ID");
  const destination = snowflake(source.channelId, "Discord channel ID");
  if (source.kind === "component") {
    const action = text(source.customId, 256).match(/^approval:([A-Za-z0-9_-]{8,128}):(approve|reject)$/u);
    if (!action) throw new Error("지원하지 않는 Discord component입니다");
    return {
      kind: "application-command",
      operation: "approval.decide",
      actorExternalId,
      destination,
      arguments: { handle: action[1], decision: action[2] },
    };
  }
  if (source.kind !== "command" || source.name !== "massion") throw new Error("지원하지 않는 Discord command입니다");
  const subcommand = text(source.subcommand, 64);
  const options = record(source.options ?? {});
  if (subcommand === "work-create")
    return {
      kind: "application-command",
      operation: "work.create",
      actorExternalId,
      destination,
      arguments: { request: text(options.request) },
    };
  if (subcommand === "work-status")
    return {
      kind: "application-command",
      operation: "work.status",
      actorExternalId,
      destination,
      arguments: { workId: text(options.workId, 128) },
    };
  if (subcommand === "room-post")
    return {
      kind: "application-command",
      operation: "collaboration.post",
      actorExternalId,
      destination,
      arguments: { workId: text(options.workId, 128), message: text(options.message) },
    };
  if (subcommand === "stop")
    return {
      kind: "application-command",
      operation: "runtime.stop",
      actorExternalId,
      destination,
      arguments: { runId: text(options.runId, 128) },
    };
  throw new Error("지원하지 않는 Discord subcommand입니다");
}
