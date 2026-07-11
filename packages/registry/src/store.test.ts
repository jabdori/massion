import { describe, expect, it } from "vitest";

import { MemoryRegistryStore } from "./store.js";

const version = {
  packageName: "@massion-ext/github",
  packageVersion: "1.0.0",
  artifactDigest: "a".repeat(64),
  contentDigest: "b".repeat(64),
  visibility: "public" as const,
  ownerOrganizationId: "org-1",
  manifest: { description: "GitHub", compatibility: { agentOS: "^1.0.0", node: ">=24" } },
};

describe("Registry immutable store", () => {
  it("동일 command는 replay하고 같은 version의 다른 digest는 거부한다", async () => {
    const store = new MemoryRegistryStore();
    const first = await store.stage("command-0001", version);
    const replay = await store.stage("command-0001", version);
    expect(replay).toEqual(first);
    await expect(store.stage("command-0002", { ...version, artifactDigest: "c".repeat(64) })).rejects.toThrow(
      "다른 artifact",
    );
  });

  it("검사 통과 전 공개와 공개 전 리콜을 거부하고 사건을 append-only로 보존한다", async () => {
    const store = new MemoryRegistryStore();
    const staged = await store.stage("command-0001", version);
    await expect(store.publish(staged.versionId, "decision-1")).rejects.toThrow("검사");
    await store.recordAssessment(staged.versionId, {
      archive: "pass",
      provenance: "pass",
      sbom: "pass",
      vulnerability: "pass",
      contract: "pass",
      policy: "pass",
    });
    await store.publish(staged.versionId, "decision-1");
    await store.recall(staged.versionId, {
      recallId: "recall-1",
      category: "security",
      severity: "critical",
      reason: "CVE-2099-0001",
    });
    expect((await store.get(staged.versionId)).state).toBe("recalled");
    expect(await store.listRecalls(staged.versionId)).toHaveLength(1);
    await expect(store.publish(staged.versionId, "decision-2")).rejects.toThrow("상태 전이");
  });
});
