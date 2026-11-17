#!/usr/bin/env node
// Copies shared/*.js into every mods/vx-*/ folder. A Herdr mod can only import files from its
// own folder, and people install a mod by copying its folder, so each one carries the shared
// code. shared/ is the one to edit; run this (sync.sh does) after changing it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CARDS, LAYOUT_CARDS, layoutMods } from "./cards.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const shared = fs.readdirSync(path.join(root, "shared")).filter((f) => f.endsWith(".js"));
const mods = fs.readdirSync(path.join(root, "mods")).filter((m) => m.startsWith("vx-"));
// A mod's own file with a shared file's name would be overwritten: refuse instead. A copy of a
// shared file starts with that file's first line (its header comment).
const clashes = [];
for (const mod of mods) {
  for (const f of shared) {
    const dst = path.join(root, "mods", mod, f);
    if (!fs.existsSync(dst)) continue;
    const head = (p) => fs.readFileSync(p, "utf8").split("\n", 1)[0];
    if (head(dst) !== head(path.join(root, "shared", f))) clashes.push(`mods/${mod}/${f}`);
  }
}
if (clashes.length) {
  console.error(`build: these mod files share a name with shared/ and would be overwritten:\n  ${clashes.join("\n  ")}\nRename the shared file (or delete the stale copy).`);
  process.exit(1);
}
let changed = 0;
for (const mod of mods) {
  for (const f of shared) {
    const src = fs.readFileSync(path.join(root, "shared", f), "utf8");
    const dst = path.join(root, "mods", mod, f);
    if (!fs.existsSync(dst) || fs.readFileSync(dst, "utf8") !== src) {
      fs.writeFileSync(dst, src);
      changed++;
    }
  }
}
console.log(`build: ${shared.length} shared files in each mod (${changed} updated)`);

// The gallery shows one card per folder holding RECIPE.md + preview.png + mods/<name>/. Each
// card folder gets fresh copies of its mods from mods/ (the one source); its RECIPE.md and
// preview.png are written by hand.

const copyDir = (from, to) => {
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true, filter: (p) => !/(\/cache|\.DS_Store|jsconfig\.json|\.d\.ts)$/.test(p) });
};
for (const [card, mods] of Object.entries(CARDS)) {
  fs.mkdirSync(path.join(root, card, "mods"), { recursive: true });
  for (const m of fs.readdirSync(path.join(root, card, "mods"))) if (!mods.includes(m)) fs.rmSync(path.join(root, card, "mods", m), { recursive: true, force: true });
  for (const m of mods) copyDir(path.join(root, "mods", m), path.join(root, card, "mods", m));
}
// Layout cards: layouts/<name>.json + .svg, its mods, its themes and a keys.json.
for (const [card, spec] of Object.entries(LAYOUT_CARDS)) {
  const dir = path.join(root, card);
  const tree = JSON.parse(fs.readFileSync(path.join(root, "layouts", `${spec.layout}.json`), "utf8"));
  const mods = layoutMods(tree, spec.extra);
  for (const sub of ["layouts", "mods", "themes"]) fs.rmSync(path.join(dir, sub), { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "layouts"), { recursive: true });
  for (const ext of ["json", "svg"]) {
    const f = path.join(root, "layouts", `${spec.layout}.${ext}`);
    if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dir, "layouts", `${spec.layout}.${ext}`));
  }
  for (const m of mods) copyDir(path.join(root, "mods", m), path.join(dir, "mods", m));
  if (spec.themes?.length) {
    fs.mkdirSync(path.join(dir, "themes"), { recursive: true });
    for (const t of spec.themes) fs.copyFileSync(path.join(root, "themes", `${t}.json`), path.join(dir, "themes", `${t}.json`));
  }
  if (spec.keys) fs.writeFileSync(path.join(dir, "keys.json"), `${JSON.stringify(spec.keys, null, 2)}\n`);
}
console.log(`build: ${Object.keys(CARDS).length} mod cards and ${Object.keys(LAYOUT_CARDS).length} layout card refreshed`);
