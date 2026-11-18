import { test } from "node:test";
import assert from "node:assert/strict";
import { findPathLinks, parseLinkTarget, pathCandidates, splitRoot, parentDirs, splitRunsAtLinks } from "../shared/links-core.js";

const found = (text) => findPathLinks(text).map(({ path, line, col }) => [path, line, col]);

test("findPathLinks: paths with positions", () => {
  assert.deepEqual(found("error in src/a.ts:12:3 here"), [["src/a.ts", 12, 3]]);
  assert.deepEqual(found("see ./x.md"), [["./x.md", null, null]]);
  assert.deepEqual(found("open ~/f"), [["~/f", null, null]]);
  assert.deepEqual(found("/abs/p (line 4)"), [["/abs/p", 4, null]]);
  assert.deepEqual(found("a/b.go#L7"), [["a/b.go", 7, null]]);
  assert.deepEqual(found("../up/c.rs:9"), [["../up/c.rs", 9, null]]);
  assert.deepEqual(found("Read README.md."), [["README.md", null, null]]);
});

test("findPathLinks: trailing punctuation, URLs and noise", () => {
  assert.deepEqual(found("(see src/x.ts), then"), [["src/x.ts", null, null]]);
  assert.deepEqual(found('"lib/y.js";'), [["lib/y.js", null, null]]);
  assert.deepEqual(found("https://github.com/a/b.ts and http://x.io/p"), []);
  assert.deepEqual(found("www.example.com/a.md"), []);
  assert.deepEqual(found("ratio 1.5 and 3/4 and v1.2"), []);
  assert.deepEqual(found("user@host.com"), []);
  const [link] = findPathLinks("at src/a.ts:12:3!");
  assert.equal("at src/a.ts:12:3!".slice(link.start, link.end), "src/a.ts:12:3");
});

test("parseLinkTarget: local markdown targets", () => {
  assert.deepEqual(parseLinkTarget("docs/a.md"), { path: "docs/a.md", line: null, col: null });
  assert.deepEqual(parseLinkTarget("./src/x.ts#L12"), { path: "./src/x.ts", line: 12, col: null });
  assert.deepEqual(parseLinkTarget("src/x.ts:4:2"), { path: "src/x.ts", line: 4, col: 2 });
  assert.deepEqual(parseLinkTarget("my%20file.md#intro"), { path: "my file.md", line: null, col: null });
  assert.deepEqual(parseLinkTarget("file:///etc/hosts"), { path: "/etc/hosts", line: null, col: null });
  assert.equal(parseLinkTarget("https://x.io/a.md"), null);
  assert.equal(parseLinkTarget("#section"), null);
  assert.equal(parseLinkTarget("mailto:a@b.c"), null);
});

test("pathCandidates resolve against the file folder, then the repo root", () => {
  const where = { fileDir: "/r/docs", root: "/r", home: "/Users/me" };
  assert.deepEqual(pathCandidates("src/a.ts", where), ["/r/docs/src/a.ts", "/r/src/a.ts"]);
  assert.deepEqual(pathCandidates("./x.md", where), ["/r/docs/x.md"]);
  assert.deepEqual(pathCandidates("../y.md", where), ["/r/y.md"]);
  assert.deepEqual(pathCandidates("~/f", where), ["/Users/me/f"]);
  assert.deepEqual(pathCandidates("/abs/p", where), ["/abs/p"]);
  assert.deepEqual(pathCandidates("a.ts", { root: "/r" }), ["/r/a.ts"]);
});

test("splitRoot, parentDirs and splitRunsAtLinks", () => {
  assert.deepEqual(splitRoot("/r/sub/a.ts", ["/r", "/r/sub"]), { root: "/r/sub", rel: "a.ts" });
  assert.deepEqual(splitRoot("/x/y.ts", ["/r"]), { root: "/x", rel: "y.ts" });
  assert.deepEqual(parentDirs("a/b/c.ts"), ["a", "a/b"]);
  const link = { start: 3, end: 7 };
  assert.deepEqual(splitRunsAtLinks([{ text: "ab cd", kind: "k" }, { text: "ef g", kind: null }], [link]),
    [{ text: "ab ", kind: "k" }, { text: "cd", kind: "k", link }, { text: "ef", kind: null, link }, { text: " g", kind: null }]);
});
