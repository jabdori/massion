import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateDocs } from "./verify-docs.mjs";

async function fixture() {
  const root = join(tmpdir(), `massion-docs-${randomUUID()}`);
  await mkdir(join(root, "docs", "product"), { recursive: true });
  await mkdir(join(root, "docs", "phases", "00-lineage"), { recursive: true });
  await mkdir(join(root, "docs", "generated"), { recursive: true });
  await writeFile(join(root, "docs", "product", "design.md"), "# Design\n");
  await writeFile(join(root, "docs", "phases", "00-lineage", "design.md"), "# Phase\n");
  await writeFile(join(root, "docs", "phases", "00-lineage", "implementation-plan.md"), "# Plan\n");
  await writeFile(
    join(root, "docs", "generated", "requirements-traceability.tsv"),
    "requirement_id\tsource\tphase\tdesign\tplan\ttests\tcommits\truntime_events\tmetrics\tstatus\tevidence\n" +
      "REQ-CORE-001\tspec:1\t0\tdocs/product/design.md\tdocs/phases/00-lineage/implementation-plan.md\tnot-applicable\tpending\tevent\tmetric\tapproved\tevidence\n",
  );
  return root;
}

test("유효한 문서 구조를 승인한다", async () => {
  const root = await fixture();
  assert.deepEqual(await validateDocs(root), []);
});

test("숫자가 포함된 의미 있는 요구사항 영역 식별자를 승인한다", async () => {
  const root = await fixture();
  const trace = join(root, "docs", "generated", "requirements-traceability.tsv");
  await writeFile(
    trace,
    "requirement_id\tsource\tphase\tdesign\tplan\ttests\tcommits\truntime_events\tmetrics\tstatus\tevidence\n" +
      "REQ-E2E-001\tspec:1\t0\tdocs/product/design.md\tdocs/phases/00-lineage/implementation-plan.md\tnot-applicable\tpending\tevent\tmetric\tapproved\tevidence\n",
  );
  assert.deepEqual(await validateDocs(root), []);
});

test("중복 요구사항 식별자를 거부한다", async () => {
  const root = await fixture();
  const trace = join(root, "docs", "generated", "requirements-traceability.tsv");
  await writeFile(
    trace,
    "requirement_id\tsource\tphase\tdesign\tplan\ttests\tcommits\truntime_events\tmetrics\tstatus\tevidence\n" +
      "REQ-CORE-001\tspec:1\t0\tdocs/product/design.md\tdocs/phases/00-lineage/implementation-plan.md\tnot-applicable\tpending\tevent\tmetric\tapproved\tevidence\n" +
      "REQ-CORE-001\tspec:2\t0\tdocs/product/design.md\tdocs/phases/00-lineage/implementation-plan.md\tnot-applicable\tpending\tevent\tmetric\tapproved\tevidence\n",
  );
  assert.ok((await validateDocs(root)).some((error) => error.includes("중복 요구사항 ID")));
});

test("구조화된 Phase의 필수 파일 누락을 거부한다", async () => {
  const root = await fixture();
  await mkdir(join(root, "docs", "phases", "01-foundation"), { recursive: true });
  await writeFile(join(root, "docs", "phases", "01-foundation", "design.md"), "# Phase 1\n");
  assert.ok((await validateDocs(root)).some((error) => error.includes("implementation-plan.md 누락")));
});

test("존재하지 않는 로컬 Markdown 링크를 거부한다", async () => {
  const root = await fixture();
  await writeFile(join(root, "docs", "product", "design.md"), "# Design\n\n[missing](../missing.md)\n");
  assert.ok((await validateDocs(root)).some((error) => error.includes("깨진 로컬 링크")));
});
