import { createHmac } from "node:crypto";

import semver from "semver";

import { normalizePackageIdentity, type RegistryRecall, type RegistryVersion } from "./contracts.js";

export interface RegistryCatalogStore {
  list(): Promise<readonly RegistryVersion[]>;
  get(versionId: string): Promise<RegistryVersion>;
  listRecalls(versionId: string): Promise<readonly RegistryRecall[]>;
}

function visible(version: RegistryVersion, organizationId: string): boolean {
  return version.visibility === "public" || version.ownerOrganizationId === organizationId;
}

function manifestRecord(version: RegistryVersion): Record<string, unknown> {
  return version.manifest as Record<string, unknown>;
}

function compatible(
  version: RegistryVersion,
  runtime: { readonly agentOS: string; readonly node: string; readonly surrealDB?: string },
): boolean {
  const compatibility = manifestRecord(version).compatibility;
  if (!compatibility || typeof compatibility !== "object" || Array.isArray(compatibility)) return false;
  const ranges = compatibility as Record<string, unknown>;
  for (const [key, actual] of [
    ["agentOS", runtime.agentOS],
    ["node", runtime.node],
    ["surrealDB", runtime.surrealDB],
  ] as const) {
    const range = ranges[key];
    if (actual === undefined && key === "surrealDB") continue;
    if (
      typeof range !== "string" ||
      actual === undefined ||
      !semver.validRange(range) ||
      !semver.satisfies(actual, range)
    )
      return false;
  }
  return true;
}

export class RegistryCatalog {
  private readonly secret: Buffer;

  public constructor(
    private readonly store: RegistryCatalogStore,
    options: { readonly tokenSecret: Buffer },
  ) {
    if (options.tokenSecret.length < 32) throw new Error("Catalog token secret은 256-bit 이상이어야 합니다");
    this.secret = options.tokenSecret;
  }

  public async search(input: {
    readonly organizationId: string;
    readonly query: string;
    readonly runtime: { readonly agentOS: string; readonly node: string; readonly surrealDB?: string };
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<{ readonly items: readonly ReturnType<RegistryCatalog["item"]>[]; readonly nextCursor?: string }> {
    if (input.query.length > 256 || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
      throw new Error("Catalog 검색 입력이 유효하지 않습니다");
    const offset = input.cursor ? this.decodeCursor(input.cursor, input) : 0;
    const query = input.query.trim().toLocaleLowerCase("en-US");
    const candidates = (await this.store.list())
      .filter(
        (version) =>
          version.state === "published" && visible(version, input.organizationId) && compatible(version, input.runtime),
      )
      .filter((version) => {
        const description = manifestRecord(version).description;
        return (
          !query ||
          version.packageName.includes(query) ||
          (typeof description === "string" && description.toLocaleLowerCase("en-US").includes(query))
        );
      })
      .sort(
        (left, right) =>
          left.packageName.localeCompare(right.packageName) ||
          semver.rcompare(left.packageVersion, right.packageVersion),
      );
    const latest = new Map<string, RegistryVersion>();
    for (const version of candidates) if (!latest.has(version.packageName)) latest.set(version.packageName, version);
    const values = [...latest.values()];
    const page = values.slice(offset, offset + input.limit);
    const next = offset + page.length;
    return {
      items: page.map((version) => this.item(version)),
      ...(next < values.length ? { nextCursor: this.encodeCursor(next, input) } : {}),
    };
  }

  public async issueDownload(input: { readonly organizationId: string; readonly versionId: string }): Promise<{
    readonly token: string;
    readonly artifactDigest: string;
    readonly expiresAt: string;
  }> {
    const version = await this.store.get(input.versionId);
    if (!visible(version, input.organizationId)) throw new Error("Registry version을 찾을 수 없습니다");
    if (version.state === "recalled") throw new Error("recalled Registry version은 download할 수 없습니다");
    if (version.state !== "published") throw new Error("published Registry version만 download할 수 있습니다");
    const expiresAt = Date.now() + 5 * 60_000;
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        versionId: version.versionId,
        digest: version.artifactDigest,
        organizationId: input.organizationId,
        expiresAt,
      }),
    ).toString("base64url");
    return {
      token: `${payload}.${this.sign(payload)}`,
      artifactDigest: version.artifactDigest,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  public async verifyDownload(token: string, organizationId: string): Promise<RegistryVersion> {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra || this.sign(payload) !== signature)
      throw new Error("download grant signature가 유효하지 않습니다");
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      versionId?: unknown;
      digest?: unknown;
      organizationId?: unknown;
      expiresAt?: unknown;
    };
    if (
      value.organizationId !== organizationId ||
      typeof value.versionId !== "string" ||
      typeof value.expiresAt !== "number" ||
      value.expiresAt < Date.now()
    )
      throw new Error("download grant가 만료됐거나 audience가 다릅니다");
    const version = await this.store.get(value.versionId);
    if (version.state !== "published" || version.artifactDigest !== value.digest || !visible(version, organizationId))
      throw new Error("download grant version이 더 이상 설치 가능하지 않습니다");
    return version;
  }

