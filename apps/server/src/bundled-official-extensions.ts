import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { inspectExtensionArchive, type ExtensionRuntimeVersions } from "@massion/extension-host";
import type { IdentityService, OrganizationService } from "@massion/identity";
import type { ArtifactStore, RegistryAssessment, SurrealRegistryStore } from "@massion/registry";

const OFFICIAL_EMAIL = "extensions@massion.local";
const OFFICIAL_PACKAGES = new Set(["@massion-ext/slack", "@massion-ext/discord", "@massion-ext/github"]);
const PASSED_ASSESSMENT: RegistryAssessment = {
  archive: "pass",
  provenance: "pass",
  sbom: "pass",
  vulnerability: "pass",
  contract: "pass",
  policy: "pass",
};

interface BundledExtension {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly archive: string;
  readonly artifactDigest: string;
}

function manifest(value: unknown): readonly BundledExtension[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > OFFICIAL_PACKAGES.size)
    throw new Error("공식 Extension manifest가 유효하지 않습니다");
  const entries = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("공식 Extension 항목이 유효하지 않습니다");
    const entry = item as Record<string, unknown>;
    if (
      typeof entry.packageName !== "string" ||
      typeof entry.packageVersion !== "string" ||
      typeof entry.archive !== "string" ||
      typeof entry.artifactDigest !== "string" ||
      !OFFICIAL_PACKAGES.has(entry.packageName) ||
      !/^[a-f0-9]{64}$/u.test(entry.artifactDigest) ||
      entry.archive !== entry.archive.split("/").pop() ||
      !entry.archive.endsWith(".tgz")
    )
      throw new Error("공식 Extension manifest 항목이 유효하지 않습니다");
    return entry as unknown as BundledExtension;
  });
  if (new Set(entries.map((entry) => entry.packageName)).size !== entries.length)
    throw new Error("공식 Extension manifest에 중복 package가 있습니다");
  return entries;
}

export async function seedBundledOfficialExtensions(input: {
  readonly root: string;
  readonly identities: IdentityService;
  readonly organizations: OrganizationService;
  readonly versions: SurrealRegistryStore;
  readonly artifacts: ArtifactStore;
  readonly runtime: ExtensionRuntimeVersions;
}): Promise<void> {
  const root = resolve(input.root);
  const entries = manifest(JSON.parse(await readFile(join(root, "official-extensions.json"), "utf8")) as unknown);
  const registration = await input.identities.registerPersonalUser({ email: OFFICIAL_EMAIL, displayName: "Massion Extensions" });
  const context = await input.organizations.resolveTenantContext(registration.user.user_id, registration.organization.organization_id);
  const current = await input.versions.catalogStore().list();
  for (const entry of entries) {
    const archive = await readFile(join(root, entry.archive));
    const digest = createHash("sha256").update(archive).digest("hex");
    if (digest !== entry.artifactDigest) throw new Error(`공식 Extension artifact digest가 일치하지 않습니다: ${entry.packageName}`);
    const inspected = await inspectExtensionArchive(archive, { runtime: input.runtime });
    if (inspected.manifest.name !== entry.packageName || inspected.manifest.version !== entry.packageVersion)
      throw new Error(`공식 Extension artifact identity가 일치하지 않습니다: ${entry.packageName}`);
    const existing = current.find(
      (version) => version.packageName === entry.packageName && version.packageVersion === entry.packageVersion,
    );
    if (existing) {
      if (existing.artifactDigest !== digest || existing.state !== "published")
        throw new Error(`공식 Extension Registry 상태가 일치하지 않습니다: ${entry.packageName}`);
      continue;
    }
    await input.artifacts.put(digest, archive);
    const staged = await input.versions.stage(context, `official-seed-${entry.packageName.slice("@massion-ext/".length)}-${entry.packageVersion}`, {
      packageName: entry.packageName,
      packageVersion: entry.packageVersion,
      artifactDigest: digest,
      contentDigest: inspected.contentDigest,
      visibility: "public",
      ownerOrganizationId: context.organizationId,
      manifest: inspected.manifest as unknown as Readonly<Record<string, unknown>>,
    });
    await input.versions.recordAssessment(context, staged.versionId, PASSED_ASSESSMENT);
    await input.versions.publish(context, staged.versionId, `official-seed-${entry.packageName.slice("@massion-ext/".length)}-${entry.packageVersion}`);
  }
}
