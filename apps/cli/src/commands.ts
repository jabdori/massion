import { randomUUID } from "node:crypto";

import type { CliInvocation } from "./parser.js";

export interface CliApplicationClient {
  status(): Promise<unknown>;
  snapshot(): Promise<unknown>;
  query(operation: string, payload: unknown): Promise<unknown>;
  command(input: unknown): Promise<unknown>;
  inspectArtifact(archive: Uint8Array): Promise<unknown>;
  installArtifact(commandId: string, archive: Uint8Array): Promise<unknown>;
  updateArtifact(commandId: string, archive: Uint8Array): Promise<unknown>;
  publishArtifact?(commandId: string, archive: Uint8Array, metadata: unknown): Promise<unknown>;
}

export interface CliCommandInput {
  readonly readJson?: () => Promise<unknown>;
  readonly readArtifact?: (path: string) => Promise<Uint8Array>;
}

function required(arguments_: readonly string[], index: number, label: string): string {
  const value = arguments_[index];
  if (!value) throw new Error(`${label} 인자가 필요합니다`);
  return value;
}

function integer(value: string, label: string): number {
  if (!/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error(`${label}가 유효하지 않습니다`);
  return Number(value);
}

function envelope(operation: string, payload: unknown, expectedRevision?: number): unknown {
  const commandId = randomUUID();
  return {
    schemaVersion: "massion.application.v1",
    commandId,
    correlationId: randomUUID(),
    operation,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    payload,
  };
}

async function stdin(input: CliCommandInput, label: string): Promise<Record<string, unknown>> {
  if (!input.readJson) throw new Error(`${label} 입력은 stdin JSON이 필요합니다`);
  const value = await input.readJson();
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} stdin JSON은 object여야 합니다`);
  return value as Record<string, unknown>;
}

export async function executeCliInvocation(
  client: CliApplicationClient,
  invocation: CliInvocation,
  input: CliCommandInput = {},
): Promise<unknown> {
  const args = invocation.arguments;
  if (invocation.command === "status" || invocation.command === "doctor") return await client.status();
  if (invocation.command === "org" && invocation.subcommand === "graph") return await client.snapshot();
  if (invocation.command === "work" && invocation.subcommand === "list") return await client.query("work.list", {});
  if (invocation.command === "work" && invocation.subcommand === "get")
    return await client.query("work.get", { workId: required(args, 0, "workId") });
  if (invocation.command === "chat" && invocation.subcommand === "rooms")
    return await client.query("work.rooms", { workId: required(args, 0, "workId") });
  if (invocation.command === "chat" && invocation.subcommand === "messages")
    return await client.query("work.messages", {
      workId: required(args, 0, "workId"),
      roomId: required(args, 1, "roomId"),
    });
  if (invocation.command === "task" && invocation.subcommand === undefined)
    return await client.query("work.tasks", { workId: required(args, 0, "workId") });
  if (invocation.command === "approval" && invocation.subcommand === "list")
    return await client.query("governance.approval.list", {});
  if (invocation.command === "approval" && invocation.subcommand === "get")
    return await client.query("governance.approval.get", { approvalId: required(args, 0, "approvalId") });
  if (invocation.command === "runtime" && invocation.subcommand === "get")
    return await client.query("runtime.execution.get", { executionId: required(args, 0, "executionId") });
  if (invocation.command === "provider" && invocation.subcommand === "list") {
    const [credentials, routes] = await Promise.all([
      client.query("router.credentials", {}),
      client.query("router.routes", {}),
    ]);
    return { credentials, routes };
  }
  if (invocation.command === "ext" && invocation.subcommand === "list") return await client.query("extension.list", {});
  if (invocation.command === "ext" && invocation.subcommand === "search")
    return await client.query("registry.search", { query: args.join(" "), limit: 20 });
  if (invocation.command === "ext" && invocation.subcommand === "info")
    return await client.query("registry.info", { versionId: required(args, 0, "versionId") });
  if (invocation.command === "ext" && invocation.subcommand === "inventory")
    return await client.query("registry.inventory", {});
  if (invocation.command === "integration" && invocation.subcommand === "list")
    return await client.query("integration.list", {});
  if (invocation.command === "integration" && invocation.subcommand === "deliveries")
    return await client.query(
      "integration.deliveries",
      args[0] === undefined ? {} : { limit: integer(args[0], "limit") },
    );
  if (invocation.command === "growth" && invocation.subcommand === "status")
    return await client.query("growth.configuration.get", {});
  if (invocation.command === "growth" && invocation.subcommand === "suggestions")
    return await client.query("growth.suggestions", {});
  if (invocation.command === "work" && invocation.subcommand === "cancel")
    return await client.command(
      envelope(
        "work.cancel",
        { workId: required(args, 0, "workId") },
        integer(required(args, 1, "expected revision"), "expected revision"),
      ),
    );
  if (invocation.command === "work" && invocation.subcommand === "follow-up")
    return await client.command(
      envelope("work.follow-up", {
        parentWorkId: required(args, 0, "parentWorkId"),
        text: required(args, 1, "request text"),
        surface: "cli",
      }),
    );
  if (invocation.command === "work" && invocation.subcommand === "fork")
    return await client.command(
      envelope(
        "work.fork",
        { workId: required(args, 0, "workId"), objective: required(args, 2, "objective") },
        integer(required(args, 1, "expected revision"), "expected revision"),
      ),
    );
  if (invocation.command === "chat" && invocation.subcommand === "send") {
    const me = (await client.query("identity.me", {})) as { data?: { userId?: string } };
    return await client.command(
      envelope("collaboration.message.post", {
        workId: required(args, 0, "workId"),
        roomId: required(args, 1, "roomId"),
        messageType: "text",
        authorKind: "user",
        authorId: me.data?.userId,
        content: required(args, 2, "message"),
      }),
    );
  }
  if (invocation.command === "approval" && ["approve", "reject"].includes(invocation.subcommand ?? ""))
    return await client.command(
      envelope("approval.vote", {
        approvalId: required(args, 0, "approvalId"),
        vote: invocation.subcommand,
        reason: required(args, 1, "reason"),
      }),
    );
  if (invocation.command === "approval" && invocation.subcommand === "cancel")
    return await client.command(
      envelope("approval.cancel", { approvalId: required(args, 0, "approvalId"), reason: required(args, 1, "reason") }),
    );
  if (invocation.command === "runtime" && ["cancel", "suspend", "resume"].includes(invocation.subcommand ?? ""))
    return await client.command(
      envelope(`runtime.${invocation.subcommand ?? ""}`, {
        executionId: required(args, 0, "executionId"),
        ...(args[1] === undefined ? {} : { reason: args[1] }),
      }),
    );
  if (invocation.command === "ext" && invocation.subcommand === "validate")
    return await client.command(envelope("extension.validate", { source: required(args, 0, "source") }));
  if (invocation.command === "ext" && invocation.subcommand === "publish") {
    if (!input.readArtifact || !client.publishArtifact) throw new Error("Registry publish adapter가 필요합니다");
    return await client.publishArtifact(
      randomUUID(),
      await input.readArtifact(required(args, 0, "artifact path")),
      await stdin(input, "registry.publish"),
    );
  }
  if (invocation.command === "ext" && ["install", "update"].includes(invocation.subcommand ?? "")) {
    const target = required(args, 0, "artifact path 또는 Registry versionId");
    if (!target.endsWith(".tgz")) {
      return await client.command(
        envelope("registry.install", {
          versionId: target,
          environment: args[1] ?? "production",
          riskClass: args[2] ?? "medium",
          executionId: randomUUID(),
        }),
      );
    }
    if (!input.readArtifact) throw new Error("Extension artifact reader가 필요합니다");
    const archive = await input.readArtifact(target);
    return invocation.subcommand === "install"
      ? await client.installArtifact(randomUUID(), archive)
      : await client.updateArtifact(randomUUID(), archive);
  }
  const operationMap: Readonly<Record<string, string>> = {
    "org:apply": "organization.command",
    "task:assign": "task.assign",
    "task:reassign": "task.assign",
    "provider:credential-add": "router.credential.add",
    "provider:credential-disable": "router.credential.disable",
    "provider:route-set": "router.route.configure",
    "growth:configure": "growth.configure",
    "growth:adopt": "growth.adopt",
    "growth:revert": "growth.revert",
    "chat:join": "collaboration.participant.join",
    "chat:leave": "collaboration.participant.leave",
    "ext:link": "extension.link",
    "ext:pack": "extension.pack",
    "ext:rollback": "extension.rollback",
    "ext:recall": "registry.recall",
    "integration:oauth-start": "integration.oauth.start",
    "integration:connect": "integration.connect",
    "integration:user-bind": "integration.user.bind",
    "integration:channel-bind": "integration.channel.bind",
  };
  const operation = operationMap[`${invocation.command}:${invocation.subcommand ?? ""}`] ?? "";
  if (operation) {
    const payload = await stdin(input, operation);
    const revision = typeof payload.expectedRevision === "number" ? payload.expectedRevision : undefined;
    const clean = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "expectedRevision"));
    return await client.command(envelope(operation, clean, revision));
  }
  throw new Error(`CLI 실행 adapter가 아직 정의되지 않았습니다: ${invocation.command} ${invocation.subcommand ?? ""}`);
}
