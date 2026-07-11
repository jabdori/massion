import { readFileSync } from "node:fs";
import { validateExtensionManifest } from "@massion/extension-sdk";
import { describe, expect, it } from "vitest";
import { invokeGitHub } from "./connector.js";
const repository = { full_name: "massion/project" };
const sender = { id: 12345678 };
describe("GitHub 공식 Extension", () => {
  it("manifest·고정 API origin·permission을 검증한다", () => {
    const manifest = validateExtensionManifest(
      JSON.parse(readFileSync(new URL("../massion.extension.json", import.meta.url), "utf8")) as unknown,
    );
    expect(manifest.name).toBe("@massion-ext/github");
    expect(manifest.permissions.network[0]?.origin).toBe("https://api.github.com");
  });
  it("Issue와 /massion comment를 Work action으로 정규화한다", async () => {
    await expect(
      invokeGitHub("surfaceConnectors:github", {
        event: "issues",
        action: "opened",
        repository,
        sender,
        issue: { number: 42, title: "실패 수정", body: "재현 절차" },
      }),
    ).resolves.toMatchObject({
      operation: "work.create",
      arguments: { external: { kind: "github-issue", number: 42 } },
    });
    await expect(
      invokeGitHub("surfaceConnectors:github", {
        event: "issue_comment",
        action: "created",
        repository,
        sender,
        comment: { id: 9, body: "/massion 테스트를 추가해" },
      }),
    ).resolves.toMatchObject({ operation: "work.create", arguments: { request: "테스트를 추가해" } });
  });
  it("PR·Check·Records·Release 요청을 고정 REST API 계약으로 만든다", async () => {
    await expect(
      invokeGitHub("eventConsumers:github-sync", {
        kind: "pull-request",
        owner: "massion",
        repo: "project",
        title: "feat: change",
        head: "feature",
        base: "main",
        body: "검증 완료",
      }),
    ).resolves.toMatchObject({
      method: "POST",
      path: "/repos/massion/project/pulls",
      headers: { apiVersion: "2026-03-10" },
    });
    await expect(
      invokeGitHub("eventConsumers:github-sync", {
        kind: "check-run",
        owner: "massion",
        repo: "project",
        headSha: "a".repeat(40),
        name: "Massion Assurance",
        status: "completed",
        conclusion: "success",
        output: { title: "통과", summary: "0 findings" },
        externalId: "verification-1",
      }),
    ).resolves.toMatchObject({ path: "/repos/massion/project/check-runs" });
    await expect(
      invokeGitHub("eventConsumers:github-sync", {
        kind: "materialize",
        owner: "massion",
        repo: "project",
        path: "docs/record.md",
        message: "docs: record",
        contentBase64: "IyBSZWNvcmQ=",
        sha: undefined,
      }),
    ).resolves.toMatchObject({ method: "PUT", path: "/repos/massion/project/contents/docs/record.md" });
  });
  it("repository·path·SHA 주입을 거부한다", async () => {
    await expect(
      invokeGitHub("surfaceConnectors:github", {
        event: "issues",
        action: "opened",
        repository: { full_name: "../secret" },
        sender,
        issue: { number: 1, title: "x" },
      }),
    ).rejects.toThrow("유효하지");
    await expect(
      invokeGitHub("eventConsumers:github-sync", {
        kind: "materialize",
        owner: "massion",
        repo: "project",
        path: "../secret",
        message: "x",
        contentBase64: "eA==",
      }),
    ).rejects.toThrow("path");
  });
});
