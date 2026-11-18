import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSettings, readSetting, withSetting, withSettings, formatSettings } from "../shared/settings-core.js";

test("parseSettings: empty or missing text is no settings", () => {
  assert.deepEqual(parseSettings(null), { settings: {}, error: null });
  assert.deepEqual(parseSettings("  \n"), { settings: {}, error: null });
});

test("parseSettings: reads the existing activity shape", () => {
  const text = '{"activity":{"order":["running"],"hidden":["ci"],"explorerSections":{"npm":false}}}';
  assert.deepEqual(parseSettings(text).settings.activity.hidden, ["ci"]);
});

test("parseSettings: broken JSON and non-objects report an error", () => {
  assert.ok(parseSettings("{oops").error);
  assert.ok(parseSettings("[1]").error);
  assert.deepEqual(parseSettings("[1]").settings, {});
});

test("readSetting: falls back when the section or key is missing", () => {
  const settings = { scm: { view: "tree" }, files: "bad" };
  assert.equal(readSetting(settings, "scm", "view", "flat"), "tree");
  assert.equal(readSetting(settings, "scm", "split", false), false);
  assert.equal(readSetting(settings, "files", "autoSave", "afterDelay"), "afterDelay");
  assert.equal(readSetting(undefined, "scm", "view", "flat"), "flat");
  assert.equal(readSetting({ ci: { mine: false } }, "ci", "mine", true), false);
});

test("withSetting: merges one key and keeps the other sections and keys", () => {
  const before = { activity: { order: ["a"] }, scm: { view: "flat", split: true } };
  const after = withSetting(before, "scm", "view", "tree");
  assert.deepEqual(after, { activity: { order: ["a"] }, scm: { view: "tree", split: true } });
  assert.equal(before.scm.view, "flat");
});

test("withSettings: creates a missing section and replaces a non-object one", () => {
  assert.deepEqual(withSettings({}, "ci", { mine: false, filter: "all" }), { ci: { mine: false, filter: "all" } });
  assert.deepEqual(withSettings({ ci: 3 }, "ci", { mine: true }), { ci: { mine: true } });
});

test("formatSettings: two-space JSON with a final newline", () => {
  assert.equal(formatSettings({ a: { b: 1 } }), '{\n  "a": {\n    "b": 1\n  }\n}\n');
});
