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
  await writeFile(join(root, "docs", "product", "design.md"), "# Design\n");
  return root;
}

test("공개 문서 구조를 승인한다", async () => {
  assert.deepEqual(await validateDocs(await fixture()), []);
});

test("존재하지 않는 로컬 Markdown 링크를 거부한다", async () => {
  const root = await fixture();
  await writeFile(join(root, "docs", "product", "design.md"), "# Design\n\n[missing](../missing.md)\n");
  assert.ok((await validateDocs(root)).some((error) => error.includes("깨진 로컬 링크")));
});

test("공개 문서의 임시 표기를 거부한다", async () => {
  const root = await fixture();
  await writeFile(join(root, "docs", "product", "design.md"), "# Design\n\nTODO\n");
  assert.ok((await validateDocs(root)).some((error) => error.includes("금지된 임시 표기")));
});

test("언어 동반 문서 누락을 거부한다", async () => {
  const root = await fixture();
  await writeFile(join(root, "README.md"), "# Massion\n\n[한국어](README.ko.md)\n");
  assert.ok((await validateDocs(root)).some((error) => error.includes("언어 동반 문서 누락")));
});

test("영어와 한국어 문서의 상호 링크를 요구한다", async () => {
  const root = await fixture();
  await writeFile(join(root, "README.md"), "# Massion\n");
  await writeFile(join(root, "README.ko.md"), "# Massion\n");
  const errors = await validateDocs(root);
  assert.ok(errors.some((error) => error.includes("한국어 문서 링크 누락")));
  assert.ok(errors.some((error) => error.includes("영어 문서 링크 누락")));
});
