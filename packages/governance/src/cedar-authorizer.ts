import {
  isAuthorized,
  validate,
  type CedarValueJson,
  type DetailedError,
  type Schema,
} from "@cedar-policy/cedar-wasm/nodejs";

import type { AuthorizationResult, PolicyBundle, PolicyRequest } from "./contracts.js";

function qualified(type: string): string {
  return type.includes("::") ? type : `Massion::${type}`;
}

function cedarValue(value: unknown): CedarValueJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (Array.isArray(value)) return value.map(cedarValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, cedarValue(child)]),
    );
  }
  throw new Error("Cedar 입력은 JSON 호환 값이어야 합니다");
}

function errorCodes(errors: readonly DetailedError[]): string[] {
  return errors.map((error) => error.code ?? "cedar_error");
}

export class CedarAuthorizer {
  public authorize(bundle: PolicyBundle, request: PolicyRequest): AuthorizationResult {
    try {
      const policies = { staticPolicies: { ...bundle.policies } };
      const validation = validate({
        validationSettings: { mode: "strict" },
        schema: bundle.schema as Schema,
        policies,
      });
      if (validation.type === "failure") {
        return { decision: "deny", reasons: [], errors: errorCodes(validation.errors) };
      }
      if (validation.validationErrors.length > 0) {
        return {
          decision: "deny",
          reasons: [],
          errors: validation.validationErrors.map((entry) => entry.error.code ?? "cedar_validation_error"),
        };
      }
      const answer = isAuthorized({
        principal: { type: qualified(request.principal.type), id: request.principal.id },
        action: { type: "Massion::Action", id: request.action },
        resource: { type: qualified(request.resource.type), id: request.resource.id },
        context: cedarValue(request.context) as Record<string, CedarValueJson>,
        schema: bundle.schema as Schema,
        validateRequest: true,
        policies,
        entities: [
          {
            uid: { type: qualified(request.principal.type), id: request.principal.id },
            attrs: {
              organizationId: request.principal.organizationId,
              ...((request.principal.attributes ? cedarValue(request.principal.attributes) : {}) as Record<
                string,
                CedarValueJson
              >),
            },
            parents: [],
          },
          {
            uid: { type: qualified(request.resource.type), id: request.resource.id },
            attrs: {
              organizationId: request.resource.organizationId,
              ...((request.resource.attributes ? cedarValue(request.resource.attributes) : {}) as Record<
                string,
                CedarValueJson
              >),
            },
            parents: [],
          },
        ],
      });
      if (answer.type === "failure") {
        return { decision: "deny", reasons: [], errors: errorCodes(answer.errors) };
      }
      return {
        decision: answer.response.decision,
        reasons: answer.response.diagnostics.reason,
        errors: answer.response.diagnostics.errors.map((entry) => entry.error.code ?? "cedar_authorization_error"),
      };
    } catch {
      return { decision: "deny", reasons: [], errors: ["cedar_evaluation_error"] };
    }
  }
}
