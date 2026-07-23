import { realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

/** 승인된 archive 안의 worker 진입점만 실행한다. */
export function resolveWorkerEntrypoint(versionDirectory: string, entrypoint: string): string {
  const root = realpathSync(versionDirectory);
  if (isAbsolute(entrypoint) || entrypoint.includes("\\") || entrypoint.split("/").includes("..")) {
    throw new Error("Extension worker entrypoint가 유효하지 않습니다");
  }
  const target = resolve(root, entrypoint);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error("Extension worker entrypoint가 version directory를 벗어났습니다");
  }
  return target;
}
