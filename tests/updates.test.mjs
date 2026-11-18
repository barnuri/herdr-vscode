import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readUpdateConfig, withUpdateConfig, updateKind, decideUpdate, appPlan, corePlan, checkDue, canAct, versionsLabel, waitingNotes, UPDATE_DEFAULTS,
} from "../mods/vx-updates/updates-core.js";

test("readUpdateConfig: defaults, booleans only, interval at least 15, broken JSON reported", () => {
  assert.deepEqual(readUpdateConfig("{}").config, UPDATE_DEFAULTS);
  const read = readUpdateConfig(JSON.stringify({ autoUpdateMajors: false, autoUpdateApp: "no", checkIntervalMinutes: 5, logLevel: "debug" }));
  assert.equal(read.config.autoUpdateMajors, false);
  assert.equal(read.config.autoUpdateApp, true);
  assert.equal(read.config.checkIntervalMinutes, 15);
  assert.equal(read.raw.logLevel, "debug");
  assert.ok(readUpdateConfig("{bad").error);
  assert.deepEqual(withUpdateConfig({ logLevel: "debug", autoUpdateApp: true }, { autoUpdateApp: false }), { logLevel: "debug", autoUpdateApp: false });
});

test("updateKind and decideUpdate port the plugin's semver rules", () => {
  assert.equal(updateKind("1.2.3", "2.0.0"), "major");
  assert.equal(updateKind("v1.2.3", "1.3.0"), "minor");
  assert.equal(updateKind("1.2.3", "1.2.4-beta"), "patch");
  assert.equal(updateKind("1.2.3", "1.2.3"), null);
  assert.equal(updateKind("1.3.0", "1.2.9"), null);
  assert.equal(updateKind("x", "1.0.0"), null);
  const config = { ...UPDATE_DEFAULTS, autoUpdateMajors: false };
  assert.deepEqual(decideUpdate(config, "1.0.0", "2.0.0"), { action: "skip", kind: "major" });
  assert.deepEqual(decideUpdate(config, "1.0.0", "1.0.1"), { action: "update", kind: "patch" });
});

test("appPlan waits for working or blocked agents and honours autoUpdateApp", () => {
  const info = { app: { version: "1.0.0", ready: "1.0.1", updates: true } };
  assert.equal(appPlan(info, UPDATE_DEFAULTS, [{ status: "idle" }, { status: "done" }]).action, "update");
  const waiting = appPlan(info, UPDATE_DEFAULTS, [{ status: "working" }, { status: "blocked" }]);
  assert.deepEqual([waiting.action, waiting.busy], ["wait", 2]);
  assert.equal(appPlan(info, { ...UPDATE_DEFAULTS, autoUpdateApp: false }, []).action, "skip");
  assert.equal(appPlan({ app: { ...info.app, updates: false } }, UPDATE_DEFAULTS, []).action, "none");
  assert.equal(appPlan({ app: { version: "1.0.0", ready: null, updates: true } }, UPDATE_DEFAULTS, []).action, "none");
});

test("corePlan: managed, busy, off, allowed", () => {
  const core = { version: "0.4.0", ready: "0.5.0", managed: null, updating: false };
  assert.deepEqual(corePlan({ core }, UPDATE_DEFAULTS), { action: "update", kind: "minor" });
  assert.equal(corePlan({ core: { ...core, managed: "homebrew" } }, UPDATE_DEFAULTS).action, "managed");
  assert.equal(corePlan({ core: { ...core, updating: true } }, UPDATE_DEFAULTS).action, "busy");
  assert.equal(corePlan({ core }, { ...UPDATE_DEFAULTS, autoUpdateCore: false }).action, "skip");
  assert.equal(corePlan({ core: { ...core, ready: null } }, UPDATE_DEFAULTS).action, "none");
});

test("checkDue uses the newer of our attempt and the app's own check", () => {
  const config = { ...UPDATE_DEFAULTS, checkIntervalMinutes: 15 };
  const now = 10_000_000;
  assert.equal(checkDue(config, null, null, now), true);
  assert.equal(checkDue(config, now - 60_000, null, now), false);
  assert.equal(checkDue(config, now - 16 * 60_000, (now - 60_000) / 1000, now), false);
  assert.equal(checkDue(config, now - 16 * 60_000, null, now), true);
});

test("canAct: the lease holder, or anyone once it went stale", () => {
  assert.equal(canAct(null, "a", 100, 50), true);
  assert.equal(canAct({ owner: "a", at: 90 }, "a", 100, 50), true);
  assert.equal(canAct({ owner: "b", at: 90 }, "a", 100, 50), false);
  assert.equal(canAct({ owner: "b", at: 10 }, "a", 100, 50), true);
});

test("versionsLabel and waitingNotes", () => {
  const info = {
    app: { version: "1.2.0", ready: null, updates: true },
    core: { version: "0.9.0", ready: "0.9.1", managed: null },
    notes: [{ version: "1.3.0", items: [] }, { version: "1.2.0", items: [] }, { version: "1.1.0", items: [] }],
  };
  assert.deepEqual(versionsLabel(info), { text: "app 1.2.0 · core 0.9.0", waiting: "0.9.1" });
  assert.equal(versionsLabel({ ...info, core: { ...info.core, managed: "nix" } }).waiting, null);
  assert.equal(versionsLabel(null), null);
  assert.deepEqual(waitingNotes(info).map((note) => note.version), ["1.3.0"]);
});
