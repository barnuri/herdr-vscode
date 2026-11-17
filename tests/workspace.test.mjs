import { test } from "node:test";
import assert from "node:assert/strict";
import { relativePath, folderEntry, editFolders, stringifyWorkspace, newWorkspace, rootsFromWorkspace } from "../shared/ws-core.js";

test("relative paths", () => {
  assert.equal(relativePath("/w", "/w/srv"), "srv");
  assert.equal(relativePath("/w/a", "/w/b/c"), "../b/c");
  assert.equal(relativePath("/w", "/w"), ".");
  assert.deepEqual(folderEntry("/w", "/w/srv"), { path: "srv" });
  assert.deepEqual(folderEntry("/w", "/w/srv", "Server"), { path: "srv", name: "Server" });
  assert.deepEqual(folderEntry("/a/b/c/d", "/x/y"), { path: "/x/y" });
});

test("add, remove, rename, move keep everything else", () => {
  const json = { folders: [{ path: "web" }, { path: "srv", name: "S" }], settings: { a: 1 } };
  const added = editFolders(json, "/w", { type: "add", paths: ["/w/infra", "/w/web"] });
  assert.deepEqual(added.folders.map((f) => f.path), ["web", "srv", "infra"]);
  assert.deepEqual(added.settings, { a: 1 });
  assert.equal(json.folders.length, 2); // not mutated
  const removed = editFolders(added, "/w", { type: "remove", path: "/w/web" });
  assert.deepEqual(removed.folders.map((f) => f.path), ["srv", "infra"]);
  const renamed = editFolders(removed, "/w", { type: "rename", path: "/w/srv", name: "srv" });
  assert.deepEqual(renamed.folders[0], { path: "srv" }); // back to its own name: no `name`
  const moved = editFolders(added, "/w", { type: "move", path: "/w/infra", to: 0 });
  assert.deepEqual(moved.folders.map((f) => f.path), ["infra", "web", "srv"]);
  assert.match(stringifyWorkspace(moved), /^\{\n\t"folders"/);
});

test("new workspace round-trips", () => {
  const json = newWorkspace("/w", ["/w/a", "/w/b"]);
  assert.deepEqual(rootsFromWorkspace("/w/x.code-workspace", json).map((r) => r.path), ["/w/a", "/w/b"]);
});
