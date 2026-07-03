// Removes the bundler-emitted ORT wasm duplicate from dist/assets — the
// runtime loads its wasm from /ort/ (see separate.ts), so the ~27MB asset
// copy is dead weight that pushed the Pages artifact over the edge.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const assets = path.join(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  "dist",
  "assets",
);
if (fs.existsSync(assets)) {
  for (const f of fs.readdirSync(assets)) {
    if (f.endsWith(".wasm")) {
      fs.unlinkSync(path.join(assets, f));
      console.log(`pruned dist/assets/${f}`);
    }
  }
}
