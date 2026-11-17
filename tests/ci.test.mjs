import { test } from "node:test";
import assert from "node:assert/strict";
import { glRun, glJob, ghRun, ghJob, byStage, duration, gitlabVariables, glKind, ghKind } from "../shared/ci-core.js";

test("gitlab pipeline + job mapping", () => {
  const r = glRun({ id: 1001, iid: 12, status: "running", ref: "staging", sha: "abc", source: "push", created_at: "2026-01-01T09:00:00Z", web_url: "u" });
  assert.equal(r.kind, "running");
  assert.equal(r.number, 12);
  assert.equal(glKind("failed", true), "warning");
  const j = glJob({ id: 1, name: "test", stage: "test", status: "failed", allow_failure: false, duration: 83.4, artifacts: [{ file_type: "archive" }], web_url: "w" });
  assert.deepEqual([j.kind, j.label, j.artifacts], ["failure", "failed", true]);
});

test("github run + job mapping", () => {
  const r = ghRun({ id: 9, run_number: 42, display_title: "Fix", head_branch: "main", status: "completed", conclusion: "success", created_at: "x", updated_at: "y", html_url: "h", event: "push", actor: { login: "me" }, name: "CI" });
  assert.deepEqual([r.kind, r.label, r.finished, r.actor], ["success", "passed", "y", "me"]);
  assert.equal(ghKind("queued", null), "queued");
  assert.equal(ghJob({ id: 1, name: "b", status: "completed", conclusion: "cancelled", started_at: "2026-01-01T00:00:00Z", completed_at: "2026-01-01T00:01:30Z" }).seconds, 90);
});

test("stages, durations", () => {
  const g = byStage([{ stage: "build" }, { stage: "test" }, { stage: "build" }]);
  assert.deepEqual(g.map((s) => [s.stage, s.jobs.length]), [["build", 2], ["test", 1]]);
  assert.equal(duration(42), "42s");
  assert.equal(duration(125), "2m 5s");
  assert.equal(duration(3725), "1h 2m");
  assert.equal(duration(null), "");
});

test(".gitlab-ci.yml variables", () => {
  const yaml = `stages: [build]
variables:
  # comment
  NODE_VERSION: "24"
  DEPLOY_ENV:
    value: "staging"
    description: "Where to deploy"
    options: ["staging", "prod"]
  EMPTY:
build:
  script: echo hi
`;
  assert.deepEqual(gitlabVariables(yaml), [
    { key: "NODE_VERSION", value: "24", description: null, options: null },
    { key: "DEPLOY_ENV", value: "staging", description: "Where to deploy", options: ["staging", "prod"] },
    { key: "EMPTY", value: "", description: null, options: null },
  ]);
  assert.deepEqual(gitlabVariables("build:\n  script: x\n"), []);
});
