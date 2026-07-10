import { describe, expect, it } from "vitest";

import { EvidenceParser } from "./parser.js";

const FIXTURES = [
  {
    language: "typescript",
    path: "src/service.ts",
    content: 'import { helper } from "./helper.js";\nexport class Service { run() { helper(); } }\n',
    symbol: "Service",
    relation: "imports",
  },
  {
    language: "tsx",
    path: "src/view.tsx",
    content: "export function View() { return <main>Ready</main>; }\n",
    symbol: "View",
  },
  {
    language: "javascript",
    path: "src/main.js",
    content: "export function main() { return 1; }\n",
    symbol: "main",
  },
  {
    language: "go",
    path: "main.go",
    content: 'package main\nimport "fmt"\ntype Service struct{}\nfunc main() { fmt.Println("ready") }\n',
    symbol: "Service",
    relation: "imports",
  },
  {
    language: "python",
    path: "service.py",
    content: "import os\nclass Service:\n    def run(self):\n        return os.getcwd()\n",
    symbol: "Service",
    relation: "imports",
  },
  {
    language: "rust",
    path: "src/main.rs",
    content: "use std::fmt;\nstruct Service {}\nfn main() {}\n",
    symbol: "Service",
    relation: "imports",
  },
  {
    language: "java",
    path: "src/Service.java",
    content: "import java.util.List;\nclass Service { void run() {} }\n",
    symbol: "Service",
    relation: "imports",
  },
  {
    language: "c_sharp",
    path: "Service.cs",
    content: "using System;\nclass Service { void Run() {} }\n",
    symbol: "Service",
    relation: "imports",
  },
  {
    language: "c",
    path: "main.c",
    content: "#include <stdio.h>\nstruct Service { int value; };\nint main(void) { return 0; }\n",
    symbol: "Service",
    relation: "imports",
  },
  {
    language: "cpp",
    path: "main.cpp",
    content: "#include <vector>\nclass Service { public: void run() {} };\nint main() { return 0; }\n",
    symbol: "Service",
    relation: "imports",
  },
  {
    language: "php",
    path: "Service.php",
    content: "<?php\nclass Service { public function run() {} }\n",
    symbol: "Service",
  },
  {
    language: "ruby",
    path: "service.rb",
    content: "class Service\n  def run\n    true\n  end\nend\n",
    symbol: "Service",
  },
  {
    language: "bash",
    path: "script.sh",
    content: "run() { echo ready; }\nrun\n",
    symbol: "run",
  },
  {
    language: "css",
    path: "style.css",
    content: ".root { color: red; }\n",
    symbol: ".root",
  },
] as const;

describe("Tree-sitter WASM evidence parser", () => {
  it.each(FIXTURES)("$language source를 실제 WASM grammar로 parse한다", async (fixture) => {
    const parser = new EvidenceParser();
    const result = await parser.parse({
      relativePath: fixture.path,
      language: fixture.language,
      content: fixture.content,
      contentHash: "a".repeat(64),
    });

    expect(result).toMatchObject({ parserKind: "tree-sitter", status: "complete", parseErrorCount: 0 });
    expect(result.grammarVersion).toContain("vscode-tree-sitter-wasm-0.3.1");
    expect(result.symbols.map((symbol) => symbol.name)).toContain(fixture.symbol);
    expect(result.symbols.every((symbol) => symbol.startLine >= 1 && symbol.endLine >= symbol.startLine)).toBe(true);
    if ("relation" in fixture) expect(result.relations.map((relation) => relation.kind)).toContain(fixture.relation);
  });

  it("문법 오류를 숨기지 않고 partial file result로 표시한다", async () => {
    const result = await new EvidenceParser().parse({
      relativePath: "broken.ts",
      language: "typescript",
      content: "export function broken( {\n",
      contentHash: "b".repeat(64),
    });

    expect(result.status).toBe("partial");
    expect(result.parseErrorCount).toBeGreaterThan(0);
  });

  it("Markdown과 unknown text는 lexical chunk만 만들고 semantic relation을 추정하지 않는다", async () => {
    const parser = new EvidenceParser();
    const markdown = await parser.parse({
      relativePath: "README.md",
      language: "markdown",
      content: "# Product\n\nEvidence text.\n\n## Verification\n\nDone.\n",
      contentHash: "c".repeat(64),
    });
    const text = await parser.parse({
      relativePath: "notes.custom",
      language: "text",
      content: "first paragraph\n\nsecond paragraph\n",
      contentHash: "d".repeat(64),
    });

    expect(markdown).toMatchObject({ parserKind: "lexical", status: "complete", relations: [] });
    expect(markdown.symbols.map((symbol) => symbol.name)).toEqual(["Product", "Verification"]);
    expect(markdown.chunks.length).toBeGreaterThan(0);
    expect(text).toMatchObject({ parserKind: "lexical", status: "complete", symbols: [], relations: [] });
    expect(text.chunks).toHaveLength(2);
  });
});
