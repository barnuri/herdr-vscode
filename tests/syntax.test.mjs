import { test } from "node:test";
import assert from "node:assert/strict";
import { languageOf, lexLine, lexLines } from "../shared/syntax-core.js";
import { iconFor } from "../shared/icons-core.js";
import { readFileSync } from "node:fs";

const kinds = (runs) => runs.filter((run) => run.kind).map((run) => `${run.kind}:${run.text}`);

test("languages", () => {
  assert.equal(languageOf("a/b/App.tsx"), "js");
  assert.equal(languageOf("Dockerfile"), "docker");
  assert.equal(languageOf(".env.local"), "sh");
  assert.equal(languageOf(".gitlab-ci.yml"), "yaml");
  assert.equal(languageOf("README"), "txt");
});

test("js line", () => {
  const jsKinds = kinds(lexLine('const x = foo("hi", 42); // done', "js").runs);
  assert.deepEqual(jsKinds, ["keyword:const", "fn:foo", 'string:"hi"', "number:42", "comment:// done"]);
  assert.deepEqual(kinds(lexLine("const url = 'http://x';", "js").runs), ["keyword:const", "string:'http://x'"]);
});

test("block comment and template carry over lines", () => {
  const rows = lexLines(["a /* start", "middle", "end */ b", "x = `one", "two`"], "js");
  assert.equal(rows[1][0].kind, "comment");
  assert.equal(rows[2][0].kind, "comment");
  assert.equal(rows[4][0].kind, "string");
});

test("yaml and json keys, shell comments", () => {
  assert.deepEqual(kinds(lexLine("  image: node:20 # base", "yaml").runs).slice(0, 1), ["key:image"]);
  assert.deepEqual(kinds(lexLine('  "name": "vx",', "json").runs), ['key:"name"', 'string:"vx"']);
  assert.deepEqual(kinds(lexLine('echo ${#arr[@]} # n', "sh").runs), ["comment:# n"]);
});

test("icon lookup against the built table", () => {
  const table = JSON.parse(readFileSync(new URL("../mods/vx-icons/icons.json", import.meta.url), "utf8"));
  assert.match(iconFor(table, "package.json"), /nodejs\.svg$/);
  assert.match(iconFor(table, "src", { dir: true, open: true }), /folder-src-open\.svg$/);
});
