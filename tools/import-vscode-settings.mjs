#!/usr/bin/env node
// One-shot import of the user's VS Code look and behavior into herdr-vscode's settings.json:
//   node tools/import-vscode-settings.mjs [--from <VS Code settings.json>] [--herdr] [--dry-run]
// --herdr also writes the terminal font keys into Herdr's own settings.json (Herdr has no
// per-mod terminal font). Reads only the keys it maps, so no secret is ever copied or printed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseJsonc } from "../shared/jsonc.js";
import { withSettings, formatSettings, parseSettings } from "../shared/settings-core.js";
import { mapVscodeSettings, herdrTerminalSettings } from "./vscode-core.mjs";

const SOURCES = [
  "Library/Application Support/Code - Insiders/User/settings.json",
  "Library/Application Support/Code/User/settings.json",
  ".config/Code - Insiders/User/settings.json",
  ".config/Code/User/settings.json",
];
const OURS = ".config/herdr-vscode/settings.json";
const HERDR = ".config/herdr-app/settings.json";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const fromIndex = args.indexOf("--from");
const home = os.homedir();
const source = fromIndex >= 0 ? args[fromIndex + 1] : SOURCES.map((rel) => path.join(home, rel)).find((file) => fs.existsSync(file));
if (!source || !fs.existsSync(source)) {
  console.error("import-vscode-settings: no VS Code settings.json found; pass --from <file>");
  process.exit(1);
}

const vscode = parseJsonc(fs.readFileSync(source, "utf8"));
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);

function writeJson(file, next) {
  if (flag("--dry-run")) {
    console.log(`would write ${file}:\n${formatSettings(next)}`);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, formatSettings(next));
  console.log(`import-vscode-settings: wrote ${file}`);
}

const oursFile = path.join(home, OURS);
const parsed = parseSettings(read(oursFile));
if (parsed.error) {
  console.error(`import-vscode-settings: ${oursFile} is not valid JSON (${parsed.error}); fix it first`);
  process.exit(1);
}
let ours = parsed.settings;
for (const [section, values] of Object.entries(mapVscodeSettings(vscode))) {
  if (Object.keys(values).length) {
    ours = withSettings(ours, section, values);
    console.log(`  ${section}: ${JSON.stringify(values)}`);
  }
}
writeJson(oursFile, ours);

if (flag("--herdr")) {
  const herdrFile = path.join(home, HERDR);
  const herdr = JSON.parse(read(herdrFile) ?? "{}");
  const terminal = herdrTerminalSettings(vscode);
  console.log(`  herdr-app: ${JSON.stringify(terminal)}`);
  writeJson(herdrFile, { ...herdr, ...terminal });
}
