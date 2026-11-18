import { test } from "node:test";
import assert from "node:assert/strict";
import { primaryAction, discardPlan, splitHunks, hunkPatch, initials, statBlocks, subjectInfo, commitUrl, badBranchName } from "../shared/scm-core.js";

const base = { amend: false, staged: 0, unstaged: 0, conflicts: 0, ahead: 0, behind: 0, upstream: "origin/main", branch: "main", head: "abc", message: "" };

test("primaryAction: commit, commit all, amend, sync, publish, nothing", () => {
  assert.deepEqual([primaryAction({ ...base, staged: 2, message: "x" }).kind, primaryAction({ ...base, staged: 2, message: "x" }).enabled], ["commit", true]);
  assert.equal(primaryAction({ ...base, staged: 2 }).enabled, false);
  assert.equal(primaryAction({ ...base, unstaged: 3, message: "x" }).kind, "commitAll");
  assert.equal(primaryAction({ ...base, amend: true, message: "x" }).kind, "amend");
  assert.equal(primaryAction({ ...base, ahead: 2, behind: 1 }).kind, "sync");
  assert.equal(primaryAction({ ...base, upstream: null }).kind, "publish");
  assert.equal(primaryAction({ ...base, upstream: null, head: null }).enabled, false);
  assert.equal(primaryAction(base).enabled, false);
  assert.equal(primaryAction({ ...base, staged: 1, conflicts: 1, message: "x" }).enabled, false);
});

test("discardPlan: tracked files restored, new files trashed, conflicts kept", () => {
  const files = [
    { path: "a", unstaged: true }, { path: "b", untracked: true, unstaged: true },
    { path: "c", conflict: true, unstaged: true }, { path: "d", staged: true, unstaged: false },
  ];
  assert.deepEqual(discardPlan(files), { restore: ["a"], trash: ["b"] });
});

test("splitHunks + hunkPatch: one hunk as an applicable patch", () => {
  const lines = ["diff --git a/x b/x", "index 1..2 100644", "--- a/x", "+++ b/x", "@@ -1,2 +1,2 @@", " a", "-b", "+c", "@@ -9 +9 @@", "-y", "+z", "\\ No newline at end of file"];
  const { head, hunks } = splitHunks(lines);
  assert.equal(head.length, 4);
  assert.equal(hunks.length, 2);
  assert.equal(hunkPatch(head, hunks[1]), "diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -9 +9 @@\n-y\n+z\n\\ No newline at end of file\n");
});

test("initials, statBlocks, subjectInfo", () => {
  assert.equal(initials("Maya Chen"), "MC");
  assert.equal(initials("leo"), "LE");
  assert.equal(initials("sam.rivera"), "SR");
  assert.equal(initials(""), "?");
  assert.deepEqual(statBlocks(0, 0), [" ", " ", " ", " ", " "]);
  assert.deepEqual(statBlocks(3, 0), ["+", " ", " ", " ", " "]);
  const big = statBlocks(400, 400);
  assert.equal(big.filter((b) => b === "+").length + big.filter((b) => b === "-").length, 5);
  assert.ok(statBlocks(1, 1).includes("-"));
  assert.deepEqual(subjectInfo("fix: short"), { len: 10, level: "ok" });
  assert.equal(subjectInfo("x".repeat(60)).level, "long");
  assert.equal(subjectInfo(`${"x".repeat(80)}\nbody`).level, "over");
});

test("commitUrl and badBranchName", () => {
  assert.equal(commitUrl({ host: "github.com", path: "o/r" }, "abc"), "https://github.com/o/r/commit/abc");
  assert.equal(commitUrl({ host: "gitlab.com", path: "g/r" }, "abc"), "https://gitlab.com/g/r/-/commit/abc");
  assert.equal(commitUrl({ host: "example.org", path: "r" }, "abc"), null);
  assert.equal(badBranchName("feat/x-1"), null);
  assert.ok(badBranchName("a b"));
  assert.ok(badBranchName("a..b"));
  assert.ok(badBranchName("x.lock"));
  assert.ok(badBranchName(""));
});
