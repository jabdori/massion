import { createHash } from "node:crypto";

import { RECORDS_DOCUMENT_MAX_BYTES, validateDocumentSecurity } from "./security.js";

export const RECORDS_MARKDOWN_RENDERER_VERSION = "massion.records.markdown.v1";

interface DocumentSourceBase {
  readonly title: string;
  readonly sourceReferenceIds: readonly string[];
}

export interface DecisionOption {
  readonly name: string;
  readonly description: string;
  readonly positiveConsequences: readonly string[];
  readonly negativeConsequences: readonly string[];
}

export interface AdrDocumentSource extends DocumentSourceBase {
  readonly kind: "adr";
  readonly status: "accepted";
  readonly context: string;
  readonly options: readonly DecisionOption[];
  readonly outcome: string;
  readonly consequences: readonly string[];
}

export type ChangelogCategory = "added" | "changed" | "deprecated" | "removed" | "fixed" | "security";

export interface ChangelogDocumentSource extends DocumentSourceBase {
  readonly kind: "changelog";
  readonly category: ChangelogCategory;
  readonly audience: string;
  readonly notableChange: string;
  readonly compatibilityImpact?: string;
  readonly migrationReference?: string;
}

export interface RunbookDocumentSource extends DocumentSourceBase {
  readonly kind: "runbook";
  readonly triggers: readonly string[];
  readonly preconditions: readonly string[];
  readonly steps: readonly string[];
  readonly validation: readonly string[];
  readonly rollback: readonly string[];
  readonly escalation: readonly string[];
}

export type RecordsDocumentSource = AdrDocumentSource | ChangelogDocumentSource | RunbookDocumentSource;

export interface RenderedRecordsDocument {
  readonly kind: RecordsDocumentSource["kind"];
  readonly schemaVersion: string;
  readonly rendererVersion: typeof RECORDS_MARKDOWN_RENDERER_VERSION;
  readonly sourceJson: string;
  readonly sourceChecksum: string;
  readonly markdown: string;
  readonly markdownChecksum: string;
}

const CHANGELOG_HEADINGS: Readonly<Record<ChangelogCategory, string>> = {
  added: "Added",
  changed: "Changed",
  deprecated: "Deprecated",
  removed: "Removed",
  fixed: "Fixed",
  security: "Security",
};
const CHANGELOG_CATEGORIES = new Set<ChangelogCategory>([
  "added",
  "changed",
  "deprecated",
  "removed",
  "fixed",
  "security",
]);

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function text(value: unknown, label: string, maximumLength: number = 4_000): string {
  if (typeof value !== "string") throw new Error(`${label}은 문자열이어야 합니다`);
  const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
  if (normalized.length === 0 || normalized.length > maximumLength) {
    throw new Error(`${label}은 1~${String(maximumLength)}자여야 합니다`);
  }
  return normalized;
}

function list(values: unknown, label: string, maximumCount: number = 100): readonly string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > maximumCount) {
    throw new Error(`${label}은 1~${String(maximumCount)}개여야 합니다`);
  }
  return (values as unknown[]).map((value, index) => text(value, `${label}[${String(index)}]`));
}

function validateBase(source: DocumentSourceBase): void {
  text(source.title, "title", 200);
  list(source.sourceReferenceIds, "sourceReferenceIds");
  if (new Set(source.sourceReferenceIds).size !== source.sourceReferenceIds.length) {
    throw new Error("sourceReferenceIds는 중복될 수 없습니다");
  }
}

function assertRuntimeKind(value: unknown, expected: RecordsDocumentSource["kind"]): void {
  if (!value || typeof value !== "object" || (value as Readonly<Record<string, unknown>>).kind !== expected) {
    throw new Error(`Document source kind는 ${expected}여야 합니다`);
  }
}

function validateDecisionOptions(value: unknown): void {
  if (!Array.isArray(value) || value.length < 2 || value.length > 20) {
    throw new Error("ADR options는 2~20개여야 합니다");
  }
  for (const [index, candidate] of (value as unknown[]).entries()) {
    if (!candidate || typeof candidate !== "object") {
      throw new Error(`ADR options[${String(index)}]는 object여야 합니다`);
    }
    const option = candidate as Readonly<Record<string, unknown>>;
    text(option.name, `ADR options[${String(index)}].name`, 200);
    text(option.description, `ADR options[${String(index)}].description`);
    list(option.positiveConsequences, `ADR options[${String(index)}].positiveConsequences`, 20);
    list(option.negativeConsequences, `ADR options[${String(index)}].negativeConsequences`, 20);
  }
}

