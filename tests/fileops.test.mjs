import { test } from "node:test";
import assert from "node:assert/strict";
import { copyName, pastePlan, lineAnchor, fileWebUrl, autoSaveDue, autoSaveMode } from "../shared/fileops-core.js";

test("copyName picks the first free copy name", () => {
  assert.equal(copyName("a.txt", new Set(["a.txt"])), "a copy.txt");
  assert.equal(copyName("a.txt", new Set(["a.txt", "a copy.txt"])), "a copy 2.txt");
  assert.equal(copyName(".env", new Set()), ".env copy");
});

test("pastePlan resolves the target and conflicts", () => {
  assert.deepEqual(pastePlan({ path: "/r/a.txt" }, "/r/d", ["b"]), { source: "/r/a.txt", target: "/r/d/a.txt", move: false, conflict: false });
  assert.equal(pastePlan({ path: "/r/a.txt", cut: true }, "/r/d", ["a.txt"]).conflict, true);
  assert.equal(pastePlan({ path: "/r/a.txt" }, "/r", ["a.txt"]).target, "/r/a copy.txt");
  assert.equal(pastePlan({ path: "/r/a.txt", cut: true }, "/r", ["a.txt"]).skip, true);
  assert.equal(pastePlan({ path: "/r/d", cut: true }, "/r/d/e", []).skip, true);
  assert.equal(pastePlan(null, "/r", []).skip, true);
});

test("remote file links carry the line anchor of each host", () => {
  assert.equal(lineAnchor("github", { start: 5 }), "#L5");
  assert.equal(lineAnchor("github", { start: 5, end: 9 }), "#L5-L9");
  assert.equal(lineAnchor("gitlab", { start: 5, end: 9 }), "#L5-9");
  assert.equal(lineAnchor("github", null), "");
  assert.equal(fileWebUrl({ host: "github.com", path: "o/r" }, "main", "src/a b.js", { start: 3 }), "https://github.com/o/r/blob/main/src/a%20b.js#L3");
  assert.equal(fileWebUrl({ host: "gitlab.example.com", path: "g/r" }, "feat/x", "a.js"), "https://gitlab.example.com/g/r/-/blob/feat/x/a.js");
  assert.equal(fileWebUrl({ host: "example.com", path: "o/r" }, "main", "a.js"), null);
  assert.equal(fileWebUrl(null, "main", "a.js"), null);
});

test("auto save waits for the pause, saves on blur, and respects off", () => {
  const base = { mode: "afterDelay", dirty: true, writable: true, editedAt: 1000 };
  assert.equal(autoSaveDue({ ...base, now: 1500 }), false);
  assert.equal(autoSaveDue({ ...base, now: 2000 }), true);
  assert.equal(autoSaveDue({ ...base, now: 1100, blurred: true }), true);
  assert.equal(autoSaveDue({ ...base, mode: "off", now: 9000, blurred: true }), false);
  assert.equal(autoSaveDue({ ...base, writable: false, now: 9000 }), false);
  assert.equal(autoSaveDue({ ...base, dirty: false, now: 9000 }), false);
  assert.equal(autoSaveMode(undefined), "afterDelay");
});
