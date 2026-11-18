import { test } from "node:test";
import assert from "node:assert/strict";
import { groupRunning, rollupStatus } from "../mods/vx-running/running-core.js";

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

test("groupRunning skips mod panes and sorts urgent folders first", () => {
  const folders = groupRunning({
    panes: [
      pane({ pane: "m1", terminal: null, cwd: null, mod: "vx-files" }),
      pane({ pane: "p1", cwd: "/a", status: "idle" }),
      pane({ pane: "p2", cwd: "/b", status: "blocked" }),
    ],
    spaces,
  });
  assert.deepEqual(folders.map((folder) => folder.name), ["b", "a"]);
  assert.equal(folders[0].rows[0].kind, "agent");
});
