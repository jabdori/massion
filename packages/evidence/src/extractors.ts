import { createHash } from "node:crypto";

import type { Node as SyntaxNode } from "@vscode/tree-sitter-wasm";

export type EvidenceSymbolKind =
  | "class"
  | "interface"
  | "struct"
  | "enum"
  | "trait"
  | "type"
  | "function"
  | "method"
  | "constructor"
  | "rule"
  | "section";

export interface ParsedSymbol {
  readonly symbolKey: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly kind: EvidenceSymbolKind;
  readonly startByte: number;
  readonly endByte: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly contentHash: string;
}

export interface ParsedRelation {
  readonly kind: "contains" | "imports" | "calls" | "implements" | "documents";
  readonly sourceSymbolKey?: string;
  readonly targetSymbolKey?: string;
  readonly targetText: string;
  readonly resolved: boolean;
  readonly startLine: number;
}

export interface ParsedChunk {
  readonly chunkKey: string;
  readonly symbolKey?: string;
  readonly startByte: number;
  readonly endByte: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly content: string;
  readonly contentHash: string;
}

export interface ExtractedTreeEvidence {
  readonly symbols: readonly ParsedSymbol[];
  readonly relations: readonly ParsedRelation[];
  readonly chunks: readonly ParsedChunk[];
  readonly parseErrorCount: number;
}

const SYMBOL_TYPES: Readonly<Record<string, EvidenceSymbolKind>> = {
  class_declaration: "class",
  class_definition: "class",
  class_specifier: "class",
  class: "class",
  interface_declaration: "interface",
  interface_definition: "interface",
  struct_item: "struct",
  struct_specifier: "struct",
  type_spec: "type",
  type_alias_declaration: "type",
  enum_item: "enum",
  enum_declaration: "enum",
  trait_item: "trait",
  function_declaration: "function",
  function_definition: "function",
  function_item: "function",
  method_definition: "method",
  method_declaration: "method",
  method: "method",
  constructor_declaration: "constructor",
  function_definition_statement: "function",
  rule_set: "rule",
};

const CONTAINER_KINDS = new Set<EvidenceSymbolKind>(["class", "interface", "struct", "enum", "trait"]);
const IMPORT_TYPES = new Set([
  "import_statement",
  "import_declaration",
  "import_spec",
  "use_declaration",
  "using_directive",
  "preproc_include",
  "namespace_use_declaration",
  "require",
]);
const CALL_TYPES = new Set(["call_expression", "method_invocation", "invocation_expression"]);
const IMPLEMENTS_TYPES = new Set(["implements_clause", "super_interfaces", "base_list"]);
const NAME_NODE_TYPES = new Set(["identifier", "type_identifier", "field_identifier", "constant", "name"]);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nonNullChildren(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((child): child is SyntaxNode => child !== null);
}

function firstDescendantName(node: SyntaxNode): SyntaxNode | undefined {
  if (NAME_NODE_TYPES.has(node.type)) return node;
  for (const child of nonNullChildren(node)) {
    const found = firstDescendantName(child);
    if (found) return found;
  }
  return undefined;
}

function nameFor(node: SyntaxNode, kind: EvidenceSymbolKind): string | undefined {
  const direct =
    node.childForFieldName("name") ??
    node.childForFieldName("declarator") ??
    node.childForFieldName("type") ??
    node.childForFieldName("selector");
  const candidate = direct ? (firstDescendantName(direct) ?? direct) : undefined;
  if (candidate?.text.trim()) return candidate.text.trim();
  if (kind === "rule") {
    const selector = nonNullChildren(node)[0]?.text.trim();
    if (selector) return selector;
  }
  return firstDescendantName(node)?.text.trim();
}

function symbolKey(
  relativePath: string,
  qualifiedName: string,
  kind: EvidenceSymbolKind,
  startByte: number,
  endByte: number,
): string {
  return sha256(`${relativePath}\0${qualifiedName}\0${kind}\0${String(startByte)}\0${String(endByte)}`);
}

function chunkFromRange(
  relativePath: string,
  source: string,
  startByte: number,
  endByte: number,
  startLine: number,
  endLine: number,
  symbol?: ParsedSymbol,
): ParsedChunk {
  const content = Buffer.from(source, "utf8").subarray(startByte, endByte).toString("utf8");
  return {
    chunkKey: sha256(
      `${relativePath}\0${symbol?.symbolKey ?? "file"}\0${String(startByte)}\0${String(endByte)}\0${sha256(content)}`,
    ),
    ...(symbol ? { symbolKey: symbol.symbolKey } : {}),
    startByte,
    endByte,
    startLine,
    endLine,
    content,
    contentHash: sha256(content),
  };
}

function relationTarget(node: SyntaxNode): string {
  const candidate =
    node.childForFieldName("source") ??
    node.childForFieldName("path") ??
    node.childForFieldName("module") ??
    node.childForFieldName("function") ??
    node.childForFieldName("name");
  return (candidate?.text ?? node.text).trim().slice(0, 2_000);
}

