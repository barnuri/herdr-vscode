#!/usr/bin/env node
// Usage: node tools/build-icons.mjs <unpacked vscode-icons extension folder> <languages.ts>
// Reads JSON, TS and SVG files only; runs nothing from the source.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USAGE_EXIT_CODE = 2;
const LICENSE_SOURCE = "LICENSE.txt";
const LICENSE_TARGET = "LICENSE-vscode-icons.txt";
const THEME_FILE = "dist/src/vsicons-icon-theme.json";
const ACTIVE_CONTENT = /<script|javascript:|\son[a-z]+=|<foreignObject/i;
const LANGUAGE_ENTRY = /ids:\s*(\[[^\]]*\]|'[^']*')\s*,\s*knownExtensions:\s*\[([^\]]*)\]/g;
const QUOTED = /'([^']*)'/g;
const NAMED_ICONS = { npm: "_f_npm", pnpm: "_f_pnpm", bun: "_f_bun", yarn: "_f_yarn", root_folder: "_root_folder", root_folder_open: "_root_folder_open" };
const MAP_KINDS = ["fileNames", "fileExtensions", "folderNames", "folderNamesExpanded"];

const [extensionDir, languagesFile] = process.argv.slice(2);
if (!extensionDir || !languagesFile) {
  console.error("usage: node tools/build-icons.mjs <vscode-icons extension folder> <languages.ts>");
  process.exit(USAGE_EXIT_CODE);
}
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mods", "herdr-vscode-icons");
const theme = JSON.parse(fs.readFileSync(path.join(extensionDir, THEME_FILE), "utf8"));
const iconsDir = path.join(path.dirname(path.join(extensionDir, THEME_FILE)));
const used = new Map();
const skipped = new Set();

function quotedValues(text) {
  return [...text.matchAll(QUOTED)].map((match) => match[1]);
}

function languageExtensions(source) {
  const byLanguage = new Map();
  for (const match of source.matchAll(LANGUAGE_ENTRY)) {
    const extensions = quotedValues(match[2]);
    for (const id of quotedValues(match[1])) {
      byLanguage.set(id, extensions);
    }
  }
  return byLanguage;
}

function iconId(definition) {
  const iconPath = theme.iconDefinitions[definition]?.iconPath;
  if (!iconPath) {
    return null;
  }
  const file = path.resolve(iconsDir, iconPath);
  if (ACTIVE_CONTENT.test(fs.readFileSync(file, "utf8"))) {
    skipped.add(path.basename(file));
    return null;
  }
  const id = definition.replace(/^_/, "");
  used.set(id, file);
  return id;
}

function mapIds(source = {}) {
  const out = {};
  for (const [key, definition] of Object.entries(source)) {
    const id = iconId(definition);
    if (id) {
      out[key.toLowerCase()] = id;
    }
  }
  return out;
}

function extensionsWithLanguages(variant, byLanguage) {
  const extensions = {};
  for (const [language, definition] of Object.entries(variant.languageIds ?? {})) {
    const id = iconId(definition);
    if (!id) {
      continue;
    }
    for (const extension of byLanguage.get(language) ?? []) {
      extensions[extension.toLowerCase()] = id;
    }
  }
  return { ...extensions, ...mapIds(variant.fileExtensions) };
}

function buildVariant(variant, byLanguage) {
  const table = {
    file: iconId(variant.file),
    folder: iconId(variant.folder),
    folderOpen: iconId(variant.folderExpanded),
    fileExtensions: extensionsWithLanguages(variant, byLanguage),
  };
  for (const kind of MAP_KINDS.filter((name) => name !== "fileExtensions")) {
    table[kind] = mapIds(variant[kind]);
  }
  return Object.fromEntries(Object.entries(table).filter(([, value]) => value !== null));
}

const byLanguage = languageExtensions(fs.readFileSync(languagesFile, "utf8"));
const table = { ...buildVariant(theme, byLanguage), light: buildVariant(theme.light ?? {}, byLanguage) };
for (const [name, definition] of Object.entries(NAMED_ICONS)) {
  const id = iconId(definition);
  if (id) {
    used.set(name, used.get(id));
  }
}

const target = path.join(outDir, "icons");
if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
  console.error(`${target} is not empty: move it to the trash first`);
  process.exit(USAGE_EXIT_CODE);
}
fs.mkdirSync(target, { recursive: true });
for (const [id, file] of used) {
  fs.copyFileSync(file, path.join(target, `${id}.svg`));
}
fs.writeFileSync(path.join(outDir, "icons.json"), `${JSON.stringify(table)}\n`);
fs.copyFileSync(path.join(extensionDir, LICENSE_SOURCE), path.join(outDir, LICENSE_TARGET));
if (skipped.size > 0) {
  console.warn(`skipped icons with active content: ${[...skipped].join(", ")}`);
}
console.log(`herdr-vscode-icons: ${used.size} icons, ${Object.keys(table.fileNames).length} names, ${Object.keys(table.fileExtensions).length} extensions`);
