export interface PolicyBundle {
  readonly schema: string | Readonly<Record<string, unknown>>;
  readonly policies: Readonly<Record<string, string>>;
}

export interface PolicyPrincipal {
  readonly type: string;
  readonly id: string;
  readonly organizationId: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export interface PolicyResource {
  readonly type: string;
  readonly id: string;
  readonly organizationId: string;
  readonly revision?: number;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export interface PolicyRequest {
  readonly principal: PolicyPrincipal;
  readonly action: string;
  readonly resource: PolicyResource;
  readonly context: Readonly<Record<string, unknown>>;
}

export interface AuthorizationResult {
  readonly decision: "allow" | "deny";
  readonly reasons: readonly string[];
  readonly errors: readonly string[];
}

export interface ApprovalRequirement {
  readonly requirementId: string;
  readonly actions: readonly string[];
  readonly environments: readonly string[];
  readonly riskClasses: readonly string[];
  readonly approverRoles: readonly string[];
  readonly quorum: number;
  readonly separationOfDuty: boolean;
  readonly expiresInSeconds: number;
}
