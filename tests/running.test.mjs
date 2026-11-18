import { test } from "node:test";
import assert from "node:assert/strict";
import { groupRunning, rollupStatus, sortFolders, planClose, buildTree, displayTitle } from "../mods/vx-running/running-core.js";
import { pickPrefs, DEFAULT_PREFS } from "../mods/vx-running/running-core.js";

const spaces = [{ id: "s1", name: "work", tabs: [{ id: "t1", name: "fix" }, { id: "t2", name: "" }] }];
const pane = (overrides) => ({ pane: "p", terminal: "t9", tab: "t1", cwd: "/r/a", title: "", status: null, program: { name: "zsh" }, focused: false, branch: null, ...overrides });

test("rollupStatus picks the most urgent agent status", () => {
  assert.equal(rollupStatus(["idle", "blocked", "working"]), "blocked");
  assert.equal(rollupStatus(["idle", "done"]), "done");
  assert.equal(rollupStatus([]), null);
});

test("groupRunning groups panes by repo root, else cwd", () => {
  const folders = groupRunning({
    panes: [
      pane({ pane: "p1", cwd: "/r/a/src" }),
      pane({ pane: "p2", cwd: "/r/a", status: "working", program: { name: "Claude Code" } }),
      pane({ pane: "p3", cwd: "/tmp/x", tab: "t2" }),
    ],
    spaces,
    roots: { "/r/a/src": "/r/a", "/r/a": "/r/a" },
  });
  assert.deepEqual(folders.map((folder) => folder.path), ["/r/a", "/tmp/x"]);
  assert.equal(folders[0].agentCount, 1);
  assert.equal(folders[0].terminalCount, 1);
  assert.equal(folders[0].status, "working");
  assert.equal(folders[0].isRepo, true);
  assert.equal(folders[1].isRepo, false);
  assert.equal(folders[0].rows[0].spaceName, "work");
  assert.equal(folders[0].rows[0].tabName, "fix");
});

test("groupRunning skips mod panes and keeps opened order; sortFolders reorders", () => {
  const folders = groupRunning({
    panes: [
      pane({ pane: "m1", terminal: null, cwd: null, mod: "vx-files" }),
      pane({ pane: "p1", cwd: "/a", status: "idle" }),
      pane({ pane: "p2", cwd: "/c", status: "blocked" }),
      pane({ pane: "p3", cwd: "/b" }),
    ],
    spaces,
  });
  assert.deepEqual(folders.map((folder) => folder.name), ["a", "c", "b"]);
  assert.deepEqual(sortFolders(folders, "status").map((folder) => folder.name), ["c", "a", "b"]);
  assert.deepEqual(sortFolders(folders, "name").map((folder) => folder.name), ["a", "b", "c"]);
  assert.deepEqual(sortFolders(folders, "opened").map((folder) => folder.name), ["a", "c", "b"]);
});

test("planClose picks panes by mode", () => {
  const folders = groupRunning({
    panes: [
      pane({ pane: "idle-shell", cwd: "/a", program: { name: "zsh", shell: true } }),
      pane({ pane: "busy", cwd: "/b", program: { name: "vim", shell: false } }),
      pane({ pane: "idle-agent", cwd: "/b", status: "idle" }),
      pane({ pane: "working", cwd: "/c", status: "working" }),
    ],
    spaces,
  });
  const ids = (mode) => planClose(folders, mode).map((row) => row.pane).sort();
  assert.deepEqual(ids("empty-folders"), ["idle-shell"]);
  assert.deepEqual(ids("idle-agents-and-empty-folders"), ["idle-agent", "idle-shell"]);
  assert.deepEqual(ids("terminals"), ["busy", "idle-shell"]);
  assert.equal(ids("all").length, 4);
  assert.throws(() => planClose(folders, "nope"));
});

test("buildTree merges single-child dirs and skips shared ancestors", () => {
  const folders = groupRunning({ panes: [pane({ pane: "1", cwd: "/u/s/x/a" }), pane({ pane: "2", cwd: "/u/s/y" })], spaces });
  const tree = buildTree(folders);
  assert.deepEqual(tree.map((node) => [node.type, node.name]), [["dir", "s"]]);
  assert.deepEqual(tree[0].children.map((node) => [node.type, node.name]), [["dir", "x"], ["folder", "y"]]);
  assert.equal(tree[0].children[0].children[0].name, "a");
});

test("displayTitle drops shell and agent-name titles", () => {
  assert.equal(displayTitle("Current Folder: ~/x", "zsh"), "");
  assert.equal(displayTitle("OC | fix login", "OpenCode"), "fix login");
  assert.equal(displayTitle("Claude Code", "Claude Code"), "");
});

test("pickPrefs keeps typed keys and fills defaults", () => {
  assert.deepEqual(pickPrefs(null), DEFAULT_PREFS);
  const prefs = pickPrefs({ sort: "name", confirmKill: "yes", collapsed: { "/a": true }, width: 19 });
  assert.equal(prefs.sort, "name");
  assert.equal(prefs.confirmKill, false);
  assert.deepEqual(prefs.collapsed, { "/a": true });
  assert.equal(prefs.width, undefined);
});
