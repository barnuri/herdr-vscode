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
