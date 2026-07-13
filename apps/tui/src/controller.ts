import type { TuiAction, TuiState } from "./state.js";
import { decodeEvent, decodeQueryResult, decodeSnapshot } from "./wire.js";

export interface TuiIdentity {
  readonly userId: string;
  readonly organizationId: string;
  readonly membershipId: string;
  readonly role: string;
}

export interface TuiApiClient {
  status(): Promise<unknown>;
  me(): Promise<unknown>;
  snapshot(): Promise<unknown>;
  streamEvents(after?: number, signal?: AbortSignal): AsyncIterable<unknown>;
  query(operation: string, payload: unknown): Promise<unknown>;
  command(value: unknown): Promise<unknown>;
}

const QUERY_OPERATIONS = new Set([
  "work.messages",
  "work.records",
  "runtime.execution.events",
  "governance.approval.list",
  "router.credentials",
  "router.routes",
  "extension.list",
  "growth.configuration.get",
  "growth.suggestions",
  "growth.effects",
  "subscription.providers",
  "subscription.accounts",
  "subscription.quota",
  "subscription.policy",
  "subscription.doctor",
  "optimization.policy",
  "optimization.receipts",
  "optimization.recommendations",
  "optimization.observations",
  "optimization.batch.active",
]);

function identity(input: unknown): TuiIdentity {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("TUI Identity 응답이 유효하지 않습니다");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => !["userId", "organizationId", "membershipId", "role"].includes(key)) ||
    typeof value.userId !== "string" ||
    typeof value.organizationId !== "string" ||
    typeof value.membershipId !== "string" ||
    typeof value.role !== "string"
  )
    throw new Error("TUI Identity 응답이 유효하지 않습니다");
  return {
    userId: value.userId,
    organizationId: value.organizationId,
    membershipId: value.membershipId,
    role: value.role,
  };
}

export class TuiController {
  public identity: TuiIdentity = { userId: "", organizationId: "", membershipId: "", role: "" };
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;

  public constructor(
    public readonly client: TuiApiClient,
    private readonly dispatch: (action: TuiAction) => void,
    private readonly state: () => TuiState,
    input: { readonly delay?: (milliseconds: number) => Promise<void>; readonly random?: () => number } = {},
  ) {
    this.delay =
      input.delay ??
      (async (milliseconds) => {
        await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
      });
    this.random = input.random ?? Math.random;
  }

  public async refresh(): Promise<void> {
    this.dispatch({ type: "connection.changed", connection: "connecting" });
    decodeQueryResult(await this.client.status(), "system.status");
    const currentIdentity = identity(decodeQueryResult(await this.client.me(), "identity.me"));
    const snapshot = decodeSnapshot(decodeQueryResult(await this.client.snapshot(), "organization.graph.snapshot"));
    if (snapshot.organization.organizationId !== currentIdentity.organizationId)
      throw new Error("TUI Identity와 snapshot 조직이 일치하지 않습니다");
    this.identity = currentIdentity;
    this.dispatch({ type: "snapshot.loaded", snapshot });
    this.dispatch({ type: "connection.changed", connection: "live" });
  }

  public async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    let initialized = false;
    const stopped = (): boolean => signal.aborted;
    while (!stopped()) {
      try {
        if (!initialized) {
          await this.refresh();
          initialized = true;
        }
        for await (const input of this.client.streamEvents(this.state().cursor, signal)) {
          if (stopped()) break;
          this.dispatch({ type: "event.received", event: decodeEvent(input) });
          if (this.state().needsResync) await this.refresh();
          else this.dispatch({ type: "connection.changed", connection: "live" });
          failures = 0;
        }
        if (stopped()) break;
        throw new Error("Application event stream이 종료됐습니다");
      } catch {
        if (stopped()) break;
        initialized = this.state().snapshot !== undefined;
        failures += 1;
        this.dispatch({
          type: "connection.changed",
          connection: failures >= 5 ? "offline" : "reconnecting",
          error: "실시간 연결이 끊어졌습니다. 안전하게 재연결합니다.",
        });
        const base = Math.min(8_000, 250 * 2 ** Math.min(failures - 1, 5));
        await this.delay(Math.round(base + base * 0.2 * this.random()));
      }
    }
    this.dispatch({ type: "connection.changed", connection: "stopped" });
  }

  public async query(operation: string, payload: unknown): Promise<unknown> {
    if (!QUERY_OPERATIONS.has(operation)) throw new Error("TUI에서 허용되지 않은 query operation입니다");
    return decodeQueryResult(await this.client.query(operation, payload), operation);
  }
}
