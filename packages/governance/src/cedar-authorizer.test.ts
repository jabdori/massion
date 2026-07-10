import { describe, expect, it } from "vitest";

import { CedarAuthorizer } from "./cedar-authorizer.js";
import type { PolicyBundle, PolicyRequest } from "./contracts.js";

const SCHEMA = {
  Massion: {
    entityTypes: {
      Principal: {
        shape: {
          type: "Record",
          attributes: { organizationId: { type: "String", required: true } },
        },
      },
      Resource: {
        shape: {
          type: "Record",
          attributes: { organizationId: { type: "String", required: true } },
        },
      },
    },
    actions: {
      Read: {
        appliesTo: {
          principalTypes: ["Principal"],
          resourceTypes: ["Resource"],
          context: { type: "Record", attributes: {} },
        },
      },
      Delete: {
        appliesTo: {
          principalTypes: ["Principal"],
          resourceTypes: ["Resource"],
          context: { type: "Record", attributes: {} },
        },
      },
    },
  },
};

const bundle: PolicyBundle = {
  schema: SCHEMA,
  policies: {
    tenant: `permit(principal, action, resource) when { principal.organizationId == resource.organizationId };`,
    protect: `forbid(principal, action == Massion::Action::"Delete", resource);`,
  },
};

function request(action = "Read", resourceOrganizationId = "organization-1"): PolicyRequest {
  return {
    principal: { type: "Principal", id: "user-1", organizationId: "organization-1" },
    action,
    resource: { type: "Resource", id: "resource-1", organizationId: resourceOrganizationId },
    context: {},
  };
}

describe("Cedar Authorizer", () => {
  it("같은 조직의 permit 요청을 허용한다", () => {
    const result = new CedarAuthorizer().authorize(bundle, request());

    expect(result.errors).toEqual([]);
    expect(result).toMatchObject({ decision: "allow", reasons: ["tenant"] });
  });

  it("정책이 없거나 조직이 다르면 default deny한다", () => {
    const authorizer = new CedarAuthorizer();

    expect(authorizer.authorize({ ...bundle, policies: {} }, request()).decision).toBe("deny");
    expect(authorizer.authorize(bundle, request("Read", "organization-2")).decision).toBe("deny");
  });

  it("permit과 forbid가 동시에 일치하면 forbid를 우선한다", () => {
    const result = new CedarAuthorizer().authorize(bundle, request("Delete"));

    expect(result).toMatchObject({ decision: "deny", reasons: ["protect"] });
  });

  it("schema·entity·policy 오류는 secret 없는 fail-closed 결과가 된다", () => {
    const invalid: PolicyBundle = {
      schema: SCHEMA,
      policies: { broken: `permit(principal, action, resource) when { context.apiKey == "secret-value" ` },
    };

    const result = new CedarAuthorizer().authorize(invalid, request());

    expect(result.decision).toBe("deny");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });
});
