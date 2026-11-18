import { test } from "node:test";
import assert from "node:assert/strict";
import { scorePath, rankFiles } from "../shared/quickopen-core.js";
import { colorSlot, PALETTE } from "../shared/colors-core.js";
import { findNode, withContent } from "../shared/layout-core.js";

test("go to file ranks name hits first", () => {
  const files = ["src/components/Card.tsx", "src/cardigan/util.ts", "docs/scorecard.md", "src/app/page.tsx", "README.md"].map((rel) => ({ root: "/w", rel }));
  assert.deepEqual(rankFiles(files, "card").map((file) => file.rel).slice(0, 3), ["src/components/Card.tsx", "docs/scorecard.md", "src/cardigan/util.ts"]);
  assert.equal(rankFiles(files, "scpg")[0].rel, "src/app/page.tsx");
  assert.equal(scorePath("a/b.ts", "zz"), -1);
  assert.equal(rankFiles(files, "").length, 5);
});

test("repo colours are stable and in the palette", () => {
  assert.equal(colorSlot("acme-api"), colorSlot("acme-api"));
  assert.ok(PALETTE.includes(colorSlot("web")));
  assert.notEqual(new Set(["web", "api", "infra", "docs", "cli", "app"].map(colorSlot)).size, 1);
});

test("layout block content swap copies, never mutates", () => {
  const tree = { id: "root", type: "column", children: [{ id: "bottom", type: "column", children: [{ id: "term", type: "block", content: { mod: "herdr-vscode-panel" } }] }] };
  const next = withContent(tree, "term", { terminal: "t7" });
  assert.deepEqual(findNode(next, "term").content, { terminal: "t7" });
  assert.deepEqual(findNode(tree, "term").content, { mod: "herdr-vscode-panel" });
  assert.equal(withContent(tree, "nope", {}), null);
});
