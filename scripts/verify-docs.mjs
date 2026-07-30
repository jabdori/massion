import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function markdownFiles(path) {
  if (!(await exists(path))) return [];
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(child)));
    if (entry.isFile() && entry.name.endsWith(".md")) files.push(child);
  }
  return files;
}

async function validateMarkdown(root, errors) {
  const docs = join(root, "docs");
  const candidates = [
    join(root, "README.md"),
    join(root, "README.ko.md"),
    join(docs, "README.md"),
    join(docs, "README.ko.md"),
    join(root, "apps", "desktop", "README.md"),
    join(root, "apps", "desktop", "README.ko.md"),
    join(root, "apps", "desktop", "DESIGN.md"),
    join(root, "apps", "desktop", "DESIGN.ko.md"),
    ...(await markdownFiles(join(docs, "product"))),
    ...(await markdownFiles(join(docs, "history"))),
    ...(await markdownFiles(join(docs, "architecture"))),
    ...(await markdownFiles(join(docs, "decisions"))),
    ...(await markdownFiles(join(docs, "operations"))),
  ];
  for (const path of [...new Set(candidates)]) {
    if (!(await exists(path))) continue;
    const content = await readFile(path, "utf8");
    if (/\b(?:TODO|TBD|FIXME)\b/.test(content)) {
      errors.push(`${relative(root, path)}: 금지된 임시 표기`);
    }
    for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].replace(/^<|>$/g, "").split("#", 1)[0];
      if (!target || /^(?:https?:|mailto:|\/)/.test(target)) continue;
      const resolved = resolve(dirname(path), decodeURIComponent(target));
      if (!(await exists(resolved))) errors.push(`${relative(root, path)}: 깨진 로컬 링크 ${match[1]}`);
    }
  }
}

async function validateLanguagePairs(root, errors) {
  const pairs = [
    ["README.md", "README.ko.md"],
    ["docs/README.md", "docs/README.ko.md"],
    ["docs/product/constitution.md", "docs/product/constitution.ko.md"],
    ["docs/architecture/README.md", "docs/architecture/README.ko.md"],
    ["docs/architecture/desktop-clean-sheet.md", "docs/architecture/desktop-clean-sheet.ko.md"],
    ["docs/architecture/ADR-001-personal-full-access.md", "docs/architecture/ADR-001-personal-full-access.ko.md"],
    [
      "docs/architecture/ADR-002-knowledge-axis-restoration.md",
      "docs/architecture/ADR-002-knowledge-axis-restoration.ko.md",
    ],
    [
      "docs/architecture/ADR-003-task-aware-model-placement.md",
      "docs/architecture/ADR-003-task-aware-model-placement.ko.md",
    ],
    ["apps/desktop/README.md", "apps/desktop/README.ko.md"],
    ["apps/desktop/DESIGN.md", "apps/desktop/DESIGN.ko.md"],
  ];
  for (const [english, korean] of pairs) {
    const englishExists = await exists(join(root, english));
    const koreanExists = await exists(join(root, korean));
    if (!englishExists && !koreanExists) continue;
    if (!englishExists || !koreanExists) {
      errors.push(`${englishExists ? korean : english}: 언어 동반 문서 누락`);
      continue;
    }
    const englishContent = await readFile(join(root, english), "utf8");
    const koreanContent = await readFile(join(root, korean), "utf8");
    if (!englishContent.includes(korean.split("/").at(-1))) errors.push(`${english}: 한국어 문서 링크 누락`);
    if (!koreanContent.includes(english.split("/").at(-1))) errors.push(`${korean}: 영어 문서 링크 누락`);
  }
}

export async function validateDocs(root) {
  const errors = [];
  await validateMarkdown(root, errors);
  await validateLanguagePairs(root, errors);
  return errors.sort();
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const root = resolve(scriptDir, "..");
  const errors = await validateDocs(root);
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`ERROR ${error}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("문서 구조 검증 통과\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
