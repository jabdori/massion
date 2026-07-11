import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileArtifactStore } from "./artifact-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("Registry artifact store", () => {
  it("SHA-256 내용 주소로 원자 저장하고 다른 byte 덮어쓰기를 거부한다", async () => {
    const root = await mkdtemp(join(tmpdir(), "massion-registry-blob-"));
    roots.push(root);
    const store = new FileArtifactStore(root);
    const body = Buffer.from("immutable artifact");
    const digest = createHash("sha256").update(body).digest("hex");
    await store.put(digest, body);
    await store.put(digest, body);
    expect(await store.get(digest)).toEqual(body);
    await expect(store.put(digest, Buffer.from("changed"))).rejects.toThrow("digest");
  });
});
