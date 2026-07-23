import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { ApplicationClient } from "./client.js";
import type {
  ApplicationCommandMapV1,
  ApplicationCommandResultV1,
  ApplicationQueryMapV1,
  ApprovalViewV1,
  ArtifactViewV1,
  AssignmentViewV1,
  CursorPageV1,
  DirectiveViewV1,
  ExecutionViewV1,
  RunViewV1,
  StartRunRequestV1,
  TaskViewV1,
  VerificationViewV1,
  WorkActivityViewV1,
  WorkDetailV1,
  WorkSummaryV1,
} from "./client.js";

type DesktopClientContract = {
  readonly approval: ApprovalViewV1;
  readonly artifact: ArtifactViewV1;
  readonly assignment: AssignmentViewV1;
  readonly directive: DirectiveViewV1;
  readonly execution: ExecutionViewV1;
  readonly run: RunViewV1;
  readonly task: TaskViewV1;
  readonly verification: VerificationViewV1;
  readonly activity: WorkActivityViewV1;
  readonly work: WorkDetailV1 | WorkSummaryV1;
  readonly request: StartRunRequestV1;
  readonly page: CursorPageV1<WorkSummaryV1>;
  readonly queries: ApplicationQueryMapV1;
  readonly commands: ApplicationCommandMapV1;
  readonly result: ApplicationCommandResultV1;
};

describe("ApplicationClient", () => {
  it("Desktop DTO를 client 전용 진입점에서 type-only로 공개한다", () => {
    const contract: DesktopClientContract | undefined = undefined;
    expect(contract).toBeUndefined();
  });

  it("client 진입점은 backend runtime graph를 다시 export하지 않는다", async () => {
    const [clientSource, contractsSource] = await Promise.all([
      readFile(new URL("./client.ts", import.meta.url), "utf8"),
      readFile(new URL("./contracts.ts", import.meta.url), "utf8"),
    ]);

    expect(clientSource).toContain("export type {");
    expect(clientSource).not.toMatch(/from\s+["']@massion\//u);
    expect(clientSource).not.toMatch(/export\s+\*\s+from/u);
    expect(clientSource).not.toMatch(/from\s+["']\.\/(?:artifacts|index|product|http-server)\.js["']/u);
    expect(
      contractsSource
        .split("\n")
        .filter((line) => line.includes('from "@massion/') && !line.trimStart().startsWith("import type")),
    ).toEqual([]);
  });

  it("typed query 응답의 operation을 확인하고 data만 반환한다", async () => {
    const transport = {
      query: vi.fn().mockResolvedValue({
        schemaVersion: "massion.application.v1",
        operation: "work.index",
        data: { items: [], nextCursor: undefined },
      }),
      command: vi.fn(),
    };
    const client = new ApplicationClient(transport);

    await expect(client.query("work.index", { limit: 50 })).resolves.toEqual({
      items: [],
      nextCursor: undefined,
    });
    expect(transport.query).toHaveBeenCalledWith("work.index", { limit: 50 });
  });

  it("command envelope을 생성하고 검증된 공개 결과만 반환한다", async () => {
    const transport = {
      query: vi.fn(),
      command: vi.fn().mockImplementation(async (input: { commandId: string; correlationId: string }) => ({
        schemaVersion: "massion.application.v1",
        commandId: input.commandId,
        correlationId: input.correlationId,
        operation: "run.start",
        outcome: "accepted",
        data: { runId: "run-client-0001", status: "ready", stage: "intake" },
      })),
    };
    const ids = vi.fn().mockReturnValueOnce("command-client-0001").mockReturnValueOnce("correlation-client-0001");
    const client = new ApplicationClient(transport, ids);

    await expect(
      client.command("run.start", { request: { text: "고객 이탈 원인을 분석해 주세요" } }),
    ).resolves.toMatchObject({ operation: "run.start", outcome: "accepted" });
    expect(transport.command).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: "command-client-0001",
        correlationId: "correlation-client-0001",
        operation: "run.start",
      }),
    );
  });

  it("Node Buffer 전역이 없는 WebView에서도 command 계약을 검증한다", async () => {
    const transport = {
      query: vi.fn(),
      command: vi.fn().mockImplementation(async (input: { commandId: string; correlationId: string }) => ({
        schemaVersion: "massion.application.v1",
        commandId: input.commandId,
        correlationId: input.correlationId,
        operation: "run.start",
        outcome: "accepted",
        data: { runId: "run-client-browser-0001", status: "ready", stage: "intake" },
      })),
    };
    const ids = vi
      .fn()
      .mockReturnValueOnce("command-client-browser-0001")
      .mockReturnValueOnce("correlation-client-browser-0001");
    const client = new ApplicationClient(transport, ids);
    let result: ApplicationCommandResultV1 | undefined;

    vi.stubGlobal("Buffer", undefined);
    try {
      result = await client.command("run.start", { request: { text: "고객 이탈 원인을 분석해 주세요" } });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(result).toMatchObject({ operation: "run.start", outcome: "accepted" });
  });

  it("query operation 불일치와 malformed command 결과를 거부한다", async () => {
    const client = new ApplicationClient({
      query: async () => ({
        schemaVersion: "massion.application.v1",
        operation: "work.detail",
        data: {},
      }),
      command: async () => ({ token: "노출되면 안 되는 값" }),
    });

    await expect(client.query("work.index", {})).rejects.toThrow("operation");
    await expect(client.command("run.cancel", { runId: "run-client-0001" })).rejects.toThrow();
  });

  it("Work 승인 목록도 typed query로 조회한다", async () => {
    const transport = {
      query: vi.fn().mockResolvedValue({
        schemaVersion: "massion.application.v1",
        operation: "governance.approval.list",
        data: [{ approvalId: "approval-client-1", status: "pending" }],
      }),
      command: vi.fn(),
    };
    const client = new ApplicationClient(transport);

    await expect(
      client.query("governance.approval.list", { workId: "work-client-1", status: "pending" }),
    ).resolves.toEqual([{ approvalId: "approval-client-1", status: "pending" }]);
  });
});
