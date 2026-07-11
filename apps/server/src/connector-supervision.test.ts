import { describe, expect, it } from "vitest";

import {
  ConnectorProcessSupervisor,
  type ConnectorChildHandle,
  type ConnectorProcessLauncher,
} from "./connector-supervision.js";

class TestChild implements ConnectorChildHandle {
  public stopped = false;

  public async stop(): Promise<void> {
    this.stopped = true;
  }
}

class TestLauncher implements ConnectorProcessLauncher {
  public readonly starts: Array<{ executable: string; args: readonly string[]; profileRoot: string }> = [];
  public readonly children: TestChild[] = [];

  public async start(input: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly profileRoot: string;
    readonly environment: Readonly<Record<string, string>>;
  }): Promise<ConnectorChildHandle> {
    this.starts.push(input);
    const child = new TestChild();
    this.children.push(child);
    return child;
  }
}

describe("서버 Connector process supervision", () => {
  it("허용된 실행 파일만 계정별 profile로 시작하고 graceful shutdown한다", async () => {
    const launcher = new TestLauncher();
    const supervisor = new ConnectorProcessSupervisor(launcher, {
      executableAllowlist: { codex: "/opt/massion/connectors/codex" },
      profileRoot: "/var/lib/massion/connectors",
      heartbeatTimeoutMs: 30_000,
      stopTimeoutMs: 5_000,
    });

    await supervisor.start({ connectorId: "connector-1", accountId: "account-1", executableId: "codex", args: [] });
    expect(launcher.starts).toEqual([
      expect.objectContaining({
        executable: "/opt/massion/connectors/codex",
        profileRoot: "/var/lib/massion/connectors/account-1",
      }),
    ]);
    await expect(
      supervisor.start({ connectorId: "connector-2", accountId: "account-2", executableId: "unknown", args: [] }),
    ).rejects.toThrow("허용되지 않은");

    await supervisor.shutdown();
    expect(launcher.children[0]?.stopped).toBe(true);
  });

  it("heartbeat가 만료된 process를 중지하고 offline으로 보고한다", async () => {
    let now = 0;
    const launcher = new TestLauncher();
    const offline: string[] = [];
    const supervisor = new ConnectorProcessSupervisor(launcher, {
      executableAllowlist: { claude: "/opt/massion/connectors/claude" },
      profileRoot: "/var/lib/massion/connectors",
      heartbeatTimeoutMs: 30_000,
      stopTimeoutMs: 5_000,
      now: () => now,
      onOffline: (connectorId) => {
        offline.push(connectorId);
      },
    });
    await supervisor.start({ connectorId: "connector-1", accountId: "account-1", executableId: "claude", args: [] });
    now = 30_001;

    await expect(supervisor.expire()).resolves.toBe(1);
    expect(offline).toEqual(["connector-1"]);
    expect(launcher.children[0]?.stopped).toBe(true);
  });
});
