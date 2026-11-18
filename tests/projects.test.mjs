import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeConfig, addManualProject, pickCache, globToRegExp, isExcluded, projectDirOf, discovered, mergeProjects, fuzzyScore, fuzzyFilter, spaceFor, busyPaths,
} from "../mods/vx-projects/projects-core.js";

const HOME = "/h";

test("normalizeConfig keeps strings, expands ~ and names projects", () => {
  const config = normalizeConfig({ globs: ["~/s/*/.git", 3], excludes: ["~/s/old"], projects: [{ path: "~/x/" }, { path: "/y", name: "Why" }, { name: "bad" }] }, HOME);
  assert.deepEqual(config.globs, ["~/s/*/.git"]);
  assert.deepEqual(config.projects, [{ name: "x", path: "/h/x" }, { name: "Why", path: "/y" }]);
  assert.deepEqual(normalizeConfig(null, HOME), { globs: [], excludes: [], projects: [], autoOpen: true });
  assert.equal(normalizeConfig({ autoOpen: false }, HOME).autoOpen, false);
});

test("addManualProject appends once", () => {
  const once = addManualProject({ globs: ["a"], projects: [] }, "/r/app");
  assert.deepEqual(once, { globs: ["a"], projects: [{ name: "app", path: "/r/app" }] });
  assert.equal(addManualProject(once, "/r/app/"), once);
});

test("pickCache drops malformed entries", () => {
  assert.deepEqual(pickCache([{ name: "a", path: "/a" }, { name: 1 }, null]), [{ name: "a", path: "/a" }]);
  assert.deepEqual(pickCache({}), []);
});

test("globToRegExp handles *, **, ?, braces and classes", () => {
  assert.ok(globToRegExp("/s/*/x").test("/s/a/x"));
  assert.ok(!globToRegExp("/s/*/x").test("/s/a/b/x"));
  assert.ok(globToRegExp("/s/**/x").test("/s/a/b/x"));
  assert.ok(globToRegExp("/s/**/x").test("/s/x"));
  assert.ok(globToRegExp("/s/{a,b}?").test("/s/bz"));
  assert.ok(globToRegExp("/s/[!a]x").test("/s/bx"));
  assert.ok(!globToRegExp("/s/a.b").test("/s/aXb"));
});

test("excludes beat globs: glob match or a whole tree", () => {
  assert.ok(isExcluded("/h/s/old/app", ["~/s/old"], HOME));
  assert.ok(isExcluded("/h/s/vendor-x", ["~/s/vendor-*"], HOME));
  assert.ok(!isExcluded("/h/s/older", ["~/s/old"], HOME));
  assert.ok(!isExcluded("/h/s/a", [" "], HOME));
});

test("discovery registers a .git match's parent, deduped and excluded", () => {
  assert.equal(projectDirOf("/h/s/a/.git"), "/h/s/a");
  assert.equal(projectDirOf("/h/s/b/"), "/h/s/b");
  const found = discovered(["/h/s/a/.git", "/h/s/a", "/h/s/old/b/.git"], ["~/s/old"], HOME);
  assert.deepEqual(found, [{ name: "a", path: "/h/s/a", source: "glob" }]);
});

test("mergeProjects: manual wins, sorted, same names told apart", () => {
  const merged = mergeProjects(
    [{ name: "Mine", path: "/h/s/a" }],
    [{ name: "a", path: "/h/s/a", source: "glob" }, { name: "api", path: "/w/one/api", source: "glob" }, { name: "api", path: "/w/two/api", source: "glob" }],
  );
  assert.deepEqual(merged.map((project) => project.name), ["api (one)", "api (two)", "Mine"]);
  assert.equal(merged[2].source, "manual");
});

test("fuzzy: word starts and runs score higher; no match drops", () => {
  assert.equal(fuzzyScore("herdr-vscode", "xyz"), null);
  assert.ok(fuzzyScore("herdr-vscode", "vs") > fuzzyScore("advisor", "vs"));
  const names = fuzzyFilter([{ name: "advisor" }, { name: "herdr-vscode" }, { name: "zz" }], "vs").map((project) => project.name);
  assert.deepEqual(names, ["herdr-vscode", "advisor"]);
  assert.equal(fuzzyFilter([{ name: "a" }], " ").length, 1);
});

test("spaceFor and busyPaths find open projects", () => {
  const spaces = [{ id: "s1", folder: "/r/a/", machine: null }, { id: "s2", folder: "/r/b", machine: "box" }];
  assert.equal(spaceFor({ path: "/r/a" }, spaces).id, "s1");
  assert.equal(spaceFor({ path: "/r/b" }, spaces), null);
  const busy = busyPaths([{ path: "/r/a" }, { path: "/r/b" }, { path: "/r/c" }], [{ cwd: "/r/a/src" }, { cwd: "/r/bb" }, { cwd: null }]);
  assert.deepEqual([...busy], ["/r/a"]);
});

