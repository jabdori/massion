import { createRequire } from "node:module";
import path from "node:path";

import type { Language } from "@vscode/tree-sitter-wasm";

import {
  extractLexicalEvidence,
  extractTreeEvidence,
  type ParsedChunk,
  type ParsedRelation,
  type ParsedSymbol,
} from "./extractors.js";

export interface ParseEvidenceInput {
  readonly relativePath: string;
  readonly language: string;
  readonly content: string;
  readonly contentHash: string;
}

export interface ParsedFileEvidence {
  readonly parserKind: "tree-sitter" | "lexical";
  readonly grammarVersion: string;
  readonly status: "complete" | "partial";
  readonly parseErrorCount: number;
  readonly symbols: readonly ParsedSymbol[];
  readonly relations: readonly ParsedRelation[];
  readonly chunks: readonly ParsedChunk[];
}

const require = createRequire(import.meta.url);
const { Language: TreeSitterLanguage, Parser } =
  require("@vscode/tree-sitter-wasm") as typeof import("@vscode/tree-sitter-wasm");
const packageEntry = require.resolve("@vscode/tree-sitter-wasm");
const wasmDirectory = path.dirname(packageEntry);
const GRAMMAR_FILE: Readonly<Record<string, string>> = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  go: "tree-sitter-go.wasm",
  python: "tree-sitter-python.wasm",
  rust: "tree-sitter-rust.wasm",
  java: "tree-sitter-java.wasm",
  c_sharp: "tree-sitter-c-sharp.wasm",
  c: "tree-sitter-cpp.wasm",
  cpp: "tree-sitter-cpp.wasm",
  php: "tree-sitter-php.wasm",
  ruby: "tree-sitter-ruby.wasm",
  bash: "tree-sitter-bash.wasm",
  css: "tree-sitter-css.wasm",
};

let initialization: Promise<void> | undefined;
const languageCache = new Map<string, Promise<Language>>();

async function initialize(): Promise<void> {
  initialization ??= Parser.init({ locateFile: (file) => path.join(wasmDirectory, file) });
  await initialization;
}

async function loadLanguage(language: string): Promise<Language | undefined> {
  const grammarFile = GRAMMAR_FILE[language];
  if (!grammarFile) return undefined;
  await initialize();
  let loading = languageCache.get(language);
  if (!loading) {
    loading = TreeSitterLanguage.load(path.join(wasmDirectory, grammarFile));
    languageCache.set(language, loading);
  }
  return await loading;
}

export class EvidenceParser {
  public readonly bundleVersion = "vscode-tree-sitter-wasm-0.3.1";

  public async parse(input: ParseEvidenceInput): Promise<ParsedFileEvidence> {
    const language = await loadLanguage(input.language);
    if (!language) {
      const extracted = extractLexicalEvidence(input.relativePath, input.language, input.content, input.contentHash);
      return {
        parserKind: "lexical",
        grammarVersion: "lexical-v1",
        status: "complete",
        ...extracted,
      };
    }
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(input.content);
    if (!tree) {
      parser.delete();
      throw new Error(`Tree-sitter parse 결과가 없습니다: ${input.relativePath}`);
    }
    try {
      const extracted = extractTreeEvidence(tree.rootNode, input.relativePath, input.content, input.contentHash);
      return {
        parserKind: "tree-sitter",
        grammarVersion: `vscode-tree-sitter-wasm-0.3.1:abi-${String(language.abiVersion)}`,
        status: extracted.parseErrorCount === 0 ? "complete" : "partial",
        ...extracted,
      };
    } finally {
      tree.delete();
      parser.delete();
    }
  }
}
