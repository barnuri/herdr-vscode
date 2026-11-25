import test from "node:test";
import assert from "node:assert/strict";
import { buildPattern, findMatches, nextMatchIndex, replaceAll, replaceOne } from "../shared/find-core.js";

const pattern = (query, options) => buildPattern(query, options).pattern;

test("literal, case and word options", () => {
  assert.equal(findMatches("Foo foo foobar", pattern("foo")).length, 3);
  assert.equal(findMatches("Foo foo foobar", pattern("foo", { caseSensitive: true })).length, 2);
  assert.equal(findMatches("Foo foo foobar", pattern("foo", { word: true })).length, 2);
  assert.equal(findMatches("a.b axb", pattern("a.b")).length, 1);
  assert.equal(findMatches("a.b axb", pattern("a.b", { regex: true })).length, 2);
});

test("invalid regex reports an error", () => {
  assert.ok(buildPattern("(", { regex: true }).error);
});

test("next and previous wrap", () => {
  const matches = findMatches("a a a", pattern("a"));
  assert.equal(nextMatchIndex(matches, 0), 0);
  assert.equal(nextMatchIndex(matches, 1), 1);
  assert.equal(nextMatchIndex(matches, 5), 0);
  assert.equal(nextMatchIndex(matches, 2, true), 0);
  assert.equal(nextMatchIndex(matches, 0, true), 2);
});

test("replace with capture groups", () => {
  const regex = pattern("(\\w+)@(\\w+)", { regex: true });
  assert.deepEqual(replaceAll("a@b c@d", regex, "$2:$1", true), { text: "b:a d:c", count: 2 });
  assert.equal(replaceOne("a@b c@d", regex, 4, 7, "$1", true), "a@b c");
  assert.equal(replaceAll("x.y", pattern("."), "$1", false).text, "x$1y");
});

import { grepArgs, byteToIndex } from "../shared/search-core.js";

test("include and exclude patterns become pathspecs", () => {
  const args = grepArgs("x", { include: "*.ts, src/app", exclude: "node_modules, **/dist" });
  const specs = args.slice(args.indexOf("--") + 1);
  assert.deepEqual(specs, [
    ":(glob)**/*.ts", ":(glob)**/*.ts/**", ":(glob)src/app", ":(glob)src/app/**",
    ":(exclude,glob)**/node_modules", ":(exclude,glob)**/node_modules/**", ":(exclude,glob)**/dist", ":(exclude,glob)**/dist/**",
  ]);
  assert.ok(grepArgs("x", { ignoreFiles: false }).includes("--no-exclude-standard"));
});

test("git grep byte columns map to string indexes", () => {
  assert.equal(byteToIndex("aéb", 3), 2);
  assert.equal(byteToIndex("abc", 2), 2);
});