// Mirrors herdr-project-manager tests/discover.test.js "isExcluded".
test("isExcluded matches the plugin's vectors", async () => {
  const { isExcluded: excluded } = await import("../mods/vx-projects/projects-core.js");
  assert.equal(excluded("/opt/repos/widget", undefined, HOME), false);
  assert.equal(excluded("/opt/repos/widget", [], HOME), false);
  assert.equal(excluded("/opt/repos/widget", "not-an-array", HOME), false);
  assert.equal(excluded("/opt/repos/vendor/widget", ["/opt/repos/vendor/*"], HOME), true);
  assert.equal(excluded("/opt/repos/widget", ["/opt/repos/vendor/*"], HOME), false);
  assert.equal(excluded("/opt/repos/vendor/a/b", ["/opt/repos/vendor"], HOME), true);
  assert.equal(excluded("/opt/repos/vendor", ["/opt/repos/vendor"], HOME), true);
  assert.equal(excluded("/opt/repos/vendor-other", ["/opt/repos/vendor"], HOME), false);
  assert.equal(excluded("/h/vendor/a", ["~/vendor"], HOME), true);
  assert.equal(excluded("/opt/repos/widget", ["", "   ", null, 42], HOME), false);
  // "**/out" drops a project named out, not the projects under it (as path.matchesGlob does).
  assert.equal(excluded("/r/scripts/out", ["**/out"], HOME), true);
  assert.equal(excluded("/r/scripts/out/pages", ["**/out"], HOME), false);
  // "**/out/**" drops what is inside an out folder, not the folder itself (Node's matchesGlob).
  assert.equal(excluded("/r/scripts/out", ["**/out/**"], HOME), false);
  assert.equal(excluded("/r/scripts/out/pages", ["**/out/**"], HOME), true);
});

test("discoveryPlan: .git globs become a pruned find from the literal root", async () => {
  const { discoveryPlan, findArgs, findMatches } = await import("../mods/vx-projects/projects-core.js");
  const plan = discoveryPlan(["~/s/**/.git", "~/x/*", " "], ["~/s/skip", "**/node_modules", "rel/path", "**/out/**", "**/a*b/**"], HOME);
  assert.deepEqual(plan.finds, [{ glob: "/h/s/**/.git", root: "/h/s" }]);
  assert.deepEqual(plan.shell, ["/h/x/*"]);
  assert.deepEqual(plan.prunes, ["/h/s/skip", "*/out/*"]);
  const args = findArgs("/h/s", ["/h/s/skip"]);
  assert.deepEqual(args, ["/h/s", "-mindepth", "1", "(", "-name", ".git", "-print", "-prune", ")", "-o",
    "(", "-name", ".*", "-o", "-name", "node_modules", "-o", "-path", "/h/s/skip", ")", "-prune"]);
  assert.deepEqual(findMatches("/h/s/a/.git\n/h/s/b/c/.git\n/h/other/.git\n/h/s/.git\n", "/h/s/**/.git"), ["/h/s/a/.git", "/h/s/b/c/.git", "/h/s/.git"]);
  assert.deepEqual(findMatches("/h/s/a/.git\n/h/s/b/c/.git\n", "/h/s/*/.git"), ["/h/s/a/.git"]);
});

test("sortProjects and removeManualProject", async () => {
  const { sortProjects, removeManualProject } = await import("../mods/vx-projects/projects-core.js");
  assert.deepEqual(sortProjects([{ name: "beta" }, { name: "CSharp" }, { name: "Alpha" }, { name: "alpha2" }]).map((project) => project.name), ["Alpha", "alpha2", "beta", "CSharp"]);
  const raw = { globs: ["g"], autoOpen: false, projects: [{ name: "a", path: "/a" }, { name: "b", path: "/b/" }] };
  assert.deepEqual(removeManualProject(raw, "/b"), { globs: ["g"], autoOpen: false, projects: [{ name: "a", path: "/a" }] });
});

test("repoWebUrl builds the repository page from origin, ssh aliases resolved", async () => {
  const { parseRemote } = await import("../mods/vx-projects/git-core.js");
  const { repoWebUrl, sshHostname } = await import("../mods/vx-projects/scm-core.js");
  assert.equal(repoWebUrl(parseRemote("git@github.com:barnuri/herdr-vscode.git")), "https://github.com/barnuri/herdr-vscode");
  assert.equal(repoWebUrl(parseRemote("https://gitlab.example.com/group/sub/app.git")), "https://gitlab.example.com/group/sub/app");
  assert.equal(repoWebUrl(parseRemote("ssh://git@github.com:22/o/r")), "https://github.com/o/r");
  const alias = parseRemote("work-gh:org/repo.git");
  alias.host = sshHostname("user git\nhostname github.com\nport 22\n") ?? alias.host;
  assert.equal(repoWebUrl(alias), "https://github.com/org/repo");
  assert.equal(sshHostname("port 22"), null);
  assert.equal(repoWebUrl(null), null);
  assert.equal(repoWebUrl(parseRemote("not a url")), null);
});

test("parseConfigText: missing is empty, broken JSON is an error", async () => {
  const { parseConfigText } = await import("../mods/vx-projects/projects-core.js");
  assert.deepEqual(parseConfigText(null), { raw: null, error: null });
  assert.deepEqual(parseConfigText('{"globs":[]}'), { raw: { globs: [] }, error: null });
  assert.ok(parseConfigText('{"globs": ["a" "b"]}').error);
  assert.equal(parseConfigText("[]").error, "not a JSON object");
});
