import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { OrganizationService, TenantContext } from "@massion/identity";
import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import type { ExtensionArtifactReport } from "./contracts.js";
import { EXTENSION_MIGRATIONS } from "./schema.js";

type TrustLevel = "built-in" | "verified" | "community" | "untrusted-local";
type SourceKind = "bundled" | "registry" | "tarball" | "link";

interface InstallationRecord {
  readonly installation_id: string;
  readonly organization_id: string;
  readonly package_name: string;
  readonly state: "inactive" | "active" | "disabled" | "blocked";
  readonly active_version_id?: string;
  readonly activation_generation: number;
}

interface VersionRecord {
  readonly version_id: string;
  readonly organization_id: string;
  readonly installation_id: string;
  readonly package_name: string;
  readonly package_version: string;
  readonly artifact_digest: string;
  readonly content_digest: string;
  readonly manifest_json: string;
  readonly manifest_digest: string;
  readonly permission_json: string;
  readonly permission_digest: string;
  readonly trust_level: TrustLevel;
  readonly source_kind: SourceKind;
  readonly command_id: string;
  readonly request_hash: string;
}

interface ActivationRecord {
  readonly activation_id: string;
  readonly organization_id: string;
  readonly installation_id: string;
  readonly after_version_id: string;
  readonly command_id: string;
  readonly request_hash: string;
}

export interface ExtensionVersionView {
  readonly versionId: string;
  readonly installationId: string;
  readonly organizationId: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly artifactDigest: string;
  readonly contentDigest: string;
  readonly manifestDigest: string;
  readonly permissionDigest: string;
  readonly trustLevel: TrustLevel;
  readonly sourceKind: SourceKind;
  readonly activationGeneration: number;
}

export interface ExtensionInstallationView {
  readonly installationId: string;
  readonly organizationId: string;
  readonly packageName: string;
  readonly state: InstallationRecord["state"];
  readonly activeVersionId?: string;
  readonly activationGeneration: number;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function first<T>(
  executor: QueryExecutor,
  query: string,
  bindings: Record<string, unknown>,
): Promise<T | undefined> {
  const [records] = await executor.query<[T[]]>(query, bindings);
  return records[0];
}

export class ExtensionStore {
  private constructor(
    private readonly database: MassionDatabase,
    private readonly organizations: OrganizationService,
  ) {}

  public static async create(database: MassionDatabase, organizations: OrganizationService): Promise<ExtensionStore> {
    await applyMigrations(database, EXTENSION_MIGRATIONS);
    return new ExtensionStore(database, organizations);
  }

