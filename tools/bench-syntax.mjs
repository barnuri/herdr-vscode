// node tools/bench-syntax.mjs: ms per 1000 lines for the code view lexer, per language sample.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lexLines, languageOf } from "../shared/syntax-core.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLES = path.join(ROOT, "tests/fixtures/syntax");
const TARGET_LINES = 50000;
const ROUNDS = 5;

let total = 0;
let totalMs = 0;
for (const name of readdirSync(SAMPLES).sort()) {
  const lines = readFileSync(path.join(SAMPLES, name), "utf8").split("\n");
  const copies = Math.ceil(TARGET_LINES / lines.length);
  const big = Array.from({ length: copies }, () => lines).flat();
  const lang = languageOf(name);
  lexLines(big, lang);
  let best = Infinity;
  for (let round = 0; round < ROUNDS; round++) {
    const start = performance.now();
    lexLines(big, lang);
    best = Math.min(best, performance.now() - start);
  }
  total += big.length;
  totalMs += best;
  console.log(`${name.padEnd(16)} ${lang.padEnd(6)} ${(best / big.length * 1000).toFixed(2)} ms/1000 lines`);
}
console.log(`${"all".padEnd(23)} ${(totalMs / total * 1000).toFixed(2)} ms/1000 lines`);
