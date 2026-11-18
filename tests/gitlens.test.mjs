import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutGraph, parseGraphLog, refLabels } from "../shared/graph-core.js";
import { parseBlame, heat } from "../shared/blame-core.js";

test("graph: linear history stays in one lane", () => {
  const { rows, width } = layoutGraph([{ hash: "c", parents: ["b"] }, { hash: "b", parents: ["a"] }, { hash: "a", parents: [] }]);
  assert.equal(width, 1);
  assert.deepEqual(rows.map((row) => row.col), [0, 0, 0]);
  assert.deepEqual(rows[2].bottom, []);
});

test("graph: a merge forks a lane and joins it back", () => {
  const { rows, width } = layoutGraph([
    { hash: "m", parents: ["a2", "f"] },
    { hash: "f", parents: ["a1"] },
    { hash: "a2", parents: ["a1"] },
    { hash: "a1", parents: [] },
  ]);
  assert.equal(width, 2);
  assert.deepEqual(rows[0], { col: 0, top: [], bottom: [0, 1], span: [0, 1], joined: [], forks: [1] });
  assert.equal(rows[1].col, 1);
  assert.equal(rows[2].col, 0);
  assert.deepEqual(rows[2].bottom, [0, 1]);
  assert.deepEqual(rows[3].joined, [1]);
  assert.deepEqual(rows[3].span, [0, 1]);
});

test("graph log parsing and refs", () => {
  const commits = parseGraphLog("h1\x00p1 p2\x00HEAD -> main, origin/main, tag: v1\x00Ann\x00100\x00Merge x\x1e\n");
  assert.deepEqual(commits[0].parents, ["p1", "p2"]);
  assert.deepEqual(refLabels(commits[0].refs).map((ref) => ref.kind), ["head", "remote", "tag"]);
});

test("blame porcelain", () => {
  const sha1 = "a".repeat(40);
  const sha2 = "b".repeat(40);
  const out = `${sha1} 1 1 2\nauthor Ann\nauthor-time 100\nsummary first\nfilename x.js\n\tline one\n${sha1} 2 2\n\tline two\n${sha2} 3 3 1\nauthor Bob\nauthor-time 200\nsummary second\nfilename x.js\n\tline three\n`;
  const blame = parseBlame(out);
  assert.deepEqual(blame.map((entry) => [entry.line, entry.author, entry.summary]), [[1, "Ann", "first"], [2, "Ann", "first"], [3, "Bob", "second"]]);
  assert.deepEqual(heat(blame), [0, 0, 1]);
});

test("ages take unix seconds", async () => {
  const { shortAge } = await import("../shared/blame-core.js");
  const now = Date.UTC(2026, 10, 17);
  assert.equal(shortAge(now / 1000 - 3 * 86400, now), "3d");
  assert.equal(shortAge(now / 1000 - 400 * 86400, now), "1y");
  assert.equal(shortAge(now / 1000, now), "now");
});
