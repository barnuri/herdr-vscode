import { test } from "node:test";
import assert from "node:assert/strict";
import { nextUntitledNumber, isUntitledName, untitledDirtyKey, resolveSaveAs } from "../mods/herdr-vscode-files/untitled-core.js";

test("nextUntitledNumber passes the counter and every open Untitled-N", () => {
  assert.equal(nextUntitledNumber([], 0), 1);
  assert.equal(nextUntitledNumber(["main.js", "Untitled-1"], 0), 2);
  assert.equal(nextUntitledNumber(["Untitled-3", "Untitled-1"], 1), 4);
  assert.equal(nextUntitledNumber(["Untitled-1"], 7), 8);
  assert.equal(nextUntitledNumber(["Untitled-x", "My Untitled-9", null], 0), 1);
});

test("isUntitledName and the dirty key", () => {
  assert.ok(isUntitledName("Untitled-12"));
  assert.ok(!isUntitledName("Untitled-"));
  assert.ok(!isUntitledName("untitled-1"));
  assert.equal(untitledDirtyKey("Untitled-2"), "untitled:Untitled-2");
});

test("resolveSaveAs: relative to the repo, ~, absolute, dots, and errors", () => {
  assert.deepEqual(resolveSaveAs("notes.md", "/r/app", "/h"), { path: "/r/app/notes.md", dir: "/r/app", name: "notes.md" });
  assert.deepEqual(resolveSaveAs(" docs/a.txt ", "/r/app", "/h"), { path: "/r/app/docs/a.txt", dir: "/r/app/docs", name: "a.txt" });
  assert.equal(resolveSaveAs("~/x.js", "/r/app", "/h").path, "/h/x.js");
  assert.equal(resolveSaveAs("/tmp/./y/../z.txt", "/r/app", "/h").path, "/tmp/z.txt");
  assert.equal(resolveSaveAs("../other/b.js", "/r/app", "/h").path, "/r/other/b.js");
  assert.equal(resolveSaveAs("c.txt", "", "/h").path, "/h/c.txt");
  assert.deepEqual(resolveSaveAs("/a.txt", "/r", "/h"), { path: "/a.txt", dir: "/", name: "a.txt" });
  assert.ok(resolveSaveAs("  ", "/r", "/h").error);
  assert.ok(resolveSaveAs("dir/", "/r", "/h").error);
  assert.ok(resolveSaveAs("~", "/r", "/h").error);
});

test("isEmptyEditorTab needs the empty mod as the only, non-terminal pane", async () => {
  const { isEmptyEditorTab, closeDetail } = await import("../shared/untitled-core.js");
  const empty = { id: "p1", tab: "t1", mod: "herdr-vscode-empty" };
  assert.equal(isEmptyEditorTab("t1", [empty], "herdr-vscode-empty"), true);
  assert.equal(isEmptyEditorTab("t1", [empty, { id: "p2", tab: "t1", terminal: true }], "herdr-vscode-empty"), false);
  assert.equal(isEmptyEditorTab("t1", [{ ...empty, terminal: true }], "herdr-vscode-empty"), false);
  assert.equal(isEmptyEditorTab("t1", [{ id: "p3", tab: "t1", mod: "herdr-vscode-files" }], "herdr-vscode-empty"), false);
  assert.equal(isEmptyEditorTab("t1", [], "herdr-vscode-empty"), false);
  const detail = closeDetail({ id: "t1", name: "x" }, [empty, { id: "p2", tab: "t1", terminal: true }], "stale empty");
  assert.deepEqual(detail.terminals, ["p2"]);
  assert.equal(detail.reason, "stale empty");
});
