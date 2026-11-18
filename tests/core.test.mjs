import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseJsonc } from "../shared/jsonc.js";
import { resolvePath, rootsFromWorkspace, rootFor, chooseContext, workspaceName } from "../shared/ws-core.js";
import { parseStatus, parseNumstat, parseRemote, providerOf, diffRows, splitRows, parseHunks, parseLog } from "../shared/git-core.js";

test("jsonc: comments, trailing commas, and // inside strings", () => {
  const text = `{
    // a comment
    "folders": [ { "path": "a" }, /* block */ { "path": "http://x//y", }, ],
    "s": "keep /* this */ and // this",
  }`;
  const parsed = parseJsonc(text);
  assert.equal(parsed.folders.length, 2);
  assert.equal(parsed.folders[1].path, "http://x//y");
  assert.equal(parsed.s, "keep /* this */ and // this");
});

test("paths resolve relative to the workspace file", () => {
  assert.equal(resolvePath("/a/b", "c"), "/a/b/c");
  assert.equal(resolvePath("/a/b", "../c/./d"), "/a/c/d");
  assert.equal(resolvePath("/a/b", "/abs"), "/abs");
  const roots = rootsFromWorkspace("/w/x.code-workspace", { folders: [{ path: "web", name: "Web" }, { path: "srv" }, { path: "srv" }, { nope: 1 }] });
  assert.deepEqual(roots, [{ name: "Web", path: "/w/web" }, { name: "srv", path: "/w/srv" }]);
  assert.equal(workspaceName("/w/acme.code-workspace"), "acme");
});

test("a VS Code workspace file parses (comments, trailing commas, ../ paths)", () => {
  const file = new URL("./fixtures/acme.code-workspace", import.meta.url).pathname;
  const roots = rootsFromWorkspace(file, parseJsonc(readFileSync(file, "utf8")));
  assert.deepEqual(roots.map((root) => root.name), ["web", "api", "infra"]);
  assert.ok(roots[2].path.endsWith("/tests/shared/infra"));
});

test("context rules", () => {
  const roots = [{ name: "srv", path: "/w/srv" }, { name: "web", path: "/w/web" }];
  const active = { root: "/w/web", on: null };
  // A focus inside a root wins, even deep and even with an active repo set.
  assert.equal(chooseContext({ focus: { cwd: "/w/srv/src/x", branch: "main", on: null }, roots, active }).source, "root");
  assert.equal(chooseContext({ focus: { cwd: "/w/srv/src/x", on: null }, roots, active }).cwd, "/w/srv");
  assert.deepEqual(chooseContext({ focus: { cwd: "/other", branch: "dev", on: null }, roots, active }).source, "repo");
  const workspaceFolder = chooseContext({ focus: { cwd: "/w", branch: null, on: null }, roots, active });
  assert.equal(workspaceFolder.source, "active");
  assert.equal(workspaceFolder.root.name, "web");
  assert.equal(chooseContext({ focus: { cwd: "/w", on: null }, roots, active: null }).source, "focus");
  assert.equal(chooseContext({ focus: null, roots, active: null, spaceFolder: "/h" }).cwd, "/h");
  // A remote focus never matches local roots.
  assert.equal(chooseContext({ focus: { cwd: "/w/srv", on: "box", branch: "x" }, roots, active }).source, "repo");
  assert.equal(rootFor("/w/srvx", roots), null);
  // A fresh pick beats a terminal inside another root until focus downgrades it to "click".
  const picked = chooseContext({ focus: { cwd: "/w/srv/src", branch: "main", on: null }, roots, active: { root: "/w/web", by: "pick" } });
  assert.deepEqual([picked.source, picked.cwd, picked.root.name], ["picked", "/w/web", "web"]);
  assert.equal(chooseContext({ focus: { cwd: "/w/srv/src", branch: "main", on: null }, roots, active: { root: "/w/web", by: "click" } }).source, "root");
});

test("git status", () => {
  const status = parseStatus("## main...origin/main [ahead 2, behind 1]\0 M a.js\0M  b.js\0MM c.js\0?? d.txt\0UU e.js\0A  f.js\0 D g.js\0");
  assert.equal(status.branch, "main");
  assert.equal(status.upstream, "origin/main");
  assert.equal(status.ahead, 2);
  assert.equal(status.behind, 1);
  assert.equal(status.changed, 7);
  assert.equal(status.untracked, 1);
  assert.equal(status.conflicts, 1);
  assert.equal(status.staged, 3);
  assert.deepEqual(status.files.map((file) => file.mark), ["M", "M", "M", "A", "U", "A", "D"]);
  assert.equal(parseStatus("## No commits yet on main\0").noCommits, true);
  assert.equal(parseStatus("## HEAD (no branch)\0").detached, true);
  assert.deepEqual({ ...parseNumstat("3\t1\ta b.js\0-\t-\timg.png\0") }, {
    "a b.js": { add: 3, del: 1, binary: false },
    "img.png": { add: 0, del: 0, binary: true },
  });
});

test("remotes and providers", () => {
  assert.deepEqual(parseRemote("git@gitlab.com:acme/platform/web.git"), { host: "gitlab.com", path: "acme/platform/web" });
  assert.deepEqual(parseRemote("https://gitlab.com/acme/x/admin-console"), { host: "gitlab.com", path: "acme/x/admin-console" });
  assert.deepEqual(parseRemote("work-github:acme/releases.git"), { host: "work-github", path: "acme/releases" });
  assert.deepEqual(parseRemote("git@work-github:acme/docs.git"), { host: "work-github", path: "acme/docs" });
  assert.deepEqual(parseRemote("ssh://git@github.com:22/o/r.git"), { host: "github.com", path: "o/r" });
  assert.equal(providerOf("github.com"), "github");
  assert.equal(providerOf("gitlab.com"), "gitlab");
  assert.equal(providerOf("work-github"), null);
});

test("diffs and log", () => {
  const rows = diffRows(["@@ -1,2 +1,3 @@ x", " a", "-b", "+B", "+C", "\\ No newline at end of file"]);
  assert.deepEqual(rows.map((row) => row.kind), ["@", " ", "-", "+", "+"]);
  assert.equal(rows[3].next, 2);
  const split = splitRows(rows);
  assert.equal(split.length, 4);
  assert.equal(split[3].left, null);
  assert.equal(parseHunks("@@ -3 +3,0 @@\n-x\n")[0].kind, "removed");
  assert.deepEqual(parseLog("h1\x00s1\x00Ann\x00100\x00subj one\x1e\nh2\x00s2\x00Bob\x00200\x00two\x1e\n").map((commit) => commit.short), ["s1", "s2"]);
});
