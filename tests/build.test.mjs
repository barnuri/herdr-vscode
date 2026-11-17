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