function escapeMarkdown(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("*", "\\*")
    .replaceAll("_", "\\_")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/^(?=[#>+-]\s|\d+\.\s)/gmu, "\\")
    .replaceAll("\n", "\n  ");
}

function bulletList(values: readonly string[]): string {
  return values.map((value) => `- ${escapeMarkdown(value)}`).join("\n");
}

function sourceReferences(source: DocumentSourceBase): string {
  return `## Source References\n\n${bulletList(source.sourceReferenceIds)}`;
}

function complete(lines: readonly string[]): string {
  return `${lines.join("\n\n").replaceAll("\r", "")}\n`;
}

function validateAdr(source: AdrDocumentSource): void {
  validateDocumentSecurity(source);
  validateBase(source);
  assertRuntimeKind(source, "adr");
  if ((source as unknown as Readonly<Record<string, unknown>>).status !== "accepted") {
    throw new Error("ADR status는 accepted여야 합니다");
  }
  text(source.context, "ADR context");
  text(source.outcome, "ADR outcome");
  list(source.consequences, "ADR consequences");
  validateDecisionOptions(source.options);
}

function validateChangelog(source: ChangelogDocumentSource): void {
  validateDocumentSecurity(source);
  validateBase(source);
  assertRuntimeKind(source, "changelog");
  if (!CHANGELOG_CATEGORIES.has(source.category)) throw new Error("지원하지 않는 Changelog category입니다");
  text(source.audience, "Changelog audience", 1_000);
  text(source.notableChange, "Changelog notable change");
  if (source.compatibilityImpact !== undefined) text(source.compatibilityImpact, "Compatibility impact");
  if (source.migrationReference !== undefined) text(source.migrationReference, "Migration reference", 200);
}

function validateRunbook(source: RunbookDocumentSource): void {
  validateDocumentSecurity(source);
  validateBase(source);
  assertRuntimeKind(source, "runbook");
  list(source.triggers, "Runbook triggers");
  list(source.preconditions, "Runbook preconditions");
  list(source.steps, "Runbook steps");
  list(source.validation, "Runbook validation");
  list(source.rollback, "Runbook rollback");
  list(source.escalation, "Runbook escalation");
}

export function renderAdr(source: AdrDocumentSource): string {
  validateAdr(source);
  const options = source.options.map((option) =>
    [
      `### ${escapeMarkdown(option.name)}`,
      escapeMarkdown(option.description),
      `#### Positive Consequences\n\n${bulletList(option.positiveConsequences)}`,
      `#### Negative Consequences\n\n${bulletList(option.negativeConsequences)}`,
    ].join("\n\n"),
  );
  return complete([
    `# ${escapeMarkdown(source.title)}`,
    "## Status\n\nAccepted",
    `## Context and Problem Statement\n\n${escapeMarkdown(source.context)}`,
    `## Considered Options\n\n${options.join("\n\n")}`,
    `## Decision Outcome\n\n${escapeMarkdown(source.outcome)}`,
    `## Consequences\n\n${bulletList(source.consequences)}`,
    sourceReferences(source),
  ]);
}

export function renderChangelog(source: ChangelogDocumentSource): string {
  validateChangelog(source);
  const sections = [
    `# ${escapeMarkdown(source.title)}`,
    `## ${CHANGELOG_HEADINGS[source.category]}\n\n- ${escapeMarkdown(source.notableChange)}`,
    `### Audience\n\n${escapeMarkdown(source.audience)}`,
  ];
  if (source.compatibilityImpact !== undefined) {
    sections.push(`### Compatibility\n\n${escapeMarkdown(source.compatibilityImpact)}`);
  }
  if (source.migrationReference !== undefined) {
    sections.push(`### Migration Reference\n\n${escapeMarkdown(source.migrationReference)}`);
  }
  sections.push(sourceReferences(source));
  return complete(sections);
}

export function renderRunbook(source: RunbookDocumentSource): string {
  validateRunbook(source);
  return complete([
    `# ${escapeMarkdown(source.title)}`,
    `## Triggers\n\n${bulletList(source.triggers)}`,
    `## Preconditions\n\n${bulletList(source.preconditions)}`,
    `## Steps\n\n${source.steps.map((step, index) => `${String(index + 1)}. ${escapeMarkdown(step)}`).join("\n")}`,
    `## Validation\n\n${bulletList(source.validation)}`,
    `## Rollback\n\n${bulletList(source.rollback)}`,
    `## Escalation\n\n${bulletList(source.escalation)}`,
    sourceReferences(source),
  ]);
}

export function renderDocument(source: RecordsDocumentSource): RenderedRecordsDocument {
  const markdown =
    source.kind === "adr"
      ? renderAdr(source)
      : source.kind === "changelog"
        ? renderChangelog(source)
        : renderRunbook(source);
  if (new TextEncoder().encode(markdown).byteLength > RECORDS_DOCUMENT_MAX_BYTES) {
    throw new Error("Rendered Markdown은 UTF-8 1 MiB 이하여야 합니다");
  }
  const sourceJson = canonicalJson(source);
  return {
    kind: source.kind,
    schemaVersion: `massion.records.${source.kind}.v1`,
    rendererVersion: RECORDS_MARKDOWN_RENDERER_VERSION,
    sourceJson,
    sourceChecksum: sha256(sourceJson),
    markdown,
    markdownChecksum: sha256(markdown),
  };
}
