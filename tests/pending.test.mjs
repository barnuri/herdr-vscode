import { test } from "node:test";
import assert from "node:assert/strict";
import { markersOf, relativeTo, parseAudit, summaryText, syncKindOf } from "../mods/herdr-vscode-pending/pending-core.js";

const status = (overrides) => ({ branch: "master", upstream: true, behind: 0, ahead: 0, new: 0, untracked: 0, modify: 0, deleted: 0, merges: 0, ...overrides });

test("markersOf prints the skill's markers in its order, never behind", () => {
  const markers = markersOf(status({ behind: 145, ahead: 8, new: 1, untracked: 27, modify: 78, deleted: 2, merges: 3 }), false);
  assert.deepEqual(markers.map((marker) => marker.text), ["↑8", "+1", "?27", "±78", "-2", "!3"]);
  assert.deepEqual(markers.map((marker) => marker.kind), ["ahead", "added", "untracked", "modified", "deleted", "conflict"]);
  assert.deepEqual(markersOf(status({}), true), [{ kind: "noUpstream", text: "no upstream" }]);
  assert.deepEqual(markersOf(null, false), []);
});

test("relativeTo strips the scan root only", () => {
  assert.equal(relativeTo("/h/code/private/x", "/h/code/"), "private/x");
  assert.equal(relativeTo("/elsewhere/x", "/h/code"), "/elsewhere/x");
});

test("parseAudit reads the --json output and reports bad output", () => {
  const out = JSON.stringify({
    root: "/h/code", scanned: 70,
    pending: [
      { repo: "/h/code/work/app", has_remote: true, status: status({ modify: 2 }), head_never_pushed: false },
      { repo: "/h/code/private/new", has_remote: false, status: status({ branch: null, untracked: 1 }), head_never_pushed: true },
      { nope: true },
    ],
  });
  const result = parseAudit(out);
  assert.equal(result.scanned, 70);
  assert.deepEqual(result.repos.map((repo) => [repo.rel, repo.branch, repo.markers.map((marker) => marker.text).join(" ")]),
    [["work/app", "master", "±2"], ["private/new", "no branch", "?1 no upstream"]]);
  assert.equal(summaryText(result), "2 of 70 repos pending");
  assert.match(parseAudit("Traceback").error, /no JSON/);
  assert.match(parseAudit("{}").error, /pending/);
});

test("syncKindOf: push or pull only when commits are the only pending work", () => {
  const base = { has_remote: true, head_never_pushed: false, status: { upstream: true, ahead: 2, behind: 0 } };
  assert.equal(syncKindOf(base), "push");
  assert.equal(syncKindOf({ ...base, status: { ...base.status, behind: 1 } }), "pull");
  assert.equal(syncKindOf({ ...base, status: { ...base.status, modify: 1 } }), null);
  assert.equal(syncKindOf({ ...base, status: { ...base.status, untracked: 3 } }), null);
  assert.equal(syncKindOf({ ...base, status: { ...base.status, ahead: 0 } }), null);
  assert.equal(syncKindOf({ ...base, has_remote: false }), null);
  assert.equal(syncKindOf({ ...base, head_never_pushed: true }), null);
  assert.equal(syncKindOf({ ...base, status: { ...base.status, upstream: false } }), null);
});
