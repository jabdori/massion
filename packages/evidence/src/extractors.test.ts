import { describe, expect, it } from "vitest";

import { EvidenceParser } from "./parser.js";

describe("Evidence extractor integrity", () => {
  it("동명 method를 scope와 range가 다른 stable key로 구분하고 call target을 unresolved로 보존한다", async () => {
    const result = await new EvidenceParser().parse({
      relativePath: "scoped.ts",
      language: "typescript",
      content: "class First { run() { helper(); } }\nclass Second { run() { helper(); } }\n",
      contentHash: "e".repeat(64),
    });
    const methods = result.symbols.filter((symbol) => symbol.name === "run");
    const first = result.symbols.find((symbol) => symbol.qualifiedName === "First");

    expect(methods.map((symbol) => symbol.qualifiedName)).toEqual(["First.run", "Second.run"]);
    expect(result.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "contains",
          sourceSymbolKey: first?.symbolKey,
          targetSymbolKey: methods[0]?.symbolKey,
          resolved: true,
        }),
      ]),
    );
    expect(new Set(methods.map((symbol) => symbol.symbolKey)).size).toBe(2);
    expect(result.relations.filter((relation) => relation.kind === "calls")).toEqual([
      expect.objectContaining({ sourceSymbolKey: methods[0]?.symbolKey, targetText: "helper", resolved: false }),
      expect.objectContaining({ sourceSymbolKey: methods[1]?.symbolKey, targetText: "helper", resolved: false }),
    ]);
  });

  it("lexical fallback은 semantic calls/imports/implements를 만들지 않는다", async () => {
    const result = await new EvidenceParser().parse({
      relativePath: "unknown.txt",
      language: "text",
      content: "import Service\ncall run()\nimplements Contract\n",
      contentHash: "f".repeat(64),
    });

    expect(result.parserKind).toBe("lexical");
    expect(result.relations).toEqual([]);
  });

  it("같은 파일의 명확한 call과 implements target만 symbol key로 해석한다", async () => {
    const result = await new EvidenceParser().parse({
      relativePath: "resolved.ts",
      language: "typescript",
      content:
        "interface Contract {}\nclass Service implements Contract {}\nfunction helper() {}\nfunction main() { helper(); }\n",
      contentHash: "1".repeat(64),
    });
    const contract = result.symbols.find((symbol) => symbol.name === "Contract");
    const helper = result.symbols.find((symbol) => symbol.name === "helper");

    expect(result.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "implements", targetSymbolKey: contract?.symbolKey, resolved: true }),
        expect.objectContaining({ kind: "calls", targetSymbolKey: helper?.symbolKey, resolved: true }),
      ]),
    );
  });
});
