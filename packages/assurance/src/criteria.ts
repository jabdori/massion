import { createHash } from "node:crypto";

import type { AssuranceCriterionMethod, AssuranceCriterionStatus } from "./contracts.js";
import type { AssuranceProfile } from "./profile.js";

export interface CriterionBindingCoverage {
  readonly criterionKey: string;
  readonly method: AssuranceCriterionMethod;
  readonly requiredEvidenceKinds: readonly string[];
}

export interface CriterionTaskInput {
  readonly taskId: string;
  readonly status: "blocked" | "ready" | "running" | "completed" | "failed" | "cancelled";
  readonly acceptanceCriteriaJson: string;
}

export interface CriterionExclusionInput {
  readonly rule: string;
  readonly reason: string;
  readonly actorId: string;
}

export interface CompileAssuranceCriteriaInput {
  readonly planContentJson: string;
  readonly tasks: readonly CriterionTaskInput[];
  readonly profile: AssuranceProfile;
  readonly bindings: readonly CriterionBindingCoverage[];
  readonly exclusions?: Readonly<Record<string, CriterionExclusionInput>>;
}

export interface CompiledAssuranceCriterion {
  readonly criterionKey: string;
  readonly source: "plan" | "task" | "profile";
  readonly statement: string;
  readonly method: AssuranceCriterionMethod;
  readonly requiredEvidenceKinds: readonly string[];
  readonly controlReferences: readonly string[];
  readonly planLevel: boolean;
  readonly taskIds: readonly string[];
  readonly status: AssuranceCriterionStatus;
  readonly exclusionRule?: string;
  readonly exclusionReason?: string;
  readonly exclusionActorId?: string;
}

export function checksumCriterionCoverage(
  criteria: readonly { readonly criterionKey: string; readonly method: AssuranceCriterionMethod }[],
): string {
  const canonical = [...criteria]
    .map((criterion) => ({ criterionKey: criterion.criterionKey, method: criterion.method }))
    .sort((left, right) => left.criterionKey.localeCompare(right.criterionKey));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

interface StrategyCriterion {
  readonly key: string;
  readonly statement: string;
  readonly method: AssuranceCriterionMethod;
  readonly evidenceKinds: readonly string[];
  readonly planLevel: boolean;
}

interface MutableCriterion {
  criterionKey: string;
  source: CompiledAssuranceCriterion["source"];
  statement: string;
  method?: AssuranceCriterionMethod;
  requiredEvidenceKinds: string[];
  controlReferences: string[];
  planLevel: boolean;
  taskIds: string[];
  status: AssuranceCriterionStatus;
  exclusionRule?: string;
  exclusionReason?: string;
  exclusionActorId?: string;
}

const METHODS = new Set<AssuranceCriterionMethod>(["test", "inspection", "evidence", "metric", "human"]);

function parseArray(value: string, label: string): unknown[] {
  if (value.length > 1_000_000) throw new Error(`${label} JSON은 1000000자 이하여야 합니다`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} JSON이 올바르지 않습니다`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${label}은 배열이어야 합니다`);
  if (parsed.length > 100) throw new Error(`${label}은 100개 이하여야 합니다`);
  return parsed;
}

