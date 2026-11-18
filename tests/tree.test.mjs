import { test } from "node:test";
import assert from "node:assert/strict";
import { clampIndent, guideMode, rowPadding, guideX, guideLevels, activeGuideLevel } from "../shared/tree-core.js";

test("tree indent: VS Code range 0-40, default 16", () => {
  assert.equal(clampIndent(undefined), 16);
  assert.equal(clampIndent("x"), 16);
  assert.equal(clampIndent(-3), 0);
  assert.equal(clampIndent(99), 40);
  assert.equal(clampIndent(12.4), 12);
});

test("tree guides: unknown modes fall back to always", () => {
  assert.equal(guideMode("onHover"), "onHover");
  assert.equal(guideMode("none"), "none");
  assert.equal(guideMode("sometimes"), "always");
});

test("tree layout: padding per level and guides under each ancestor twistie", () => {
  assert.equal(rowPadding(0, 16), 8);
  assert.equal(rowPadding(2, 16), 40);
  assert.equal(guideX(0, 16), 16);
  assert.equal(guideX(1, 16), 32);
  assert.deepEqual(guideLevels(3), [0, 1, 2]);
  assert.deepEqual(guideLevels(3, 1), [1, 2]);
  assert.deepEqual(guideLevels(0), []);
});

test("tree guides: the selected folder's guide is active for rows inside it", () => {
  assert.equal(activeGuideLevel("src/a/b.js", "src/a", 2), 2);
  assert.equal(activeGuideLevel("src/ab.js", "src/a", 2), null);
  assert.equal(activeGuideLevel("src/a/b.js", null, 2), null);
});

import { withChildAt } from "../shared/layout-core.js";

test("withChildAt: moves the terminal list left or right, null when already there", () => {
  const tree = { id: "root", children: [{ id: "row", children: [{ id: "term" }, { id: "split" }, { id: "list" }] }] };
  assert.deepEqual(withChildAt(tree, "row", "list", "left").children[0].children.map((c) => c.id), ["list", "term", "split"]);
  assert.equal(withChildAt(tree, "row", "list", "right"), null);
  assert.equal(withChildAt(tree, "row", "nope", "left"), null);
  assert.deepEqual(tree.children[0].children.map((c) => c.id), ["term", "split", "list"]);
});
