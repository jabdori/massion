import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { CodeChangeAssuranceRecipeResolver } from "./software-assurance-recipe.js";

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const context = {
  organizationId: "organization-1",
  userId: "user-1",
  membershipId: "membership-1",
  role: "owner" as const,
};

const plan = JSON.stringify({
  objective: "변경을 검증한다",
  summary: "독립 검증 명령을 실행한다",
  scopeIn: [],
  scopeOut: [],
  assumptions: [],
  unknowns: [],
  acceptanceCriteria: [
    {
      key: "artifact-created",
      statement: "변경 산출물이 생성된다",
      method: "evidence",
      evidenceKinds: ["artifact-version"],
      planLevel: false,
    },
  ],
  risks: [],
  tasks: [
    {
      key: "deliver",
      title: "전달",
      objective: "변경을 만든다",
      criterionKeys: ["artifact-created"],
      dependencyKeys: [],
      requiredCapabilities: [],
      recommendedAgentHandles: ["software-engineering"],
      parallelizable: false,
    },
  ],
  evidenceRequests: [],
});

function recovery(recipe: unknown) {
  const contentJson = JSON.stringify({
    schemaVersion: "massion.code-change-manifest.v1",
    deliveryId: "delivery-1",
    repositoryId: "repository-1",
    repositoryRevisionId: "revision-1",
    baseRevision: "a".repeat(40),
    branchRef: "refs/heads/massion/delivery-1",
    commitSha: "b".repeat(40),
    changeSetHash: "c".repeat(64),
    evidence: { red: "red-1", green: "green-1", validations: ["validation-1"] },
    assuranceRecipe: recipe,
    files: [],
  });
  return {
    artifacts: [{ artifact_id: "artifact-1", kind: "code-change" }],
    artifactVersions: [
      {
        artifact_version_id: "artifact-version-1",
        artifact_id: "artifact-1",
        checksum: checksum(contentJson),
        media_type: "application/vnd.massion.code-change-manifest+json",
        content_json: contentJson,
      },
    ],
    tasks: [],
  };
}

describe("Software assurance recipe resolver", () => {
  it("안전한 code-change recipe를 독립 재실행 binding으로 바꾼다", async () => {
    const resolved = await new CodeChangeAssuranceRecipeResolver().resolve(context, {
      workId: "work-1",
      planContentJson: plan,
      recovery: recovery({
        schemaVersion: "massion.software-assurance-recipe.v1",
        focusedCommand: {
          executable: "node",
          args: ["--test", "src/value.test.mjs"],
          cwd: ".",
          timeoutMs: 60_000,
          maxOutputBytes: 1_000_000,
        },
        validationCommands: [
          {
            executable: "node",
            args: ["--test", "src"],
            cwd: ".",
            timeoutMs: 60_000,
            maxOutputBytes: 1_000_000,
          },
        ],
      }) as never,
    });

    expect(resolved).toMatchObject({
      requiredCriteria: expect.arrayContaining([
        { criterionKey: "artifact-created", method: "evidence" },
        { criterionKey: "profile:software:correctness", method: "test" },
        { criterionKey: "profile:software:security", method: "inspection" },
      ]),
      bindings: expect.arrayContaining([
        expect.objectContaining({
          bindingKey: "software-correctness",
          executable: "node",
          args: ["--test", "src/value.test.mjs"],
          requiredEvidenceKinds: ["command-output", "code-change"],
        }),
        expect.objectContaining({
          bindingKey: "software-security",
          inspectorProfile: "massion.software-security-scan.v1",
          evidenceAllowlist: ["artifact-version-1"],
        }),
      ]),
    });
  });

  it("비밀값 또는 checksum이 맞지 않는 recipe는 binding으로 바꾸지 않는다", async () => {
    const resolver = new CodeChangeAssuranceRecipeResolver();
    const unsafe = recovery({
      schemaVersion: "massion.software-assurance-recipe.v1",
      focusedCommand: {
        executable: "node",
        args: ["-e", "process.stdout.write('sk-abcdefghijklmnopqrstuvwxyz123456')"],
        cwd: ".",
        timeoutMs: 60_000,
        maxOutputBytes: 1_000_000,
      },
      validationCommands: [],
    });
    await expect(
      resolver.resolve(context, { workId: "work-1", planContentJson: plan, recovery: unsafe as never }),
    ).resolves.toBeUndefined();

    const changed = recovery({
      schemaVersion: "massion.software-assurance-recipe.v1",
      focusedCommand: {
        executable: "node",
        args: ["--test", "src/value.test.mjs"],
        cwd: ".",
        timeoutMs: 60_000,
        maxOutputBytes: 1_000_000,
      },
    validationCommands: [],
  });
    const version0 = changed.artifactVersions[0];
    if (version0) version0.checksum = "0".repeat(64);
  await expect(
      resolver.resolve(context, { workId: "work-1", planContentJson: plan, recovery: changed as never }),
    ).resolves.toBeUndefined();
  });
});
