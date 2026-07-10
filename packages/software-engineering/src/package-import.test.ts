import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("Software Engineering 배포 package", () => {
  it("Node.js ESM consumer가 package root 산출물을 import할 수 있다", async () => {
    const packageRoot = join(import.meta.dirname, "..");
    const result = await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import('./dist/index.js').then((module) => console.log(module.SoftwareAssuranceAdapter.name))",
      ],
      { cwd: packageRoot, encoding: "utf8" },
    );

    expect(result.stdout.trim()).toBe("SoftwareAssuranceAdapter");
    expect(result.stderr).toBe("");
  });
});
