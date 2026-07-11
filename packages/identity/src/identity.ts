import { randomUUID } from "node:crypto";

import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import { IDENTITY_MEMBERSHIP_REVISION_MIGRATION, IDENTITY_MIGRATION } from "./schema.js";

export type OrganizationKind = "personal" | "team";
export type MembershipRole = "owner" | "admin" | "member";
export type MembershipStatus = "active" | "suspended";

export interface IdentityUser {
  readonly user_id: string;
  readonly email: string;
  readonly display_name: string;
  readonly created_at: unknown;
}

export interface Organization {
  readonly organization_id: string;
  readonly kind: OrganizationKind;
  readonly name: string;
  readonly created_at: unknown;
}

export interface Membership {
  readonly membership_id: string;
  readonly user_id: string;
  readonly organization_id: string;
  readonly role: MembershipRole;
  readonly status: MembershipStatus;
  readonly revision: number;
  readonly created_at: unknown;
}

export interface PersonalRegistration {
  readonly user: IdentityUser;
  readonly organization: Organization;
  readonly membership: Membership;
}

export interface RegisterPersonalUserInput {
  readonly email: string;
  readonly displayName: string;
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error("유효하지 않은 email");
  return normalized;
}

async function findUser(executor: QueryExecutor, email: string): Promise<IdentityUser | undefined> {
  const [users] = await executor.query<[IdentityUser[]]>(
    "SELECT user_id, email, display_name, created_at FROM identity_user WHERE email = $email LIMIT 1;",
    { email },
  );
  return users[0];
}

async function findPersonalRegistration(
  executor: QueryExecutor,
  user: IdentityUser,
): Promise<PersonalRegistration | undefined> {
  const [memberships] = await executor.query<[Membership[]]>(
    "SELECT membership_id, user_id, organization_id, role, status, revision, created_at FROM membership WHERE user_id = $user_id AND role = 'owner' ORDER BY created_at ASC;",
    { user_id: user.user_id },
  );
  for (const membership of memberships) {
    const [organizations] = await executor.query<[Organization[]]>(
      "SELECT organization_id, kind, name, created_at FROM organization WHERE organization_id = $organization_id AND kind = 'personal' LIMIT 1;",
      { organization_id: membership.organization_id },
    );
    const organization = organizations[0];
    if (organization) return { user, organization, membership };
  }
  return undefined;
}

export class IdentityService {
  private constructor(private readonly database: MassionDatabase) {}

  public static async create(database: MassionDatabase): Promise<IdentityService> {
    await applyMigrations(database, [IDENTITY_MIGRATION, IDENTITY_MEMBERSHIP_REVISION_MIGRATION]);
    return new IdentityService(database);
  }

  public async registerPersonalUser(input: RegisterPersonalUserInput): Promise<PersonalRegistration> {
    const email = normalizeEmail(input.email);
    const displayName = input.displayName.trim();
    if (!displayName) throw new Error("표시 이름은 비어 있을 수 없습니다");

    return await this.database.transaction(async (transaction) => {
      const existing = await findUser(transaction, email);
      if (existing) {
        const registration = await findPersonalRegistration(transaction, existing);
        if (!registration) throw new Error(`사용자의 personal organization이 없습니다: ${existing.user_id}`);
        return registration;
      }

      const userId = randomUUID();
      const organizationId = randomUUID();
      const membershipId = randomUUID();
      const [users] = await transaction.query<[IdentityUser[]]>(
        "CREATE identity_user CONTENT { user_id: $user_id, email: $email, display_name: $display_name, created_at: time::now() } RETURN AFTER;",
        { user_id: userId, email, display_name: displayName },
      );
      const [organizations] = await transaction.query<[Organization[]]>(
        "CREATE organization CONTENT { organization_id: $organization_id, kind: 'personal', name: $name, created_at: time::now() } RETURN AFTER;",
        { organization_id: organizationId, name: `${displayName} Personal` },
      );
      const [memberships] = await transaction.query<[Membership[]]>(
        "CREATE membership CONTENT { membership_id: $membership_id, user_id: $user_id, organization_id: $organization_id, role: 'owner', status: 'active', revision: 0, created_at: time::now() } RETURN AFTER;",
        { membership_id: membershipId, user_id: userId, organization_id: organizationId },
      );
      const user = users[0];
      const organization = organizations[0];
      const membership = memberships[0];
      if (!user || !organization || !membership) throw new Error("personal Identity 생성 결과가 불완전합니다");
      return { user, organization, membership };
    });
  }

  public async listOrganizations(userId: string): Promise<Organization[]> {
    const [memberships] = await this.database.query<[Membership[]]>(
      "SELECT organization_id FROM membership WHERE user_id = $user_id AND status = 'active';",
      { user_id: userId },
    );
    const organizations: Organization[] = [];
    for (const membership of memberships) {
      const [records] = await this.database.query<[Organization[]]>(
        "SELECT organization_id, kind, name, created_at FROM organization WHERE organization_id = $organization_id LIMIT 1;",
        { organization_id: membership.organization_id },
      );
      if (records[0]) organizations.push(records[0]);
    }
    return organizations;
  }
}