export function extractTreeEvidence(
  root: SyntaxNode,
  relativePath: string,
  source: string,
  sourceContentHash: string,
): ExtractedTreeEvidence {
  const symbols: ParsedSymbol[] = [];
  const relations: ParsedRelation[] = [];
  let parseErrorCount = 0;

  const visit = (node: SyntaxNode, scopes: readonly string[], currentSymbolKey?: string): void => {
    if (node.isError || node.isMissing) parseErrorCount += 1;
    const configuredKind = SYMBOL_TYPES[node.type];
    let nextScopes = scopes;
    let nextCurrentKey = currentSymbolKey;
    if (configuredKind) {
      const name = nameFor(node, configuredKind);
      if (name) {
        const kind =
          configuredKind === "function" && scopes.length > 0 && node.type === "function_definition"
            ? "method"
            : configuredKind;
        const qualifiedName = [...scopes, name].join(".");
        const parsed: ParsedSymbol = {
          symbolKey: symbolKey(relativePath, qualifiedName, kind, node.startIndex, node.endIndex),
          name,
          qualifiedName,
          kind,
          startByte: node.startIndex,
          endByte: node.endIndex,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          contentHash: sourceContentHash,
        };
        symbols.push(parsed);
        if (currentSymbolKey && currentSymbolKey !== parsed.symbolKey) {
          relations.push({
            kind: "contains",
            sourceSymbolKey: currentSymbolKey,
            targetSymbolKey: parsed.symbolKey,
            targetText: parsed.qualifiedName,
            resolved: true,
            startLine: parsed.startLine,
          });
        }
        nextCurrentKey = parsed.symbolKey;
        if (CONTAINER_KINDS.has(kind)) nextScopes = [...scopes, name];
      }
    }
    if (IMPORT_TYPES.has(node.type)) {
      relations.push({
        kind: "imports",
        ...(currentSymbolKey ? { sourceSymbolKey: currentSymbolKey } : {}),
        targetText: relationTarget(node),
        resolved: false,
        startLine: node.startPosition.row + 1,
      });
    }
    if (CALL_TYPES.has(node.type)) {
      relations.push({
        kind: "calls",
        ...(currentSymbolKey ? { sourceSymbolKey: currentSymbolKey } : {}),
        targetText: relationTarget(node),
        resolved: false,
        startLine: node.startPosition.row + 1,
      });
    }
    if (IMPLEMENTS_TYPES.has(node.type)) {
      relations.push({
        kind: "implements",
        ...(currentSymbolKey ? { sourceSymbolKey: currentSymbolKey } : {}),
        targetText: relationTarget(node),
        resolved: false,
        startLine: node.startPosition.row + 1,
      });
    }
    for (const child of nonNullChildren(node)) visit(child, nextScopes, nextCurrentKey);
  };
  visit(root, []);
  symbols.sort((left, right) => left.startByte - right.startByte || left.symbolKey.localeCompare(right.symbolKey));
  const resolvedRelations = relations.map((relation): ParsedRelation => {
    const identifiers = relation.targetText.match(/[A-Za-z_$][A-Za-z0-9_$]*/gu) ?? [];
    const targetName = identifiers.at(-1);
    const candidates = targetName ? symbols.filter((symbol) => symbol.name === targetName) : [];
    const target = candidates[0];
    if (!target || candidates.length !== 1 || (relation.kind === "calls" && relation.targetText !== targetName)) {
      return relation;
    }
    return { ...relation, targetSymbolKey: target.symbolKey, resolved: true };
  });
  resolvedRelations.sort(
    (left, right) => left.startLine - right.startLine || left.targetText.localeCompare(right.targetText),
  );
  const chunks =
    symbols.length > 0
      ? symbols.map((symbol) =>
          chunkFromRange(
            relativePath,
            source,
            symbol.startByte,
            symbol.endByte,
            symbol.startLine,
            symbol.endLine,
            symbol,
          ),
        )
      : [chunkFromRange(relativePath, source, 0, Buffer.byteLength(source), 1, source.split("\n").length)];
  return { symbols, relations: resolvedRelations, chunks, parseErrorCount };
}

export function extractLexicalEvidence(
  relativePath: string,
  language: string,
  source: string,
  sourceContentHash: string,
): ExtractedTreeEvidence {
  const symbols: ParsedSymbol[] = [];
  if (language === "markdown") {
    for (const [index, line] of source.split("\n").entries()) {
      const match = /^(#{1,6})\s+(.+)$/u.exec(line.trim());
      if (!match?.[2]) continue;
      const name = match[2].trim();
      const startByte = Buffer.byteLength(source.split("\n").slice(0, index).join("\n")) + (index > 0 ? 1 : 0);
      const endByte = startByte + Buffer.byteLength(line);
      symbols.push({
        symbolKey: symbolKey(relativePath, name, "section", startByte, endByte),
        name,
        qualifiedName: name,
        kind: "section",
        startByte,
        endByte,
        startLine: index + 1,
        endLine: index + 1,
        contentHash: sourceContentHash,
      });
    }
  }
  const chunks: ParsedChunk[] = [];
  const paragraphPattern = /\S(?:[\s\S]*?\S)?(?=\n[ \t]*\n|[ \t\r\n]*$)/gu;
  for (const match of source.matchAll(paragraphPattern)) {
    const content = match[0];
    const startByte = Buffer.byteLength(source.slice(0, match.index), "utf8");
    const endByte = startByte + Buffer.byteLength(content, "utf8");
    const startLine = source.slice(0, match.index).split("\n").length;
    const endLine = startLine + content.split("\n").length - 1;
    chunks.push({
      chunkKey: sha256(`${relativePath}\0${String(startByte)}\0${String(endByte)}\0${sha256(content)}`),
      startByte,
      endByte,
      startLine,
      endLine,
      content,
      contentHash: sha256(content),
    });
  }
  return { symbols, relations: [], chunks, parseErrorCount: 0 };
}
