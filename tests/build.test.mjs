import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const COPY_EXCLUDE = /(^|\/)(cache\/|\.DS_Store|jsconfig\.json)|\.d\.ts$/;
const repoRoot = new URL("..", import.meta.url).pathname;

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((entry) => (entry.isDirectory() ? walk(`${dir}/${entry.name}`).map((file) => `${entry.name}/${file}`) : [entry.name]));

function assertCarriesMod(card, mod) {
  for (const file of walk(`${repoRoot}mods/${mod}`).filter((candidate) => !COPY_EXCLUDE.test(candidate))) {
    const copy = fs.readFileSync(`${repoRoot}${card}/mods/${mod}/${file}`);
    assert.ok(copy.equals(fs.readFileSync(`${repoRoot}mods/${mod}/${file}`)), `${card}/mods/${mod}/${file} is stale`);
  }
}

test("mods carry the current shared code", () => {
  const sharedFiles = fs.readdirSync(`${repoRoot}shared`).filter((file) => file.endsWith(".js"));
  for (const mod of fs.readdirSync(`${repoRoot}mods`).filter((name) => name.startsWith("vx-"))) {
    for (const file of sharedFiles) {
      assert.equal(fs.readFileSync(`${repoRoot}mods/${mod}/${file}`, "utf8"), fs.readFileSync(`${repoRoot}shared/${file}`, "utf8"), `${mod}/${file} is stale`);
    }
  }
});

test("gallery cards carry the current mods", async () => {
  const { CARDS } = await import("../tools/cards.mjs");
  for (const [card, mods] of Object.entries(CARDS)) {
    assert.ok(fs.existsSync(`${repoRoot}${card}/RECIPE.md`), `${card}/RECIPE.md missing`);
    assert.ok(fs.existsSync(`${repoRoot}${card}/preview.png`), `${card}/preview.png missing`);
    for (const mod of mods) {
      assertCarriesMod(card, mod);
    }
  }
});

test("layout cards carry the current layout, mods and themes", async () => {
  const { LAYOUT_CARDS, layoutMods } = await import("../tools/cards.mjs");
  for (const [card, spec] of Object.entries(LAYOUT_CARDS)) {
    for (const file of ["RECIPE.md", "preview.png", "keys.json", `layouts/${spec.layout}.json`]) {
      assert.ok(fs.existsSync(`${repoRoot}${card}/${file}`), `${card}/${file} missing`);
    }
    const layoutSource = fs.readFileSync(`${repoRoot}layouts/${spec.layout}.json`, "utf8");
    assert.equal(fs.readFileSync(`${repoRoot}${card}/layouts/${spec.layout}.json`, "utf8"), layoutSource, `${card}'s layout is stale`);
    for (const mod of layoutMods(JSON.parse(layoutSource), spec.extra)) {
      assertCarriesMod(card, mod);
    }
    for (const themeName of spec.themes ?? []) {
      assert.equal(fs.readFileSync(`${repoRoot}${card}/themes/${themeName}.json`, "utf8"), fs.readFileSync(`${repoRoot}themes/${themeName}.json`, "utf8"), `${card}/themes/${themeName}.json is stale`);
    }
  }
});

test("layoutMods: the vx mods a layout names, plus vx-icons", async () => {
  const { layoutMods } = await import("../tools/cards.mjs");
  assert.deepEqual(layoutMods({ children: [{ content: { mod: "vx-tabs" } }, { content: { mod: "spaces" } }, { children: [{ content: { mod: "vx-panel", props: {} } }] }] }), ["vx-icons", "vx-panel", "vx-tabs"]);
});
