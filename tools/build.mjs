#!/usr/bin/env node
// A Herdr mod can only import files from its own folder and installs by copying that folder,
// so every mods/vx-*/ carries a copy of shared/*.js. Edit shared/, then run this.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CARDS, LAYOUT_CARDS, layoutMods } from "./cards.mjs";

const COPY_EXCLUDE = /(\/cache|\.DS_Store|jsconfig\.json|\.d\.ts)$/;

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sharedFiles = fs.readdirSync(path.join(repoRoot, "shared")).filter((file) => file.endsWith(".js"));
const modNames = fs.readdirSync(path.join(repoRoot, "mods")).filter((mod) => mod.startsWith("vx-"));

const modFile = (mod, file) => path.join(repoRoot, "mods", mod, file);
const readText = (file) => fs.readFileSync(file, "utf8");

function mostCommon(texts) {
  const counts = new Map();
  for (const text of texts) {
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

// A mod's own file named like a shared file would be overwritten. Copies of a shared file are
// identical across mods, so a file that is unique or differs from the others is the mod's own.
function clashesOf(file) {
  const holders = modNames.filter((mod) => fs.existsSync(modFile(mod, file)));
  const texts = new Map(holders.map((mod) => [mod, readText(modFile(mod, file))]));
  if (holders.length === 1 && modNames.length > 1) {
    const differs = texts.get(holders[0]) !== readText(path.join(repoRoot, "shared", file));
    return differs ? [`mods/${holders[0]}/${file}`] : [];
  }
  const common = mostCommon(texts.values());
  return [...texts].filter(([, text]) => text !== common).map(([mod]) => `mods/${mod}/${file}`);
}

const clashes = sharedFiles.flatMap(clashesOf);
if (clashes.length) {
  console.error(`build: these mod files share a name with shared/ and would be overwritten:\n  ${clashes.join("\n  ")}\nRename the shared file (or delete the stale copy).`);
  process.exit(1);
}

let changed = 0;
for (const mod of modNames) {
  for (const file of sharedFiles) {
    const source = readText(path.join(repoRoot, "shared", file));
    const target = modFile(mod, file);
    if (fs.existsSync(target) && readText(target) === source) {
      continue;
    }
    fs.writeFileSync(target, source);
    changed++;
  }
}
console.log(`build: ${sharedFiles.length} shared files in each mod (${changed} updated)`);

// RECIPE.md and preview.png in each card folder are written by hand; everything else is copied.
function copyDir(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true, filter: (file) => !COPY_EXCLUDE.test(file) });
}

function buildModCard(card, mods) {
  const cardMods = path.join(repoRoot, card, "mods");
  fs.mkdirSync(cardMods, { recursive: true });
  for (const stale of fs.readdirSync(cardMods).filter((mod) => !mods.includes(mod))) {
    fs.rmSync(path.join(cardMods, stale), { recursive: true, force: true });
  }
  for (const mod of mods) {
    copyDir(path.join(repoRoot, "mods", mod), path.join(cardMods, mod));
  }
}

function buildLayoutCard(card, spec) {
  const dir = path.join(repoRoot, card);
  const tree = JSON.parse(readText(path.join(repoRoot, "layouts", `${spec.layout}.json`)));
  for (const sub of ["layouts", "mods", "themes"]) {
    fs.rmSync(path.join(dir, sub), { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(dir, "layouts"), { recursive: true });
  for (const ext of ["json", "svg"]) {
    const layoutFile = path.join(repoRoot, "layouts", `${spec.layout}.${ext}`);
    if (fs.existsSync(layoutFile)) {
      fs.copyFileSync(layoutFile, path.join(dir, "layouts", `${spec.layout}.${ext}`));
    }
  }
  for (const mod of layoutMods(tree, spec.extra)) {
    copyDir(path.join(repoRoot, "mods", mod), path.join(dir, "mods", mod));
  }
  if (spec.themes?.length) {
    fs.mkdirSync(path.join(dir, "themes"), { recursive: true });
    for (const themeName of spec.themes) {
      fs.copyFileSync(path.join(repoRoot, "themes", `${themeName}.json`), path.join(dir, "themes", `${themeName}.json`));
    }
  }
  if (spec.keys) {
    fs.writeFileSync(path.join(dir, "keys.json"), `${JSON.stringify(spec.keys, null, 2)}\n`);
  }
}

for (const [card, mods] of Object.entries(CARDS)) {
  buildModCard(card, mods);
}
for (const [card, spec] of Object.entries(LAYOUT_CARDS)) {
  buildLayoutCard(card, spec);
}
console.log(`build: ${Object.keys(CARDS).length} mod cards and ${Object.keys(LAYOUT_CARDS).length} layout card refreshed`);
