import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePorts, workspaceProblems, pickChecks, parseCheckOutput } from "../shared/panel-core.js";
import { emptyNav, navVisit, navStep } from "../shared/nav-core.js";
import { grepArgs, parseGrep, matchSnippet } from "../shared/search-core.js";

test("parsePorts: one entry per port, hosts merged, sorted", () => {
  const out = parsePorts("p480\ncCode Helper\nf33\nn127.0.0.1:54395\np505\ncnode\nf11\nn*:3000\nf12\nn[::1]:3000\n");
  assert.deepEqual(out, [
    { port: 3000, pid: 505, cmd: "node", hosts: ["*", "[::1]"] },
    { port: 54395, pid: 480, cmd: "Code Helper", hosts: ["127.0.0.1"] },
  ]);
  assert.deepEqual(parsePorts(""), []);
});

test("workspaceProblems: conflicts, git errors, failing CI, behind", () => {
  const roots = [{ name: "web", path: "/w" }, { name: "api", path: "/a" }];
  const out = workspaceProblems(roots, { "/w": { branch: "main", conflicts: 2, behind: 1 }, "/a": { error: "not a git repo" } }, { "/w": { kind: "failure", number: 7 } });
  assert.deepEqual(out.map((problem) => [problem.root.name, problem.level, problem.text]), [
    ["web", "error", "2 files with merge conflicts"],
    ["web", "error", "Pipeline #7 failed on main"],
    ["web", "warning", "1 commit behind on main"],
    ["api", "error", "not a git repo"],
  ]);
  assert.deepEqual(workspaceProblems([], {}, {}), []);
});

test("pickChecks: a type check, then a linter", () => {
  assert.deepEqual(pickChecks([{ name: "lint" }, { name: "typecheck" }, { name: "dev" }]), ["typecheck", "lint"]);
  assert.deepEqual(pickChecks([{ name: "lint:check" }, { name: "lint" }]), ["lint:check"]);
  assert.deepEqual(pickChecks([{ name: "dev" }]), []);
});

test("parseCheckOutput: tsc (both formats), eslint stylish, file:line:col", () => {
  const out = parseCheckOutput([
    "src/a.ts(12,5): error TS2322: Type 'x' is not assignable.",
    "src/b.ts:3:1 - error TS1005: ';' expected.",
    "",
    "/repo/web/src/c.tsx",
    "  4:10  error    'x' is defined but never used  no-unused-vars",
    "  9:2   warning  Unexpected console statement   no-console",
    "",
    "lib/d.js:7:3: warning Something odd",
    "> next build",
  ].join("\n"), { root: "/repo", dir: "/repo/web" });
  assert.deepEqual(out.map((item) => [item.rel, item.line, item.col, item.level, item.message, item.rule]), [
    ["web/src/a.ts", 12, 5, "error", "Type 'x' is not assignable.", "TS2322"],
    ["web/src/b.ts", 3, 1, "error", "';' expected.", "TS1005"],
    ["web/src/c.tsx", 4, 10, "error", "'x' is defined but never used", "no-unused-vars"],
    ["web/src/c.tsx", 9, 2, "warning", "Unexpected console statement", "no-console"],
    ["web/lib/d.js", 7, 3, "warning", "Something odd", ""],
  ]);
});

test("nav: visit drops forward history; step skips closed tabs", () => {
  let history = emptyNav();
  for (const tab of ["a", "b", "c"]) {
    history = navVisit(history, tab);
  }
  assert.deepEqual(history, { list: ["a", "b", "c"], at: 2 });
  const back = navStep(history, -1, new Set(["a", "c"]));
  assert.deepEqual(back, { list: ["a", "b", "c"], at: 0 });
  assert.equal(navStep(back, -1, new Set(["a", "c"])), null);
  assert.deepEqual(navVisit(back, "d"), { list: ["a", "d"], at: 1 });
  assert.equal(navVisit(history, "c"), history);
});

test("grepArgs and parseGrep", () => {
  assert.deepEqual(grepArgs("foo", { word: true, include: "*.ts, src/lib" }),
    ["grep", "-n", "-I", "--column", "--no-color", "--untracked", "--full-name", "-i", "-w", "-F", "-e", "foo", "--", ":(glob)**/*.ts", ":(glob)**/*.ts/**", ":(glob)src/lib", ":(glob)src/lib/**"]);
  assert.ok(grepArgs("a.b", { regex: true, caseSensitive: true }).includes("-P"));
  assert.ok(grepArgs("a.b", { regex: true, perl: false }).includes("-E"));
  const grep = parseGrep("src/a.ts:3:7:const foo = 1\nsrc/a.ts:9:1:foo()\nREADME.md:1:3:# foo\n");
  assert.equal(grep.total, 3);
  assert.deepEqual(grep.files.map((file) => [file.rel, file.matches.length]), [["src/a.ts", 2], ["README.md", 1]]);
  assert.equal(parseGrep("a:1:1:x\nb:2:1:y\n", { maxMatches: 1 }).truncated, true);
  assert.deepEqual(matchSnippet("    const foo = 1", 11, 3), { head: "const ", hit: "foo", tail: " = 1", ellipsis: false, headFrom: 4, start: 10, end: 13, tailEnd: 173 });
});

test("countProblems: workspace problems plus check results", async () => {
  const { countProblems } = await import("../shared/panel-core.js");
  assert.deepEqual(countProblems([{ level: "error" }, { level: "warning" }], { "/w": { items: [{ level: "error" }, { level: "error" }] } }), { errors: 3, warnings: 1 });
  assert.deepEqual(countProblems([], {}), { errors: 0, warnings: 0 });
});
