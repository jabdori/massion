import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const documentPath = "docs/architecture/README.md";
const mermaidCliVersion = "11.16.0";
const requiredHeadings = [
  "## 1. 읽는 법과 상태 범례",
  "## 2. 전체 시스템 지도",
  "## 3. 제품 구성요소와 패키지 경계",
  "## 4. Core Office와 전문 조직",
  "## 5. Work 처리 전체 흐름",
  "## 6. 실행·승인·차단·취소·복구",
  "## 7. 에이전트 협업과 대화",
  "## 8. 모델 계정·Provider 라우팅",
  "## 9. 데이터·명령·이벤트 계보",
  "## 10. Extension·Registry·격리",
  "## 11. 개인·팀 배포 구조",
  "## 12. 구현 위치와 Phase 상태 색인",
];
const forbidden = ["Dual Storage", "SQLite + sqlite-vec", ["T", "B", "D"].join(""), ["T", "O", "D", "O"].join("")];
const localPathPrefixes = ["apps/", "docs/", "packages/", "scripts/"];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function mermaidBlocks(markdown) {
  return [...markdown.matchAll(/```mermaid\s*\n([\s\S]*?)```/gu)].map((match) => match[1].trim());
}

function referencedPaths(markdown) {
  const codePaths = [...markdown.matchAll(/`([^`\n]+)`/gu)].map((match) => match[1]);
  const linkPaths = [...markdown.matchAll(/\]\(([^)#]+)(?:#[^)]+)?\)/gu)].map((match) => match[1]);
  return [...new Set([...codePaths, ...linkPaths])].filter(
    (value) => value === "package.json" || localPathPrefixes.some((prefix) => value.startsWith(prefix)),
  );
}

async function validateStructure(markdown) {
  const errors = [];
  for (const heading of requiredHeadings) {
    if (!markdown.includes(heading)) errors.push(`필수 제목이 없습니다: ${heading}`);
  }
  const blocks = mermaidBlocks(markdown);
  if (blocks.length !== 10) errors.push(`Mermaid 다이어그램은 정확히 10개여야 합니다: ${String(blocks.length)}개`);
  for (const text of forbidden) {
    if (markdown.includes(text)) errors.push(`대체되었거나 임시인 표현이 남아 있습니다: ${text}`);
  }
  for (const path of referencedPaths(markdown)) {
    if (!(await exists(resolve(path)))) errors.push(`참조한 로컬 경로가 없습니다: ${path}`);
  }
  return { blocks, errors };
}

async function render(blocks) {
  const directory = await mkdtemp(join(tmpdir(), "massion-architecture-"));
  try {
    const browserCandidates = [
      process.env.MASSION_MERMAID_BROWSER,
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ].filter(Boolean);
    let browserExecutable;
    for (const candidate of browserCandidates) {
      if (await exists(candidate)) {
        browserExecutable = candidate;
        break;
      }
    }
    if (!browserExecutable) {
      throw new Error(
        "Mermaid 렌더링용 Chrome·Chromium을 찾을 수 없습니다. MASSION_MERMAID_BROWSER에 실행 파일 경로를 지정해주세요",
      );
    }
    const puppeteerConfig = join(directory, "puppeteer.json");
    await writeFile(puppeteerConfig, `${JSON.stringify({ executablePath: browserExecutable })}\n`, "utf8");
    for (const [index, block] of blocks.entries()) {
      const input = join(directory, `diagram-${String(index + 1)}.mmd`);
      const output = join(directory, `diagram-${String(index + 1)}.svg`);
      await writeFile(input, `${block}\n`, "utf8");
      const result = spawnSync(
        "pnpm",
        [
          "dlx",
          `@mermaid-js/mermaid-cli@${mermaidCliVersion}`,
          "--input",
          input,
          "--output",
          output,
          "--puppeteerConfigFile",
          puppeteerConfig,
          "--quiet",
        ],
        { encoding: "utf8", timeout: 120_000 },
      );
      if (result.status !== 0) {
        throw new Error(`Mermaid ${String(index + 1)}번 렌더링 실패\n${result.stderr || result.stdout || "출력 없음"}`);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  const absoluteDocumentPath = resolve(documentPath);
  if (!(await exists(absoluteDocumentPath))) throw new Error(`${documentPath}를 찾을 수 없습니다`);
  const markdown = await readFile(absoluteDocumentPath, "utf8");
  const { blocks, errors } = await validateStructure(markdown);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  if (!process.argv.includes("--structure-only")) await render(blocks);
  process.stdout.write(`아키텍처 다이어그램 ${String(blocks.length)}개 검증 통과\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "알 수 없는 아키텍처 검증 오류"}\n`);
  process.exitCode = 1;
});
