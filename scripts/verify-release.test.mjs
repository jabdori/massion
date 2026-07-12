import assert from "node:assert/strict";
import { test } from "node:test";

import { restoreEnvironmentForRelease } from "./verify-release.mjs";

test("복원 release server는 격리된 Connector root를 명시한다", () => {
  const environment = restoreEnvironmentForRelease(
    { PATH: "/usr/bin", MASSION_PREFIX: "/tmp/prefix" },
    {
      databaseUrl: "rocksdb:///tmp/restore.db",
      tokenKeyFile: "/tmp/token-key",
      credentialKeyFile: "/tmp/credential-key",
      workspaceRoot: "/tmp/restore-workspaces",
      connectorRoot: "/tmp/restore-connectors",
    },
  );

  assert.equal(environment.MASSION_CONNECTOR_ROOT, "/tmp/restore-connectors");
  assert.equal(environment.MASSION_SOFTWARE_WORKSPACE_ROOT, "/tmp/restore-workspaces");
  assert.equal(environment.MASSION_DATABASE_URL, "rocksdb:///tmp/restore.db");
  assert.equal(environment.PATH, "/usr/bin");
});
