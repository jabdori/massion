import { describe, expect, it } from "vitest";

import type { TenantContext } from "@massion/identity";
import type { ExecutionDelta } from "@massion/runtime";

import { ExecutionStreamRegistry } from "./execution-stream.js";

const context: TenantContext = {
  userId: "stream-user",
  organizationId: "stream-organization",
  membershipId: "stream-membership",
  role: "member",
};

const otherContext: TenantContext = {
  userId: "other-user",
  organizationId: "other-organization",
  membershipId: "other-membership",
  role: "member",
};

function delta(input: {
  readonly executionId: string;
  readonly sequence: number;
  readonly text?: string;
}): ExecutionDelta {
  return {
    executionId: input.executionId,
    agentHandle: "representative",
    sequence: input.sequence,
    kind: "output-text",
    ...(input.text === undefined ? {} : { text: input.text }),
    occurredAt: "2026-07-21T09:00:00.000Z",
  };
}

describe("ExecutionStreamRegistry", () => {
  it("같은 tenant 구독자에게만 fan-out하고 executionId filter를 적용한다", () => {
    const registry = new ExecutionStreamRegistry();
    const all: ExecutionDelta[] = [];
    const filtered: ExecutionDelta[] = [];
    const foreign: ExecutionDelta[] = [];
    registry.subscribe(context, {}, (value) => all.push(value));
    registry.subscribe(context, { executionId: "execution-2" }, (value) => filtered.push(value));
    registry.subscribe(otherContext, {}, (value) => foreign.push(value));

    registry.observe(context, delta({ executionId: "execution-1", sequence: 1, text: "환불" }));
    registry.observe(context, delta({ executionId: "execution-2", sequence: 1, text: "API" }));

    expect(all).toHaveLength(2);
    expect(filtered.map((value) => value.text)).toEqual(["API"]);
    expect(foreign).toHaveLength(0);
  });

  it("구독 해제 후에는 전달하지 않고 handler 오류는 다른 구독자에게 전파하지 않는다", () => {
    const registry = new ExecutionStreamRegistry();
    const received: ExecutionDelta[] = [];
    const unsubscribe = registry.subscribe(context, {}, () => {
      throw new Error("handler 오류");
    });
    registry.subscribe(context, {}, (value) => received.push(value));

    registry.observe(context, delta({ executionId: "execution-1", sequence: 1 }));
    expect(received).toHaveLength(1);

    unsubscribe();
    registry.observe(context, delta({ executionId: "execution-1", sequence: 2 }));
    expect(received).toHaveLength(2);
    expect(registry.size).toBe(1);
  });

  it("구독자 상한을 넘으면 거부한다", () => {
    const registry = new ExecutionStreamRegistry({ maxSubscribers: 1 });
    registry.subscribe(context, {}, () => undefined);
    expect(() => registry.subscribe(context, {}, () => undefined)).toThrow("실행 스트림 구독 상한");
  });
});
