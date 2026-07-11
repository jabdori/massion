import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

export async function resolveTokenReference(
  reference: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (reference.startsWith("env:")) {
    const name = reference.slice(4);
    if (!/^[A-Z][A-Z0-9_]{1,127}$/u.test(name) || !environment[name])
      throw new Error("token 환경 변수 참조가 유효하지 않습니다");
    return environment[name];
  }
  if (reference.startsWith("file:")) {
    const path = reference.slice(5);
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0)
      throw new Error("token reference file은 symlink가 아닌 0600 regular file이어야 합니다");
    const token = (await readFile(path, "utf8")).trim();
    if (!token) throw new Error("token reference file이 비어 있습니다");
    return token;
  }
  if (reference.startsWith("keychain:")) {
    const [service, account] = reference.slice(9).split("/", 2);
    if (!service || !account || process.platform !== "darwin")
      throw new Error("macOS keychain token reference가 유효하지 않습니다");
    const result = await executeFile(
      "/usr/bin/security",
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      { encoding: "utf8", maxBuffer: 64 * 1024 },
    );
    const token = result.stdout.trim();
    if (!token) throw new Error("macOS keychain token을 찾을 수 없습니다");
    return token;
  }
  throw new Error("지원하지 않는 token reference입니다");
}
