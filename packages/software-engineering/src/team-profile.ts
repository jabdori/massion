import type {
  GraphChangeResult,
  OrganizationGraphService,
  OrganizationNode,
  OrganizationProfileNode,
} from "@massion/organization";
import type { TenantContext } from "@massion/identity";

export interface EngineeringTeamProfile {
  readonly profileId: string;
  readonly profileVersion: string;
  readonly nodes: readonly OrganizationProfileNode[];
}

export const SOFTWARE_ENGINEERING_TEAM_PROFILE = {
  profileId: "massion.software-engineering",
  profileVersion: "1.0.0",
  nodes: [
    {
      handle: "software-engineering",
      name: "Software Engineering",
      responsibility: "개발 Task 분해, 전문 역할 조정과 변경 통합",
      outputs: ["DeliveryPlan", "ChangeSet"],
      capabilities: ["software-delivery"],
      parentHandle: "delivery-coordination",
      scope: "persistent",
      role: "coordinator",
    },
    {
      handle: "software-engineering.engineering-lead",
      name: "Engineering Lead",
      responsibility: "개발 Task 분해, 경로 충돌 조정과 기술 통합 판정",
      outputs: ["DeliveryDecision"],
      capabilities: ["engineering-lead"],
      parentHandle: "software-engineering",
      scope: "persistent",
      role: "coordinator",
    },
    {
      handle: "software-engineering.frontend-specialist",
      name: "Frontend Specialist",
      responsibility: "Web 사용자 인터페이스와 클라이언트 동작 구현",
      outputs: ["FrontendChange"],
      capabilities: ["frontend-engineering"],
      parentHandle: "software-engineering",
      scope: "persistent",
      role: "operator",
    },
    {
      handle: "software-engineering.backend-specialist",
      name: "Backend Specialist",
      responsibility: "서비스, API와 서버 애플리케이션 구현",
      outputs: ["BackendChange"],
      capabilities: ["backend-engineering"],
      parentHandle: "software-engineering",
      scope: "persistent",
      role: "operator",
    },
    {
      handle: "software-engineering.database-specialist",
      name: "Database Specialist",
      responsibility: "데이터 모델, 질의와 마이그레이션 구현",
      outputs: ["DatabaseChange"],
      capabilities: ["database-engineering"],
      parentHandle: "software-engineering",
      scope: "persistent",
      role: "operator",
    },
    {
      handle: "software-engineering.infrastructure-specialist",
      name: "Infrastructure Specialist",
      responsibility: "빌드, 배포 설정과 실행 기반 변경 구현",
      outputs: ["InfrastructureChange"],
      capabilities: ["infrastructure-engineering"],
      parentHandle: "software-engineering",
      scope: "persistent",
      role: "operator",
    },
    {
      handle: "software-engineering.test-engineer",
      name: "Test Engineer",
      responsibility: "실패 재현 테스트, fixture와 검증 시나리오 구현",
      outputs: ["TestChange", "TestEvidence"],
      capabilities: ["test-engineering"],
      parentHandle: "software-engineering",
      scope: "persistent",
      role: "operator",
    },
    {
      handle: "software-engineering.security-reviewer",
      name: "Security Reviewer",
      responsibility: "코드 변경의 위협, 권한과 비밀정보 노출 검토",
      outputs: ["SecurityReview"],
      capabilities: ["secure-coding-review"],
      parentHandle: "software-engineering",
      scope: "persistent",
      role: "operator",
    },
    {
      handle: "software-engineering.release-engineer",
      name: "Release Engineer",
      responsibility: "버전, 변경 묶음과 배포 가능 상태 준비",
      outputs: ["ReleaseChange"],
      capabilities: ["release-engineering"],
      parentHandle: "software-engineering",
      scope: "persistent",
      role: "operator",
    },
  ],
} as const satisfies EngineeringTeamProfile;

export async function installSoftwareEngineeringTeam(
  graph: OrganizationGraphService,
  context: TenantContext,
  input: {
    readonly commandId: string;
    readonly expectedVersion: number;
    readonly governanceApprovalId?: string;
    readonly governanceEnvironment?: string;
  },
): Promise<GraphChangeResult> {
  return await graph.execute(context, {
    kind: "install-profile",
    commandId: input.commandId,
    expectedVersion: input.expectedVersion,
    profileId: SOFTWARE_ENGINEERING_TEAM_PROFILE.profileId,
    profileVersion: SOFTWARE_ENGINEERING_TEAM_PROFILE.profileVersion,
    nodes: SOFTWARE_ENGINEERING_TEAM_PROFILE.nodes,
    ...(input.governanceApprovalId ? { governanceApprovalId: input.governanceApprovalId } : {}),
    ...(input.governanceEnvironment ? { governanceEnvironment: input.governanceEnvironment } : {}),
  });
}

export type EngineeringAgentSelection =
  | { readonly outcome: "selected"; readonly agentHandle: string }
  | {
      readonly outcome: "staffing_gap";
      readonly reason: "no_exact_candidate" | "ambiguous_exact_candidates";
    };

function sameCapabilities(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = [...new Set(left)].sort();
  const normalizedRight = [...new Set(right)].sort();
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((capability, index) => capability === normalizedRight[index])
  );
}

export function selectEngineeringAgent(
  nodes: readonly OrganizationNode[],
  input: {
    readonly requiredCapabilities: readonly string[];
    readonly recommendedAgentHandles: readonly string[];
  },
): EngineeringAgentSelection {
  const profileHandles = new Set(SOFTWARE_ENGINEERING_TEAM_PROFILE.nodes.map((node) => node.handle));
  const eligible = nodes.filter(
    (node) =>
      profileHandles.has(node.handle as (typeof SOFTWARE_ENGINEERING_TEAM_PROFILE.nodes)[number]["handle"]) &&
      node.status === "active" &&
      sameCapabilities(node.capabilities, input.requiredCapabilities),
  );
  if (input.recommendedAgentHandles.length > 0) {
    const recommended = eligible.filter((node) => input.recommendedAgentHandles.includes(node.handle));
    if (recommended.length === 1 && recommended[0]) {
      return { outcome: "selected", agentHandle: recommended[0].handle };
    }
    return {
      outcome: "staffing_gap",
      reason: recommended.length === 0 ? "no_exact_candidate" : "ambiguous_exact_candidates",
    };
  }
  if (eligible.length === 1 && eligible[0]) return { outcome: "selected", agentHandle: eligible[0].handle };
  return {
    outcome: "staffing_gap",
    reason: eligible.length === 0 ? "no_exact_candidate" : "ambiguous_exact_candidates",
  };
}

/** Software Engineering profile이 책임지는 Task인지 profile 계약으로 판별합니다. */
export function isSoftwareEngineeringTask(input: {
  readonly requiredCapabilities: readonly string[];
  readonly recommendedAgentHandles: readonly string[];
}): boolean {
  const profileHandles = new Set<string>(SOFTWARE_ENGINEERING_TEAM_PROFILE.nodes.map((node) => node.handle));
  if (input.recommendedAgentHandles.some((handle) => profileHandles.has(handle))) return true;
  return SOFTWARE_ENGINEERING_TEAM_PROFILE.nodes.some((node) => sameCapabilities(node.capabilities, input.requiredCapabilities));
}
