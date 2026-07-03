// Copies onnxruntime-web's wasm runtime into public/ort/ so it is served
// identically in dev and production (gitignored; runs via predev/prebuild).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, "node_modules", "onnxruntime-web", "dist");
const dst = path.join(root, "public", "ort");
fs.mkdirSync(dst, { recursive: true });
let n = 0;
for (const f of fs.readdirSync(src)) {
  if (/^ort-wasm-simd-threaded.*\.(wasm|mjs)$/.test(f)) {
    fs.copyFileSync(path.join(src, f), path.join(dst, f));
    n++;
  }
}
console.log(`copied ${n} ORT runtime file(s) to public/ort/`);
