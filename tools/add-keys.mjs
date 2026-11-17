#!/usr/bin/env node
// Adds a layout card's keys to Herdr's keys.json: `node tools/add-keys.mjs vx-code`.
// Keys you already set in that section win; other sections are left alone.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const card = process.argv[2] ?? "vx-code";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.HERDR_APP_HOME ?? path.join(os.homedir(), ".config", "herdr-app");
const file = path.join(home, "keys.json");
const add = JSON.parse(fs.readFileSync(path.join(root, card, "keys.json"), "utf8"));
let keys = {};
try {
  keys = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (e) {
  if (e.code !== "ENOENT") throw new Error(`${file} isn't valid JSON; fix it first (${e.message})`);
}
const kept = [];
for (const [section, map] of Object.entries(add)) {
  const mine = keys[section] ?? {};
  for (const k of Object.keys(map)) if (k in mine && mine[k] !== map[k]) kept.push(`${section} ${k} (yours: ${mine[k]})`);
  keys[section] = { ...map, ...mine };
}
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(keys, null, 2)}\n`);
fs.renameSync(`${file}.tmp`, file);
console.log(`added ${card}'s keys to ${file}`);
if (kept.length) console.log(`kept your own:\n  ${kept.join("\n  ")}`);