  public async packument(
    organizationId: string,
    packageName: string,
  ): Promise<{
    readonly name: string;
    readonly "dist-tags": Record<string, string>;
    readonly versions: Record<
      string,
      {
        readonly name: string;
        readonly version: string;
        readonly description?: string;
        readonly deprecated?: string;
        readonly dist: { readonly tarball: string; readonly integrity: string };
      }
    >;
  }> {
    normalizePackageIdentity(packageName, "1.0.0");
    const candidates = (await this.store.list())
      .filter(
        (version) =>
          version.packageName === packageName && visible(version, organizationId) && version.state !== "staged",
      )
      .sort((left, right) => semver.rcompare(left.packageVersion, right.packageVersion));
    if (candidates.length === 0) throw new Error("Registry package를 찾을 수 없습니다");
    const versions: Record<
      string,
      {
        name: string;
        version: string;
        description?: string;
        deprecated?: string;
        dist: { tarball: string; integrity: string };
      }
    > = {};
    for (const version of candidates) {
      const description = manifestRecord(version).description;
      const recalls = await this.store.listRecalls(version.versionId);
      versions[version.packageVersion] = {
        name: packageName,
        version: version.packageVersion,
        ...(typeof description === "string" ? { description } : {}),
        ...(version.state === "recalled"
          ? { deprecated: `Massion recalled: ${recalls.at(-1)?.reason ?? "security policy"}` }
          : {}),
        dist: {
          tarball: `/npm/${encodeURIComponent(packageName)}/-/${packageName.split("/")[1]}-${version.packageVersion}.tgz?v=${version.versionId}`,
          integrity: `sha256-${Buffer.from(version.artifactDigest, "hex").toString("base64")}`,
        },
      };
    }
    const latest = candidates.find((version) => version.state === "published");
    return { name: packageName, "dist-tags": latest ? { latest: latest.packageVersion } : {}, versions };
  }

  private item(version: RegistryVersion) {
    const manifest = manifestRecord(version);
    return {
      versionId: version.versionId,
      packageName: version.packageName,
      packageVersion: version.packageVersion,
      description: typeof manifest.description === "string" ? manifest.description : "",
      visibility: version.visibility,
      ownerOrganizationId: version.ownerOrganizationId,
      artifactDigest: version.artifactDigest,
      provenance: version.assessment?.provenance ?? "unknown",
    } as const;
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("base64url");
  }

  private encodeCursor(
    offset: number,
    input: { readonly organizationId: string; readonly query: string; readonly runtime: unknown },
  ): string {
    const payload = Buffer.from(
      JSON.stringify({ offset, organizationId: input.organizationId, query: input.query, runtime: input.runtime }),
    ).toString("base64url");
    return `${payload}.${this.sign(payload)}`;
  }

  private decodeCursor(
    cursor: string,
    input: { readonly organizationId: string; readonly query: string; readonly runtime: unknown },
  ): number {
    const [payload, signature, extra] = cursor.split(".");
    if (!payload || !signature || extra || this.sign(payload) !== signature)
      throw new Error("Catalog cursor가 유효하지 않습니다");
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      offset?: unknown;
      organizationId?: unknown;
      query?: unknown;
      runtime?: unknown;
    };
    if (
      value.organizationId !== input.organizationId ||
      value.query !== input.query ||
      JSON.stringify(value.runtime) !== JSON.stringify(input.runtime) ||
      !Number.isSafeInteger(value.offset) ||
      (value.offset as number) < 0
    )
      throw new Error("Catalog cursor가 검색 조건과 다릅니다");
    return value.offset as number;
  }
}
