import { randomUUID } from "node:crypto";

import { applyMigrations, type MassionDatabase, type QueryExecutor } from "@massion/storage";

import { type IdentityUser, type Membership, type MembershipRole, type Organization } from "./identity.js";
import { IDENTITY_MIGRATION } from "./schema.js";

export interface TenantContext {
  readonly userId: string;
  readonly organizationId: string;
  readonly membershipId: string;
  readonly role: MembershipRole;
}

export interface TeamCreation {
  readonly organization: Organization;
  readonly membership: Membership;
}

async function findMembership(
  executor: QueryExecutor,
  userId: string,
  organizationId: string,
): Promise<Membership | undefined> {
  const [memberships] = await executor.query<[Membership[]]>(
    `SELECT membership_id, user_id, organization_id, role, status, created_at
     FROM membership
     WHERE user_id = $user_id AND organization_id = $organization_id
     LIMIT 1;`,
    { user_id: userId, organization_id: organizationId },
  );
  return memberships[0];
}

async function userExists(executor: QueryExecutor, userId: string): Promise<boolean> {
  const [users] = await executor.query<[IdentityUser[]]>(
    "SELECT user_id FROM identity_user WHERE user_id = $user_id LIMIT 1;",
    {
      user_id: userId,
    },
  );
  return Boolean(users[0]);
}

export class OrganizationService {
  private constructor(private readonly database: MassionDatabase) {}

  public static async create(database: MassionDatabase): Promise<OrganizationService> {
    await applyMigrations(database, [IDENTITY_MIGRATION]);
    return new OrganizationService(database);
  }

  public async createTeam(userId: string, name: string): Promise<TeamCreation> {
    const normalizedName = name.trim();
    if (!normalizedName) throw new Error("조직 이름은 비어 있을 수 없습니다");

    return await this.database.transaction(async (transaction) => {
      if (!(await userExists(transaction, userId))) throw new Error(`사용자를 찾을 수 없습니다: ${userId}`);
      const organizationId = randomUUID();
      const membershipId = randomUUID();
      const [organizations] = await transaction.query<[Organization[]]>(
        "CREATE organization CONTENT { organization_id: $organization_id, kind: 'team', name: $name, created_at: time::now() } RETURN AFTER;",
        { organization_id: organizationId, name: normalizedName },
      );
      const [memberships] = await transaction.query<[Membership[]]>(
        "CREATE membership CONTENT { membership_id: $membership_id, user_id: $user_id, organization_id: $organization_id, role: 'owner', status: 'active', created_at: time::now() } RETURN AFTER;",
        { membership_id: membershipId, user_id: userId, organization_id: organizationId },
      );
      const organization = organizations[0];
      const membership = memberships[0];
      if (!organization || !membership) throw new Error("팀 조직 생성 결과가 불완전합니다");
      return { organization, membership };
    });
  }

  public async resolveTenantContext(userId: string, organizationId: string): Promise<TenantContext> {
    const membership = await findMembership(this.database, userId, organizationId);
    if (!membership || membership.status !== "active") throw new Error("활성 Membership이 없습니다");
    return {
      userId,
      organizationId,
      membershipId: membership.membership_id,
      role: membership.role,
    };
  }

  private async authorize(
    executor: QueryExecutor,
    context: TenantContext,
    roles?: readonly MembershipRole[],
  ): Promise<Membership> {
    const membership = await findMembership(executor, context.userId, context.organizationId);
    if (
      !membership ||
      membership.status !== "active" ||
      membership.membership_id !== context.membershipId ||
      membership.role !== context.role
    ) {
      throw new Error("유효하지 않은 TenantContext입니다");
    }
    if (roles && !roles.includes(membership.role)) throw new Error("조직 Membership을 변경할 권한이 없습니다");
    return membership;
  }

  public async verifyTenantContext(
    context: TenantContext,
    roles?: readonly MembershipRole[],
    executor: QueryExecutor = this.database,
  ): Promise<void> {
    await this.authorize(executor, context, roles);
  }

  public async addMember(
    context: TenantContext,
    userId: string,
    role: Exclude<MembershipRole, "owner">,
  ): Promise<Membership> {
    return await this.database.transaction(async (transaction) => {
      await this.authorize(transaction, context, ["owner", "admin"]);
      if (!(await userExists(transaction, userId))) throw new Error(`사용자를 찾을 수 없습니다: ${userId}`);
      const [memberships] = await transaction.query<[Membership[]]>(
        `CREATE membership CONTENT {
          membership_id: $membership_id,
          user_id: $user_id,
          organization_id: $organization_id,
          role: $role,
          status: 'active',
          created_at: time::now()
        } RETURN AFTER;`,
        {
          membership_id: randomUUID(),
          user_id: userId,
          organization_id: context.organizationId,
          role,
        },
      );
      const membership = memberships[0];
      if (!membership) throw new Error("Membership 생성 결과가 없습니다");
      return membership;
    });
  }

  public async suspendMembership(context: TenantContext, membershipId: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await this.authorize(transaction, context, ["owner", "admin"]);
      const [targets] = await transaction.query<[Membership[]]>(
        "SELECT membership_id, user_id, organization_id, role, status, created_at FROM membership WHERE membership_id = $membership_id AND organization_id = $organization_id LIMIT 1;",
        { membership_id: membershipId, organization_id: context.organizationId },
      );
      const target = targets[0];
      if (!target) throw new Error("대상 Membership을 찾을 수 없습니다");
      if (target.role === "owner") throw new Error("owner Membership은 suspend할 수 없습니다");
      await transaction.query(
        "UPDATE membership SET status = 'suspended' WHERE membership_id = $membership_id AND organization_id = $organization_id;",
        { membership_id: membershipId, organization_id: context.organizationId },
      );
    });
  }

  public async getOrganization(context: TenantContext, organizationId: string): Promise<Organization> {
    if (context.organizationId !== organizationId) throw new Error("TenantContext 조직과 대상 조직이 다릅니다");
    await this.authorize(this.database, context);
    const [organizations] = await this.database.query<[Organization[]]>(
      "SELECT organization_id, kind, name, created_at FROM organization WHERE organization_id = $organization_id LIMIT 1;",
      { organization_id: organizationId },
    );
    const organization = organizations[0];
    if (!organization) throw new Error("조직을 찾을 수 없습니다");
    return organization;
  }
}
