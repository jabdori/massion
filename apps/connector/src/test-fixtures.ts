import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function fixtureDirectory(prefix: string): Promise<{
  readonly path: string;
  readonly cleanup: () => Promise<void>;
}> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  return {
    path,
    cleanup: async () => {
      await rm(path, { recursive: true, force: true });
    },
  };
}
