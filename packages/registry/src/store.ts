import { createHash, randomUUID } from "node:crypto";

import {
  assessmentPassed,
  assertDigest,
  assertRegistryId,
  normalizePackageIdentity,
  transitionVersion,
  type RegistryAssessment,
  type RegistryRecall,
  type RegistryVersion,
  type RegistryVersionInput,
} from "./contracts.js";

function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

const hash = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");

export class MemoryRegistryStore {
  private readonly versions = new Map<string, RegistryVersion>();
  private readonly identities = new Map<string, string>();
  private readonly commands = new Map<string, { requestHash: string; versionId: string }>();
  private readonly recalls = new Map<string, RegistryRecall[]>();

  public async stage(commandId: string, input: RegistryVersionInput): Promise<RegistryVersion> {
    assertRegistryId(commandId, "commandId");
    normalizePackageIdentity(input.packageName, input.packageVersion);
    assertDigest(input.artifactDigest, "artifact");
    assertDigest(input.contentDigest, "content");
    assertRegistryId(input.ownerOrganizationId, "owner organization");
    const requestHash = hash(input);
    const replay = this.commands.get(commandId);
    if (replay) {
      if (replay.requestHash !== requestHash) throw new Error("같은 commandId에 다른 Registry 요청을 사용할 수 없습니다");
      return structuredClone(this.required(replay.versionId));
    }
    const identity = `${input.packageName}@${input.packageVersion}`;
    const existingId = this.identities.get(identity);
    if (existingId) {
      const existing = this.required(existingId);
      if (existing.artifactDigest !== input.artifactDigest)
        throw new Error("같은 package version에 다른 artifact digest를 게시할 수 없습니다");
      throw new Error("같은 package version은 다른 command로 다시 stage할 수 없습니다");
    }
    const version: RegistryVersion = {
      ...structuredClone(input),
      versionId: randomUUID(),
      state: "staged",
      createdAt: new Date().toISOString(),
    };
    this.versions.set(version.versionId, version);
    this.identities.set(identity, version.versionId);
    this.commands.set(commandId, { requestHash, versionId: version.versionId });
    return structuredClone(version);
  }

  public async recordAssessment(versionId: string, assessment: RegistryAssessment): Promise<RegistryVersion> {
    const current = this.required(versionId);
    if (current.state !== "staged") throw new Error("staged version만 검사 결과를 기록할 수 있습니다");
    const next = { ...current, assessment: structuredClone(assessment) };
    this.versions.set(versionId, next);
    return structuredClone(next);
  }

  public async publish(versionId: string, decisionId: string): Promise<RegistryVersion> {
    assertRegistryId(decisionId, "decision");
    const current = this.required(versionId);
    if (!assessmentPassed(current.assessment)) throw new Error("모든 Registry 검사가 통과해야 공개할 수 있습니다");
    const next: RegistryVersion = {
      ...current,
      state: transitionVersion(current.state, "published"),
      publishedByDecisionId: decisionId,
      publishedAt: new Date().toISOString(),
    };
    this.versions.set(versionId, next);
    return structuredClone(next);
  }

  public async recall(versionId: string, recall: RegistryRecall): Promise<RegistryVersion> {
    assertRegistryId(recall.recallId, "recall");
    if (recall.reason.length < 3 || recall.reason.length > 2048) throw new Error("recall reason이 유효하지 않습니다");
    const current = this.required(versionId);
    const events = this.recalls.get(versionId) ?? [];
    if (events.some((event) => event.recallId === recall.recallId)) throw new Error("recall 사건이 이미 존재합니다");
    events.push({ ...structuredClone(recall), createdAt: recall.createdAt ?? new Date().toISOString() });
    this.recalls.set(versionId, events);
    const next = { ...current, state: transitionVersion(current.state, "recalled") };
    this.versions.set(versionId, next);
    return structuredClone(next);
  }

  public async get(versionId: string): Promise<RegistryVersion> {
    return structuredClone(this.required(versionId));
  }

  public async list(): Promise<readonly RegistryVersion[]> {
    return [...this.versions.values()].map((version) => structuredClone(version));
  }

  public async listRecalls(versionId: string): Promise<readonly RegistryRecall[]> {
    return structuredClone(this.recalls.get(versionId) ?? []);
  }

  private required(versionId: string): RegistryVersion {
    const version = this.versions.get(versionId);
    if (!version) throw new Error("Registry version을 찾을 수 없습니다");
    return version;
  }
}
