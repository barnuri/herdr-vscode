import { test } from "node:test";
import assert from "node:assert/strict";
import { languageOf, lexLine, lexLines, LexCache, lexCached, sliceRuns } from "../shared/syntax-core.js";
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
  assert.deepEqual(jsKinds, ["keyword:const", "variable:x", "fn:foo", 'string:"hi"', "number:42", "comment:// done"]);
  assert.deepEqual(kinds(lexLine("const url = 'http://x';", "js").runs), ["keyword:const", "variable:url", "string:'http://x'"]);
});

test("block comment and template carry over lines", () => {
  const rows = lexLines(["a /* start", "middle", "end */ b", "x = `one", "two`"], "js");
  assert.equal(rows[1][0].kind, "comment");
  assert.equal(rows[2][0].kind, "comment");
  assert.equal(rows[4][0].kind, "string");
});

test("yaml and json keys, shell comments", () => {
  assert.deepEqual(kinds(lexLine("  image: node:20 # base", "yaml").runs).slice(0, 1), ["yamlKey:image"]);
  assert.deepEqual(kinds(lexLine('  "name": "herdr-vscode",', "json").runs), ['key:"name"', 'string:"herdr-vscode"']);
  assert.deepEqual(kinds(lexLine('echo ${#arr[@]} # n', "sh").runs), ["fn:echo", "variable:${#arr[@]}", "comment:# n"]);
});

test("icon lookup against the built table", () => {
  const table = JSON.parse(readFileSync(new URL("../mods/herdr-vscode-icons/icons.json", import.meta.url), "utf8"));
  assert.match(iconFor(table, "package.json"), /f_npm\.svg$/);
  assert.match(iconFor(table, "src", { dir: true, open: true }), /fd_src_open\.svg$/);
  assert.match(iconFor(table, "src", { dir: true }), /fd_src\.svg$/);
  assert.match(iconFor(table, "index.d.ts"), /f_typescriptdef\.svg$/);
  assert.match(iconFor(table, "main.py"), /f_python\.svg$/);
  assert.match(iconFor(table, "unknown.zzz"), /\/file\.svg$/);
  assert.match(iconFor(table, "nothing-here", { dir: true, open: true }), /\/folder_open\.svg$/);
});

test("VS Code scopes: control keywords, members, regex, escapes, interpolation", () => {
  assert.deepEqual(kinds(lexLine("return this.items.map((x) => x.id);", "js").runs),
    ["control:return", "keyword:this", "variable:items", "fn:map", "variable:x", "arrow:=>", "variable:x", "variable:id"]);
  assert.deepEqual(kinds(lexLine("const re = /a\\/b[/]/g;", "js").runs), ["keyword:const", "variable:re", "regexp:/a\\/b[/]/g"]);
  assert.deepEqual(kinds(lexLine("`a ${b} \\n`", "js").runs), ["string:`a ", "interp:${", "variable:b", "interp:}", "string: ", "escape:\\n", "string:`"]);
  assert.deepEqual(kinds(lexLine('f"{x}"', "py").runs), ["keyword:f", 'string:"', "interp:{", "variable:x", "interp:}", 'string:"']);
  assert.deepEqual(kinds(lexLine("fn new(name: &'a str) {", "rs").runs), ["keyword:fn", "fn:new", "variable:name", "keyword:'a", "type:str"]);
  assert.deepEqual(kinds(lexLine("x := Foo{}", "go").runs), ["variable:x", "type:Foo"]);
});

test("JSX and HTML tags", () => {
  assert.deepEqual(kinds(lexLine('return <Box id="a">', "js").runs), ["control:return", "punct:<", "component:Box", "attr:id", 'string:"a"', "punct:>"]);
  assert.deepEqual(kinds(lexLine("const m = new Map<string, User>();", "js").runs).includes("punct:<"), false);
  assert.deepEqual(kinds(lexLine('<a href="x">A &amp; B</a>', "html").runs), ["punct:<", "tag:a", "attr:href", 'string:"x"', "punct:>", "entity:&amp;", "punct:</", "tag:a", "punct:>"]);
});

test("css, yaml, toml, markdown, dockerfile and makefile", () => {
  assert.deepEqual(kinds(lexLine(".a:hover { color: #fff !important; }", "css").runs), ["selector:.a", "selector::hover", "property:color", "value:#fff", "keyword:!important"]);
  assert.deepEqual(kinds(lexLine("  count: 42 # n", "yaml").runs), ["yamlKey:count", "number:42", "comment:# n"]);
  assert.deepEqual(kinds(lexLine("- name: build", "yaml").runs), ["yamlKey:name", "string:build"]);
  const block = lexLines(["run: |", "  npm test", "next: 1"], "yaml");
  assert.equal(block[1][0].kind, "string");
  assert.equal(block[2][0].kind, "yamlKey");
  assert.deepEqual(kinds(lexLine("[deps]", "toml").runs), ["punct:[", "type:deps", "punct:]"]);
  const md = lexLines(["# Title", "Use `x` and **b**", "```ts", "const a = 1;", "```"], "md");
  assert.equal(md[0][0].kind, "heading");
  assert.deepEqual(kinds(md[1]), ["raw:`x`", "bold:**b**"]);
  assert.equal(md[3][0].kind, "keyword");
  assert.equal(md[4][0].kind, "punct");
  assert.deepEqual(kinds(lexLine("RUN npm ci", "docker").runs), ["keyword:RUN", "fn:npm"]);
  assert.equal(languageOf("Makefile"), "make");
  assert.deepEqual(kinds(lexLines(["all: build", "\tcc $(CFLAGS) -o $@"], "make")[1]), ["fn:cc", "variable:$(CFLAGS)", "variable:$@"]);
});

test("LexCache lexes lazily and carries state; lexCached and sliceRuns", () => {
  const cache = new LexCache(["/* a", "b */ x", "y"], "js");
  assert.equal(cache.runsAt(1)[0].kind, "comment");
  assert.equal(cache.runs.length, 2);
  assert.equal(lexCached("const a", "js"), lexCached("const a", "js"));
  assert.deepEqual(sliceRuns([{ text: "abc", kind: "k" }, { text: "def", kind: null }], 2, 4), [{ text: "c", kind: "k" }, { text: "d", kind: null }]);
});

test("editorLanguageOf names languages the way the built-in editor knows them", async () => {
  const { editorLanguageOf } = await import("../shared/syntax-core.js");
  assert.equal(editorLanguageOf("README.md"), "markdown");
  assert.equal(editorLanguageOf("src/a.ts"), "typescript");
  assert.equal(editorLanguageOf("src/a.tsx"), "tsx");
  assert.equal(editorLanguageOf("lib.rs"), "rust");
  assert.equal(editorLanguageOf("Dockerfile"), "bash");
});