  public async registerVersion(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly artifact: ExtensionArtifactReport;
      readonly trustLevel: TrustLevel;
      readonly sourceKind: SourceKind;
    },
  ): Promise<ExtensionVersionView> {
    await this.organizations.verifyTenantContext(context);
    const manifestJson = canonicalJson(input.artifact.manifest);
    const permissionJson = canonicalJson(input.artifact.manifest.permissions);
    const requestHash = sha256(
      canonicalJson({
        artifactDigest: input.artifact.artifactDigest,
        contentDigest: input.artifact.contentDigest,
        manifestDigest: sha256(manifestJson),
        permissionDigest: sha256(permissionJson),
        sourceKind: input.sourceKind,
        trustLevel: input.trustLevel,
      }),
    );
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const repeated = await first<VersionRecord>(
        transaction,
        "SELECT * OMIT id FROM extension_version WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
        { organization_id: context.organizationId, command_id: input.commandId },
      );
      if (repeated) {
        if (repeated.request_hash !== requestHash)
          throw new Error("같은 commandId에 다른 Extension 요청을 사용할 수 없습니다");
        const installation = await this.installation(transaction, context.organizationId, repeated.installation_id);
        return this.versionView(repeated, installation.activation_generation);
      }
      const packageName = input.artifact.manifest.name;
      let installation = await first<InstallationRecord>(
        transaction,
        "SELECT * OMIT id FROM extension_installation WHERE organization_id = $organization_id AND package_name = $package_name LIMIT 1;",
        { organization_id: context.organizationId, package_name: packageName },
      );
      if (!installation) {
        const installationId = randomUUID();
        installation = await first<InstallationRecord>(
          transaction,
          "CREATE extension_installation CONTENT { installation_id: $installation_id, organization_id: $organization_id, package_name: $package_name, state: 'inactive', active_version_id: NONE, activation_generation: 0, created_at: time::now(), updated_at: time::now() } RETURN AFTER;",
          {
            installation_id: installationId,
            organization_id: context.organizationId,
            package_name: packageName,
          },
        );
        if (!installation) throw new Error("Extension installation 생성 결과가 없습니다");
      }
      const conflict = await first<VersionRecord>(
        transaction,
        "SELECT * OMIT id FROM extension_version WHERE organization_id = $organization_id AND package_name = $package_name AND package_version = $package_version LIMIT 1;",
        {
          organization_id: context.organizationId,
          package_name: packageName,
          package_version: input.artifact.manifest.version,
        },
      );
      if (conflict) {
        if (conflict.artifact_digest !== input.artifact.artifactDigest) {
          throw new Error("같은 package version에 다른 artifact digest를 설치할 수 없습니다");
        }
        throw new Error("같은 package version은 다른 command로 다시 등록할 수 없습니다");
      }
      const versionId = randomUUID();
      const version = await first<VersionRecord>(
        transaction,
        "CREATE extension_version CONTENT { version_id: $version_id, organization_id: $organization_id, installation_id: $installation_id, package_name: $package_name, package_version: $package_version, artifact_digest: $artifact_digest, content_digest: $content_digest, artifact_size: $artifact_size, manifest_json: $manifest_json, manifest_digest: $manifest_digest, permission_json: $permission_json, permission_digest: $permission_digest, trust_level: $trust_level, source_kind: $source_kind, command_id: $command_id, request_hash: $request_hash, created_by_user_id: $created_by_user_id, created_at: time::now() } RETURN AFTER;",
        {
          version_id: versionId,
          organization_id: context.organizationId,
          installation_id: installation.installation_id,
          package_name: packageName,
          package_version: input.artifact.manifest.version,
          artifact_digest: input.artifact.artifactDigest,
          content_digest: input.artifact.contentDigest,
          artifact_size: input.artifact.files.reduce((total, file) => total + file.size, 0),
          manifest_json: manifestJson,
          manifest_digest: sha256(manifestJson),
          permission_json: permissionJson,
          permission_digest: sha256(permissionJson),
          trust_level: input.trustLevel,
          source_kind: input.sourceKind,
          command_id: input.commandId,
          request_hash: requestHash,
          created_by_user_id: context.userId,
        },
      );
      if (!version) throw new Error("Extension version 생성 결과가 없습니다");
      await this.event(transaction, {
        organizationId: context.organizationId,
        installationId: installation.installation_id,
        versionId,
        commandId: input.commandId,
        eventType: "version_registered",
        payload: { artifactDigest: input.artifact.artifactDigest, packageVersion: input.artifact.manifest.version },
      });
      return this.versionView(version, installation.activation_generation);
    });
  }

  public async activateVersion(
    context: TenantContext,
    input: {
      readonly commandId: string;
      readonly versionId: string;
      readonly expectedGeneration: number;
      readonly governanceDecisionIds: readonly string[];
      readonly healthReceipt: Readonly<Record<string, unknown>>;
      readonly sandboxReceipt?: Readonly<Record<string, unknown>>;
      readonly outcome?: "activated" | "rolled-back";
    },
  ): Promise<ExtensionInstallationView> {
    await this.organizations.verifyTenantContext(context);
    const requestHash = sha256(canonicalJson(input));
    return await this.database.transaction(async (transaction) => {
      await this.organizations.verifyTenantContext(context, undefined, transaction);
      const repeated = await first<ActivationRecord>(
        transaction,
        "SELECT * OMIT id FROM extension_activation WHERE organization_id = $organization_id AND command_id = $command_id LIMIT 1;",
        { organization_id: context.organizationId, command_id: input.commandId },
      );
      if (repeated) {
        if (repeated.request_hash !== requestHash)
          throw new Error("같은 commandId에 다른 activation 요청을 사용할 수 없습니다");
        return this.installationView(
          await this.installation(transaction, context.organizationId, repeated.installation_id),
        );
      }
      const version = await this.findVersion(transaction, context.organizationId, input.versionId);
      const installation = await this.installation(transaction, context.organizationId, version.installation_id);
      if (installation.activation_generation !== input.expectedGeneration) {
        throw new Error("Extension activation generation precondition이 일치하지 않습니다");
      }
      const afterGeneration = installation.activation_generation + 1;
      const activationId = randomUUID();
      await transaction.query(
        "UPDATE extension_installation SET state = 'active', active_version_id = $version_id, activation_generation = $after_generation, updated_at = time::now() WHERE organization_id = $organization_id AND installation_id = $installation_id AND activation_generation = $before_generation;",
        {
          organization_id: context.organizationId,
          installation_id: installation.installation_id,
          version_id: version.version_id,
          before_generation: installation.activation_generation,
          after_generation: afterGeneration,
        },
      );
      const updated = await this.installation(transaction, context.organizationId, installation.installation_id);
      if (updated.activation_generation !== afterGeneration || updated.active_version_id !== version.version_id) {
        throw new Error("Extension activation generation 동시성 충돌입니다");
      }
      await transaction.query(
        "CREATE extension_activation CONTENT { activation_id: $activation_id, organization_id: $organization_id, installation_id: $installation_id, before_version_id: $before_version_id, after_version_id: $after_version_id, before_generation: $before_generation, after_generation: $after_generation, command_id: $command_id, request_hash: $request_hash, governance_decision_ids: $governance_decision_ids, health_receipt_json: $health_receipt_json, sandbox_receipt_json: $sandbox_receipt_json, outcome: $outcome, activated_by_user_id: $activated_by_user_id, created_at: time::now() };",
        {
          activation_id: activationId,
          organization_id: context.organizationId,
          installation_id: installation.installation_id,
          before_version_id: installation.active_version_id,
          after_version_id: version.version_id,
          before_generation: installation.activation_generation,
          after_generation: afterGeneration,
          command_id: input.commandId,
          request_hash: requestHash,
          governance_decision_ids: [...input.governanceDecisionIds],
          health_receipt_json: canonicalJson(input.healthReceipt),
          sandbox_receipt_json: input.sandboxReceipt ? canonicalJson(input.sandboxReceipt) : undefined,
          outcome: input.outcome ?? "activated",
          activated_by_user_id: context.userId,
        },
      );
      await this.event(transaction, {
        organizationId: context.organizationId,
        installationId: installation.installation_id,
        versionId: version.version_id,
        activationId,
        commandId: input.commandId,
        eventType: "version_activated",
        payload: { afterGeneration, beforeVersionId: installation.active_version_id ?? null },
      });
      return this.installationView(updated);
    });
  }

  public async getVersion(context: TenantContext, versionId: string): Promise<ExtensionVersionView> {
    await this.organizations.verifyTenantContext(context);
    const version = await this.findVersion(this.database, context.organizationId, versionId);
    const installation = await this.installation(this.database, context.organizationId, version.installation_id);
    return this.versionView(version, installation.activation_generation);
  }

  private async findVersion(
    executor: QueryExecutor,
    organizationId: string,
    versionId: string,
  ): Promise<VersionRecord> {
    const version = await first<VersionRecord>(
      executor,
      "SELECT * OMIT id FROM extension_version WHERE organization_id = $organization_id AND version_id = $version_id LIMIT 1;",
      { organization_id: organizationId, version_id: versionId },
    );
    if (!version) throw new Error("Extension version을 찾을 수 없습니다");
    return version;
  }

  private async installation(
    executor: QueryExecutor,
    organizationId: string,
    installationId: string,
  ): Promise<InstallationRecord> {
    const installation = await first<InstallationRecord>(
      executor,
      "SELECT * OMIT id FROM extension_installation WHERE organization_id = $organization_id AND installation_id = $installation_id LIMIT 1;",
      { organization_id: organizationId, installation_id: installationId },
    );
    if (!installation) throw new Error("Extension installation을 찾을 수 없습니다");
    return installation;
  }

  private async event(
    executor: QueryExecutor,
    input: {
      readonly organizationId: string;
      readonly installationId: string;
      readonly versionId?: string;
      readonly activationId?: string;
      readonly commandId: string;
      readonly eventType: string;
      readonly payload: unknown;
    },
  ): Promise<void> {
    const payload = canonicalJson(input.payload);
    await executor.query(
      "CREATE extension_event CONTENT { event_id: $event_id, organization_id: $organization_id, installation_id: $installation_id, version_id: $version_id, activation_id: $activation_id, command_id: $command_id, event_type: $event_type, payload_json: $payload_json, payload_hash: $payload_hash, created_at: time::now() };",
      {
        event_id: randomUUID(),
        organization_id: input.organizationId,
        installation_id: input.installationId,
        version_id: input.versionId,
        activation_id: input.activationId,
        command_id: input.commandId,
        event_type: input.eventType,
        payload_json: payload,
        payload_hash: sha256(payload),
      },
    );
  }

  private versionView(record: VersionRecord, activationGeneration: number): ExtensionVersionView {
    return {
      versionId: record.version_id,
      installationId: record.installation_id,
      organizationId: record.organization_id,
      packageName: record.package_name,
      packageVersion: record.package_version,
      artifactDigest: record.artifact_digest,
      contentDigest: record.content_digest,
      manifestDigest: record.manifest_digest,
      permissionDigest: record.permission_digest,
      trustLevel: record.trust_level,
      sourceKind: record.source_kind,
      activationGeneration,
    };
  }

  private installationView(record: InstallationRecord): ExtensionInstallationView {
    return {
      installationId: record.installation_id,
      organizationId: record.organization_id,
      packageName: record.package_name,
      state: record.state,
      ...(record.active_version_id === undefined ? {} : { activeVersionId: record.active_version_id }),
      activationGeneration: record.activation_generation,
    };
  }
}

