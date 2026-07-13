import { describe, expect, it } from "vitest";

import { createEvaluationExport, validateEvaluationExport } from "./transfer.js";

const checksum = (letter: string) => letter.repeat(64);
const bundle = {
  bundleId: "bundle-1",
  roleKey: "assurance" as const,
  version: 2,
  caseIds: ["case-1"],
  runtimeVersion: "runtime-1",
  checksum: checksum("a"),
  status: "active" as const,
};
const cases = [
  {
    caseId: "case-1",
    roleKey: "assurance" as const,
    version: 2,
    promptChecksum: checksum("b"),
    toolsChecksum: checksum("c"),
    environmentChecksum: checksum("d"),
    prompt: "검증 결과를 요약하세요.",
    expectedOutcome: "요약",
  },
];

describe("모델 평가실 import/export 경계", () => {
  it("라이선스·설정 checksum·bundle case 계보를 포함한 export를 결정론적으로 만든다", () => {
    const exported = createEvaluationExport({
      license: "CC-BY-4.0",
      configurationChecksum: checksum("e"),
      bundle,
      cases,
    });
    expect(validateEvaluationExport(exported)).toEqual(exported);
    expect(exported).toMatchObject({ schema: "massion.model-optimization-export.v1", exportVersion: 1 });
    expect(exported.checksum).toHaveLength(64);
    expect(
      createEvaluationExport({ license: "CC-BY-4.0", configurationChecksum: checksum("e"), bundle, cases }),
    ).toEqual(exported);
  });

  it("라이선스나 case role이 계보와 다르면 import를 거부한다", () => {
    const exported = createEvaluationExport({
      license: "MIT",
      configurationChecksum: checksum("f"),
      bundle,
      cases,
    });
    expect(() =>
      validateEvaluationExport({
        ...exported,
        license: "MIT\nforged",
      }),
    ).toThrow("license");
    expect(() =>
      validateEvaluationExport({
        ...exported,
        cases: [{ ...cases[0], roleKey: "growth" }],
      }),
    ).toThrow("role");
  });
});
