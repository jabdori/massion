export type CliOutputMode = "human" | "json" | "jsonl";

export interface CliInvocation {
  readonly command: string;
  readonly subcommand?: string;
  readonly arguments: readonly string[];
  readonly output: CliOutputMode;
  readonly detach: boolean;
  readonly wait: boolean;
  readonly retryBlocked: boolean;
  readonly after?: number;
  readonly events?: "jsonl";
  readonly profile?: string;
}

const COMMANDS: Readonly<Record<string, readonly string[] | undefined>> = {
  version: undefined,
  local: ["start", "status", "backup", "stop"],
  init: undefined,
  status: undefined,
  run: undefined,
  resume: undefined,
  watch: undefined,
  org: ["graph", "apply"],
  work: ["list", "get", "follow-up", "fork", "cancel"],
  chat: ["rooms", "messages", "send", "join", "leave"],
  task: ["assign", "reassign"],
  approval: ["list", "get", "approve", "reject", "cancel"],
  assurance: ["binding-propose", "binding-activate", "binding-get", "binding-active"],
  runtime: ["get", "cancel", "suspend", "resume"],
  provider: [
    "list",
    "provider-add",
    "endpoint-add",
    "credential-add",
    "credential-disable",
    "model-add",
    "route-set",
    "candidate-add",
  ],
  ext: [
    "validate",
    "link",
    "pack",
    "publish",
    "search",
    "info",
    "install",
    "update",
    "rollback",
    "recall",
    "inventory",
    "list",
  ],
  integration: ["list", "deliveries", "oauth-start", "connect", "user-bind", "channel-bind"],
  growth: ["status", "configure", "suggestions", "adopt", "revert"],
  doctor: undefined,
  help: undefined,
};

function optionValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} option 값이 필요합니다`);
  return value;
}

export function parseCliArguments(argv: readonly string[]): CliInvocation {
  const command = argv[0] ?? "help";
  if (!(command in COMMANDS)) throw new Error(`지원하지 않는 mass command입니다: ${command}`);
  const subcommands = COMMANDS[command];
  let index = 1;
  let subcommand: string | undefined;
  if (subcommands) {
    subcommand = argv[index];
    if (!subcommand || !subcommands.includes(subcommand)) throw new Error(`${command} subcommand가 유효하지 않습니다`);
    index += 1;
  }
  let output: CliOutputMode = "human";
  let detach = false;
  let wait = false;
  let retryBlocked = false;
  let after: number | undefined;
  let events: "jsonl" | undefined;
  let profile: string | undefined;
  const positional: string[] = [];
  while (index < argv.length) {
    const value = argv[index];
    if (value === "--json" || value === "--jsonl") {
      const selected = value.slice(2) as "json" | "jsonl";
      if (output !== "human" && output !== selected) throw new Error("--json과 --jsonl을 동시에 사용할 수 없습니다");
      output = selected;
    } else if (value === "--detach") detach = true;
    else if (value === "--wait") wait = true;
    else if (value === "--retry-blocked") retryBlocked = true;
    else if (value === "--after") {
      const candidate = optionValue(argv, index, value);
      if (!/^(?:0|[1-9][0-9]*)$/u.test(candidate) || !Number.isSafeInteger(Number(candidate)))
        throw new Error("--after cursor가 유효하지 않습니다");
      after = Number(candidate);
      index += 1;
    } else if (value === "--events") {
      const candidate = optionValue(argv, index, value);
      if (candidate !== "jsonl") throw new Error("--events는 jsonl만 지원합니다");
      events = "jsonl";
      index += 1;
    } else if (value === "--profile") {
      profile = optionValue(argv, index, value);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(profile)) throw new Error("profile 이름이 유효하지 않습니다");
      index += 1;
    } else if (value?.startsWith("--")) throw new Error(`지원하지 않는 option입니다: ${value}`);
    else if (value !== undefined) positional.push(value);
    index += 1;
  }
  if (detach && wait) throw new Error("--detach와 --wait를 동시에 사용할 수 없습니다");
  if (command === "watch" && events !== "jsonl") throw new Error("watch에는 --events jsonl이 필요합니다");
  if (retryBlocked && command !== "resume")
    throw new Error("--retry-blocked는 resume command에서만 사용할 수 있습니다");
  return {
    command,
    ...(subcommand === undefined ? {} : { subcommand }),
    arguments: positional,
    output,
    detach,
    wait,
    retryBlocked,
    ...(after === undefined ? {} : { after }),
    ...(events === undefined ? {} : { events }),
    ...(profile === undefined ? {} : { profile }),
  };
}