function strings(value: unknown, label: string, maximum = 20, maximumLength = 200): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label}이 올바르지 않습니다`);
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim() || item.length > maximumLength)
      throw new Error(`${label}이 올바르지 않거나 ${String(maximumLength)}자를 넘었습니다`);
    result.push(item);
  }
  return [...new Set(result)].sort();
}

function strategyCriterion(value: unknown, label: string): StrategyCriterion {
  if (!value || typeof value !== "object") throw new Error(`${label} 형식이 올바르지 않습니다`);
  const record = value as Record<string, unknown>;
  if (typeof record.key !== "string" || !record.key.trim() || record.key.length > 100)
    throw new Error(`${label} key가 필요하거나 100자를 넘었습니다`);
  if (typeof record.statement !== "string" || !record.statement.trim() || record.statement.length > 2_000)
    throw new Error(`${label} statement가 필요합니다`);
  if (typeof record.method !== "string" || !METHODS.has(record.method as AssuranceCriterionMethod)) {
    throw new Error(`${label} method가 올바르지 않습니다`);
  }
  if (typeof record.planLevel !== "boolean") throw new Error(`${label} planLevel이 올바르지 않습니다`);
  return {
    key: record.key,
    statement: record.statement,
    method: record.method as AssuranceCriterionMethod,
    evidenceKinds: strings(record.evidenceKinds, `${label} evidenceKinds`),
    planLevel: record.planLevel,
  };
}

function planCriteria(contentJson: string): StrategyCriterion[] {
  if (contentJson.length > 1_000_000) throw new Error("Plan content JSON은 1000000자 이하여야 합니다");
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentJson) as unknown;
  } catch {
    throw new Error("Plan content JSON이 올바르지 않습니다");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Plan content가 object가 아닙니다");
  const value = (parsed as Record<string, unknown>).acceptanceCriteria ?? [];
  if (!Array.isArray(value)) throw new Error("Plan acceptanceCriteria가 배열이 아닙니다");
  if (value.length > 100) throw new Error("Plan acceptanceCriteria는 100개 이하여야 합니다");
  return value.map((criterion, index) => strategyCriterion(criterion, `Plan criterion ${String(index)}`));
}

function sameStrategyCriterion(left: MutableCriterion, right: StrategyCriterion): boolean {
  return (
    left.statement === right.statement &&
    left.method === right.method &&
    left.planLevel === right.planLevel &&
    JSON.stringify(left.requiredEvidenceKinds) === JSON.stringify([...right.evidenceKinds].sort())
  );
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function compileAssuranceCriteria(input: CompileAssuranceCriteriaInput): CompiledAssuranceCriterion[] {
  if (input.tasks.length > 100) throw new Error("Assurance 대상 Task는 100개 이하여야 합니다");
  const criteria = new Map<string, MutableCriterion>();
  for (const candidate of planCriteria(input.planContentJson)) {
    if (criteria.has(candidate.key)) throw new Error(`Plan criterion key가 중복됐습니다: ${candidate.key}`);
    criteria.set(candidate.key, {
      criterionKey: candidate.key,
      source: "plan",
      statement: candidate.statement,
      method: candidate.method,
      requiredEvidenceKinds: [...candidate.evidenceKinds].sort(),
      controlReferences: [],
      planLevel: candidate.planLevel,
      taskIds: [],
      status: "pending",
    });
  }

  for (const task of [...input.tasks].sort((left, right) => left.taskId.localeCompare(right.taskId))) {
    const taskCriteria = parseArray(task.acceptanceCriteriaJson, `Task ${task.taskId} acceptance criteria`);
    for (const [index, value] of taskCriteria.entries()) {
      if (typeof value === "string") {
        if (!value.trim() || value.length > 2_000)
          throw new Error(`Task criterion 내용이 비었거나 2000자를 넘었습니다: ${task.taskId}`);
        const key = `task:${task.taskId}:${String(index)}`;
        criteria.set(key, {
          criterionKey: key,
          source: "task",
          statement: value,
          requiredEvidenceKinds: [],
          controlReferences: [],
          planLevel: false,
          taskIds: [task.taskId],
          status: "pending",
        });
        continue;
      }
      const candidate = strategyCriterion(value, `Task ${task.taskId} criterion ${String(index)}`);
      const existing = criteria.get(candidate.key);
      if (!existing) throw new Error(`Task가 Plan에 없는 criterion을 참조합니다: ${candidate.key}`);
      if (!sameStrategyCriterion(existing, candidate))
        throw new Error(`Plan·Task criterion이 충돌합니다: ${candidate.key}`);
      existing.taskIds = uniqueSorted([...existing.taskIds, task.taskId]);
    }
  }

  for (const template of input.profile.criteria) {
    const existing = criteria.get(template.key);
    if (existing) throw new Error(`Profile criterion key가 충돌합니다: ${template.key}`);
    criteria.set(template.key, {
      criterionKey: template.key,
      source: "profile",
      statement: template.statement,
      method: template.method,
      requiredEvidenceKinds: [...template.requiredEvidenceKinds].sort(),
      controlReferences: [...template.controlReferences].sort(),
      planLevel: template.planLevel,
      taskIds: [],
      status: "pending",
    });
  }

  if (criteria.size > 100) throw new Error("Assurance criterion은 100개 이하여야 합니다");
  if (input.bindings.length > 100) throw new Error("Assurance check binding은 100개 이하여야 합니다");
  const bindingsByKey = new Map<string, CriterionBindingCoverage[]>();
  for (const binding of input.bindings) {
    const values = bindingsByKey.get(binding.criterionKey) ?? [];
    values.push(binding);
    bindingsByKey.set(binding.criterionKey, values);
  }
  for (const bindingKey of bindingsByKey.keys()) {
    if (!criteria.has(bindingKey)) throw new Error(`알 수 없는 criterion binding입니다: ${bindingKey}`);
  }
  for (const criterion of criteria.values()) {
    const bindings = bindingsByKey.get(criterion.criterionKey);
    if (!bindings?.length) throw new Error(`Criterion에 binding이 없습니다: ${criterion.criterionKey}`);
    const methods = uniqueSorted(bindings.map((binding) => binding.method));
    if (methods.length !== 1 || (criterion.method !== undefined && methods[0] !== criterion.method)) {
      throw new Error(`Criterion과 binding method가 일치하지 않습니다: ${criterion.criterionKey}`);
    }
    criterion.method = methods[0] as AssuranceCriterionMethod;
    criterion.requiredEvidenceKinds = uniqueSorted([
      ...criterion.requiredEvidenceKinds,
      ...bindings.flatMap((binding) => binding.requiredEvidenceKinds),
    ]);
    if (
      criterion.requiredEvidenceKinds.length > 20 ||
      criterion.requiredEvidenceKinds.some((kind) => !kind.trim() || kind.length > 200)
    ) {
      throw new Error(`Criterion required evidence kind는 20개·각 200자 이하여야 합니다: ${criterion.criterionKey}`);
    }
  }

  const taskStatus = new Map(input.tasks.map((task) => [task.taskId, task.status]));
  for (const [key, exclusion] of Object.entries(input.exclusions ?? {})) {
    const criterion = criteria.get(key);
    if (!criterion) throw new Error(`제외할 criterion을 찾을 수 없습니다: ${key}`);
    if (criterion.planLevel) throw new Error(`plan-level criterion은 제외할 수 없습니다: ${key}`);
    if (!input.profile.allowedExclusionRules.includes(exclusion.rule)) {
      throw new Error(`Profile이 criterion exclusion rule을 허용하지 않습니다: ${exclusion.rule}`);
    }
    if (
      exclusion.rule !== "cancelled-task-only" ||
      criterion.taskIds.length === 0 ||
      criterion.taskIds.some((taskId) => taskStatus.get(taskId) !== "cancelled")
    ) {
      throw new Error(`cancelled Task에만 귀속된 criterion이 아닙니다: ${key}`);
    }
    if (!exclusion.rule.trim() || exclusion.rule.length > 200)
      throw new Error("Criterion exclusion rule은 200자 이하여야 합니다");
    if (!exclusion.reason.trim() || exclusion.reason.length > 1_000)
      throw new Error("Criterion exclusion reason은 1000자 이하여야 합니다");
    if (!exclusion.actorId.trim() || exclusion.actorId.length > 200)
      throw new Error("Criterion exclusion actor는 200자 이하여야 합니다");
    if (!exclusion.reason.trim() || !exclusion.actorId.trim())
      throw new Error("Criterion exclusion 사유와 actor가 필요합니다");
    criterion.status = "excluded";
    criterion.exclusionRule = exclusion.rule;
    criterion.exclusionReason = exclusion.reason;
    criterion.exclusionActorId = exclusion.actorId;
  }

  return [...criteria.values()]
    .sort((left, right) => left.criterionKey.localeCompare(right.criterionKey))
    .map((criterion) => ({
      criterionKey: criterion.criterionKey,
      source: criterion.source,
      statement: criterion.statement,
      method: criterion.method as AssuranceCriterionMethod,
      requiredEvidenceKinds: criterion.requiredEvidenceKinds,
      controlReferences: criterion.controlReferences,
      planLevel: criterion.planLevel,
      taskIds: criterion.taskIds,
      status: criterion.status,
      ...(criterion.exclusionRule ? { exclusionRule: criterion.exclusionRule } : {}),
      ...(criterion.exclusionReason ? { exclusionReason: criterion.exclusionReason } : {}),
      ...(criterion.exclusionActorId ? { exclusionActorId: criterion.exclusionActorId } : {}),
    }));
}