export interface StagedArtifact {
  readonly organizationNamespace: string;
  readonly digest: string;
  readonly size: number;
  readonly token: string;
  readonly path: string;
}

export interface CommittedArtifact {
  readonly digest: string;
  readonly size: number;
  readonly path: string;
}

export class FileArtifactStore {
  private readonly root: string;

  public constructor(root: string) {
    this.root = resolve(root);
  }

  public async stage(organizationId: string, expectedDigest: string, archive: Buffer): Promise<StagedArtifact> {
    if (!/^[a-f0-9]{64}$/u.test(expectedDigest))
      throw new Error("Extension artifact expected digest가 유효하지 않습니다");
    const actual = sha256(archive);
    if (actual !== expectedDigest) throw new Error("Extension artifact digest가 일치하지 않습니다");
    const namespace = sha256(organizationId);
    const token = randomUUID();
    const path = join(this.root, namespace, "staging", `${token}.tgz`);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(archive);
      await handle.sync();
    } catch (error) {
      await unlink(path).catch(() => undefined);
      throw error;
    } finally {
      await handle.close();
    }
    return { organizationNamespace: namespace, digest: expectedDigest, size: archive.length, token, path };
  }

  public async commit(staged: StagedArtifact): Promise<CommittedArtifact> {
    await this.verify(staged.path, staged.digest);
    const path = join(
      this.root,
      staged.organizationNamespace,
      "artifacts",
      staged.digest.slice(0, 2),
      `${staged.digest}.tgz`,
    );
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      await link(staged.path, path);
      await unlink(staged.path);
    } catch (error) {
      const existing = await readFile(path).catch(() => undefined);
      if (!existing || sha256(existing) !== staged.digest) throw error;
      await unlink(staged.path).catch(() => undefined);
    }
    return { digest: staged.digest, size: staged.size, path };
  }

  public async read(organizationId: string, digest: string): Promise<Buffer> {
    const namespace = sha256(organizationId);
    const path = join(this.root, namespace, "artifacts", digest.slice(0, 2), `${digest}.tgz`);
    const body = await readFile(path);
    if (sha256(body) !== digest) throw new Error("Extension artifact가 corrupt 상태입니다");
    return body;
  }

  public async quarantine(staged: StagedArtifact): Promise<void> {
    const target = join(this.root, staged.organizationNamespace, "quarantine", `${staged.token}.tgz`);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await rename(staged.path, target);
  }

  private async verify(path: string, digest: string): Promise<void> {
    if (sha256(await readFile(path)) !== digest)
      throw new Error("Extension staged artifact digest가 일치하지 않습니다");
  }
}
