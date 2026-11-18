#!/usr/bin/env node
// Usage: `node tools/add-keys.mjs herdr-vscode`. Keys already set in a section win.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const DEFAULT_CARD = "herdr-vscode";

const card = process.argv[2] ?? DEFAULT_CARD;
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const appHome = process.env.HERDR_APP_HOME ?? path.join(os.homedir(), ".config", "herdr-app");
const keysFile = path.join(appHome, "keys.json");
const cardKeys = JSON.parse(fs.readFileSync(path.join(repoRoot, card, "keys.json"), "utf8"));

function readKeys() {
  try {
    return JSON.parse(fs.readFileSync(keysFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(`${keysFile} isn't valid JSON; fix it first (${error.message})`);
    }
    return {};
  }
}

const keys = readKeys();
const kept = [];
for (const [section, bindings] of Object.entries(cardKeys)) {
  const userBindings = keys[section] ?? {};
  const overridden = Object.keys(bindings).filter((key) => key in userBindings && userBindings[key] !== bindings[key]);
  kept.push(...overridden.map((key) => `${section} ${key} (yours: ${userBindings[key]})`));
  keys[section] = { ...bindings, ...userBindings };
}
fs.mkdirSync(appHome, { recursive: true });
fs.writeFileSync(`${keysFile}.tmp`, `${JSON.stringify(keys, null, 2)}\n`);
fs.renameSync(`${keysFile}.tmp`, keysFile);
console.log(`added ${card}'s keys to ${keysFile}`);
if (kept.length) {
  console.log(`kept your own:\n  ${kept.join("\n  ")}`);
}
