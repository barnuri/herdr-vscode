import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Every mod carries an identical copy of shared/ (run `node tools/build.mjs` after editing it).
test("mods carry the current shared code", () => {
  const root = new URL("..", import.meta.url).pathname;
  const shared = fs.readdirSync(`${root}shared`).filter((f) => f.endsWith(".js"));
  for (const mod of fs.readdirSync(`${root}mods`).filter((m) => m.startsWith("vx-")))
    for (const f of shared)
      assert.equal(fs.readFileSync(`${root}mods/${mod}/${f}`, "utf8"), fs.readFileSync(`${root}shared/${f}`, "utf8"), `${mod}/${f} is stale`);
});

// Every gallery card carries exact copies of its mods (run `node tools/build.mjs`).
test("gallery cards carry the current mods", async () => {
  const root = new URL("..", import.meta.url).pathname;
  const { CARDS } = await import("../tools/cards.mjs");
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`).map((f) => `${e.name}/${f}`) : [e.name]));
  for (const [card, mods] of Object.entries(CARDS)) {
    assert.ok(fs.existsSync(`${root}${card}/RECIPE.md`), `${card}/RECIPE.md missing`);
    assert.ok(fs.existsSync(`${root}${card}/preview.png`), `${card}/preview.png missing`);
    for (const m of mods)
      for (const f of walk(`${root}mods/${m}`).filter((f) => !/(^|\/)(cache\/|\.DS_Store|jsconfig\.json)|\.d\.ts$/.test(f)))
        assert.ok(fs.readFileSync(`${root}${card}/mods/${m}/${f}`).equals(fs.readFileSync(`${root}mods/${m}/${f}`)), `${card}/mods/${m}/${f} is stale`);
  }
});

// Every layout card carries its layout, the mods it names (+ vx-icons), its themes and keys.
test("layout cards carry the current layout, mods and themes", async () => {
  const root = new URL("..", import.meta.url).pathname;
  const { LAYOUT_CARDS, layoutMods } = await import("../tools/cards.mjs");
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`).map((f) => `${e.name}/${f}`) : [e.name]));
  for (const [card, spec] of Object.entries(LAYOUT_CARDS)) {
    for (const f of ["RECIPE.md", "preview.png", "keys.json", `layouts/${spec.layout}.json`])
      assert.ok(fs.existsSync(`${root}${card}/${f}`), `${card}/${f} missing`);
    const src = fs.readFileSync(`${root}layouts/${spec.layout}.json`, "utf8");
    assert.equal(fs.readFileSync(`${root}${card}/layouts/${spec.layout}.json`, "utf8"), src, `${card}'s layout is stale`);
    for (const m of layoutMods(JSON.parse(src), spec.extra))
      for (const f of walk(`${root}mods/${m}`).filter((f) => !/(^|\/)(cache\/|\.DS_Store|jsconfig\.json)|\.d\.ts$/.test(f)))
        assert.ok(fs.readFileSync(`${root}${card}/mods/${m}/${f}`).equals(fs.readFileSync(`${root}mods/${m}/${f}`)), `${card}/mods/${m}/${f} is stale`);
    for (const t of spec.themes ?? [])
      assert.equal(fs.readFileSync(`${root}${card}/themes/${t}.json`, "utf8"), fs.readFileSync(`${root}themes/${t}.json`, "utf8"), `${card}/themes/${t}.json is stale`);
  }
});

test("layoutMods: the vx mods a layout names, plus vx-icons", async () => {
  const { layoutMods } = await import("../tools/cards.mjs");
  assert.deepEqual(layoutMods({ children: [{ content: { mod: "vx-tabs" } }, { content: { mod: "spaces" } }, { children: [{ content: { mod: "vx-panel", props: {} } }] }] }), ["vx-icons", "vx-panel", "vx-tabs"]);
});
