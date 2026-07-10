import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";

import { createDatabase, DeclarationStore } from "../dist/index.js";

const [mode, root] = process.argv.slice(2);
if (!mode || !root) throw new Error("usage: rocksdb-probe.mjs <write|read> <directory>");

const fileUrl = pathToFileURL(join(root, "runtime.db"));
const database = await createDatabase({
  url: `rocksdb://${fileUrl.pathname}`,
  namespace: "massion",
  database: "contract",
});

let output;
try {
  const store = await DeclarationStore.create(database);
  if (mode === "write") {
    await store.apply("project-a", { durable: true });
  } else if (mode === "read") {
    output = JSON.stringify((await store.list("project-a")).map((item) => item.content));
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }
} finally {
  await database.close();
}

if (output) writeFileSync(1, output);
process.exit(0);
