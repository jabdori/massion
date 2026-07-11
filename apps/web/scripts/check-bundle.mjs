import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

const assets = resolve(import.meta.dirname, "../dist/assets");
const files = await readdir(assets);
const scripts = files.filter((file) => file.endsWith(".js"));
const sizes = await Promise.all(
  scripts.map(async (file) => ({ file, bytes: (await stat(resolve(assets, file))).size })),
);
const oversized = sizes.filter(({ bytes }) => bytes > 250 * 1024);
if (oversized.length > 0) throw new Error(`250 KiB를 넘는 Web chunk가 있습니다: ${JSON.stringify(oversized)}`);
process.stdout.write(`${String(scripts.length)}개 Web chunk가 250 KiB budget 안입니다.\n`);
