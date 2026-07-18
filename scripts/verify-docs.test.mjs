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

test("Phase 30 정합성 원장이 존재하면 별도 검증 실패를 문서 오류로 전달한다", async () => {
  const root = await fixture();
  const phase = join(root, "docs", "phases", "30-surface-parity-agent-ux");
  await mkdir(phase, { recursive: true });
  await writeFile(join(phase, "reconciliation-manifest.json"), "{ invalid json\n");

  assert.ok((await validateDocs(root)).some((error) => error.includes("Phase 30 정합성 원장")));
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

test("여러 단어로 구성된 요구사항 영역 식별자를 승인한다", async () => {
  const root = await fixture();
  const trace = join(root, "docs", "generated", "requirements-traceability.tsv");
  await writeFile(
    trace,
    "requirement_id\tsource\tphase\tdesign\tplan\ttests\tcommits\truntime_events\tmetrics\tstatus\tevidence\n" +
      "REQ-CORE-BOUNDARY-001\tspec:1\t0\tdocs/product/design.md\tdocs/phases/00-lineage/implementation-plan.md\tnot-applicable\tpending\tevent\tmetric\tapproved\tevidence\n",
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

test("완료 Phase의 미체크 구현 작업을 거부한다", async () => {
  const root = await fixture();
  await writeFile(
    join(root, "docs", "phases", "00-lineage", "implementation-plan.md"),
    "# Plan\n\n- [ ] 아직 완료하지 않은 작업\n",
  );
  await writeFile(join(root, "docs", "phases", "00-lineage", "review.md"), "# Review\n\n> **상태**: completed\n");

  assert.ok((await validateDocs(root)).some((error) => error.includes("미체크 구현 작업")));
});

test("완료 Phase 계획의 본문 속 체크박스 문법 설명은 미체크 작업으로 보지 않는다", async () => {
  const root = await fixture();
  await writeFile(
    join(root, "docs", "phases", "00-lineage", "implementation-plan.md"),
    "# Plan\n\n체크박스(`- [ ]`) 문법을 사용합니다.\n\n- [x] 완료한 작업\n",
  );
  await writeFile(join(root, "docs", "phases", "00-lineage", "review.md"), "# Review\n\n> **상태**: completed\n");

  assert.deepEqual(await validateDocs(root), []);
});

test("완료 요구사항이 가리키는 존재하지 않는 테스트와 증거를 거부한다", async () => {
  const root = await fixture();
  const trace = join(root, "docs", "generated", "requirements-traceability.tsv");
  await writeFile(
    trace,
    "requirement_id\tsource\tphase\tdesign\tplan\ttests\tcommits\truntime_events\tmetrics\tstatus\tevidence\n" +
      "REQ-CORE-001\tspec:1\t0\tdocs/product/design.md\tdocs/phases/00-lineage/implementation-plan.md\ttests/missing.test.ts\tpending\tevent\tmetric\tcompleted\tdocs/evidence/missing.md\n",
  );

  const errors = await validateDocs(root);
  assert.ok(errors.some((error) => error.includes("존재하지 않는 추적 경로 tests/missing.test.ts")));
  assert.ok(errors.some((error) => error.includes("존재하지 않는 추적 경로 docs/evidence/missing.md")));
});

test("완료 요구사항이 가리키는 존재하지 않는 커밋을 거부한다", async () => {
  const root = await fixture();
  const trace = join(root, "docs", "generated", "requirements-traceability.tsv");
  await writeFile(
    trace,
    "requirement_id\tsource\tphase\tdesign\tplan\ttests\tcommits\truntime_events\tmetrics\tstatus\tevidence\n" +
      "REQ-CORE-001\tspec:1\t0\tdocs/product/design.md\tdocs/phases/00-lineage/implementation-plan.md\tnot-applicable\tdeadbeef\tevent\tmetric\tcompleted\tnot-applicable\n",
  );

  assert.ok((await validateDocs(root)).some((error) => error.includes("존재하지 않는 추적 커밋 deadbeef")));
});
