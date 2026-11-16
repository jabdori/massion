import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * The canonical temp root for test fixtures: the real path of the OS temp
 * directory, computed once per process.
 *
 * On macOS the OS temp directory is reached through a symlink (`/var` is
 * `/private/var`, `/tmp` is `/private/tmp`). The product refuses a workspace
 * or artifact root whose path contains a symlinked component, so a fixture
 * built under `tmpdir()` is refused before the test reaches what it tests.
 * Fixtures must therefore be built under this root, never under `tmpdir()`.
 */
const canonical = realpathSync(tmpdir());

/** The real path of the OS temp directory. Never a symlinked path. */
export function tempRoot(): string {
  return canonical;
}
