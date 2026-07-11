import type { CliOutputMode } from "./parser.js";

function safe(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, "")
    .slice(0, 4096);
}

function human(value: unknown): string {
  const rows = Array.isArray(value) ? value : [value];
  if (rows.length === 0) return "결과가 없습니다.\n";
  if (rows.every((row) => row && typeof row === "object" && !Array.isArray(row))) {
    const fields = [...new Set(rows.flatMap((row) => Object.keys(row as Record<string, unknown>)))];
    const values = rows.map((row) => fields.map((field) => safe((row as Record<string, unknown>)[field])));
    const widths = fields.map((field, index) =>
      Math.min(48, Math.max(field.length, ...values.map((columns) => columns[index]?.length ?? 0))),
    );
    const line = (columns: readonly string[]) =>
      columns
        .map((column, index) => column.slice(0, widths[index] ?? 0).padEnd(widths[index] ?? 0))
        .join("  ")
        .trimEnd();
    return `${line(fields)}\n${line(widths.map((width) => "-".repeat(width)))}\n${values.map(line).join("\n")}\n`;
  }
  return `${rows.map(safe).join("\n")}\n`;
}

export function renderCliOutput(
  value: unknown,
  mode: CliOutputMode,
  _options: { readonly tty: boolean; readonly noColor?: boolean },
): string {
  if (mode === "json") return `${JSON.stringify(value)}\n`;
  if (mode === "jsonl")
    return (Array.isArray(value) ? value : [value]).map((item) => JSON.stringify(item)).join("\n") + "\n";
  return human(value);
}
