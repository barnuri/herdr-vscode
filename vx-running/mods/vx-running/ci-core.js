// CI runs from GitLab (pipelines) and GitHub (Actions runs) as one shape.
//   run = { id, number, title, ref, sha, kind, label, created, started, finished, url, event, actor, workflow }
//   job = { id, name, stage, kind, label, started, finished, seconds, url, artifacts }

const GITLAB_KINDS = {
  running: "running", created: "queued", waiting_for_resource: "queued", preparing: "queued",
  pending: "queued", scheduled: "queued", success: "success", failed: "failure",
  canceled: "canceled", canceling: "canceled", skipped: "skipped", manual: "manual",
};
const GITHUB_CONCLUSION_KINDS = {
  success: "success", failure: "failure", timed_out: "failure", startup_failure: "failure",
  cancelled: "canceled", skipped: "skipped", action_required: "manual", neutral: "skipped", stale: "skipped",
};
const LABELS = {
  running: "running", queued: "queued", success: "passed", failure: "failed",
  warning: "passed with warnings", canceled: "canceled", skipped: "skipped", manual: "manual",
};
const ACTIVE_KINDS = ["running", "queued"];
const DEFAULT_STAGE = "jobs";
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const SINCE_UNITS = [["d", 86400], ["h", 3600], ["m", 60]];
const TRAILING_COMMENT = /\s+#.*$/;
const VARIABLE_LINE = /^\s*([A-Za-z_][\w.-]*):\s*(.*?)\s*$/;

export function glKind(status, allowFailure = false) {
  const kind = GITLAB_KINDS[status] ?? "queued";
  return kind === "failure" && allowFailure ? "warning" : kind;
}

export function ghKind(status, conclusion) {
  if (status === "in_progress") {
    return "running";
  }
  if (status && status !== "completed") {
    return "queued";
  }
  return GITHUB_CONCLUSION_KINDS[conclusion] ?? "skipped";
}

export const labelOf = (kind) => LABELS[kind] ?? kind;
export const isDone = (kind) => !ACTIVE_KINDS.includes(kind);

export function glRun(pipeline) {
  const kind = glKind(pipeline.status);
  return {
    id: pipeline.id, number: pipeline.iid ?? pipeline.id, title: pipeline.name || pipeline.commit?.title || null,
    ref: pipeline.ref, sha: pipeline.sha, kind, label: labelOf(kind), created: pipeline.created_at,
    started: pipeline.started_at ?? null, finished: pipeline.finished_at ?? null, url: pipeline.web_url,
    event: pipeline.source ?? null, actor: pipeline.user?.username ?? null, workflow: null,
  };
}

export function glJob(job) {
  const kind = glKind(job.status, job.allow_failure);
  return {
    id: job.id, name: job.name, stage: job.stage ?? DEFAULT_STAGE, kind, label: labelOf(kind),
    started: job.started_at ?? null, finished: job.finished_at ?? null, seconds: job.duration ?? null, url: job.web_url,
    artifacts: (job.artifacts ?? []).some((artifact) => artifact.file_type === "archive"),
  };
}

export function ghRun(run) {
  const kind = ghKind(run.status, run.conclusion);
  return {
    id: run.id, number: run.run_number, title: run.display_title ?? run.name, ref: run.head_branch, sha: run.head_sha,
    kind, label: labelOf(kind), created: run.created_at, started: run.run_started_at ?? null,
    finished: isDone(kind) ? run.updated_at : null, url: run.html_url, event: run.event, actor: run.actor?.login ?? null,
    workflow: run.name,
  };
}

export function ghJob(job) {
  const kind = ghKind(job.status, job.conclusion);
  const startedMs = job.started_at ? Date.parse(job.started_at) : null;
  const finishedMs = job.completed_at ? Date.parse(job.completed_at) : null;
  return {
    id: job.id, name: job.name, stage: job.workflow_name ?? DEFAULT_STAGE, kind, label: labelOf(kind),
    started: job.started_at ?? null, finished: job.completed_at ?? null,
    seconds: startedMs && finishedMs ? (finishedMs - startedMs) / MS_PER_SECOND : null, url: job.html_url, artifacts: false,
  };
}

// Jobs grouped by stage, in first-seen stage order (GitLab returns newest first, so reverse).
export function byStage(jobs) {
  const stages = new Map();
  for (const job of jobs) {
    if (!stages.has(job.stage)) {
      stages.set(job.stage, []);
    }
    stages.get(job.stage).push(job);
  }
  return [...stages].map(([stage, stageJobs]) => ({ stage, jobs: stageJobs }));
}

export function duration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return "";
  }
  const totalSeconds = Math.round(seconds);
  if (totalSeconds < SECONDS_PER_MINUTE) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) {
    return `${minutes}m ${totalSeconds % SECONDS_PER_MINUTE}s`;
  }
  return `${Math.floor(minutes / MINUTES_PER_HOUR)}h ${minutes % MINUTES_PER_HOUR}m`;
}

export function since(iso, now = Date.now()) {
  if (!iso) {
    return "";
  }
  const elapsed = Math.max(0, (now - Date.parse(iso)) / MS_PER_SECOND);
  const unit = SINCE_UNITS.find(([, size]) => elapsed >= size);
  return unit ? `${Math.floor(elapsed / unit[1])}${unit[0]} ago` : "just now";
}

function unquote(value) {
  const text = String(value ?? "").trim();
  const quoted = (text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"));
  return quoted ? text.slice(1, -1) : text;
}

function topLevelVariable(key, rawValue) {
  const value = rawValue && !rawValue.startsWith("#") ? unquote(rawValue.replace(TRAILING_COMMENT, "")) : "";
  return { key, value, description: null, options: null };
}

function readVariableField(variable, field, rawValue) {
  const value = rawValue.replace(TRAILING_COMMENT, "");
  if (field === "value") {
    variable.value = unquote(value);
  } else if (field === "description") {
    variable.description = unquote(value);
  } else if (field === "options") {
    variable.options = value.replace(/^\[|\]$/g, "").split(",").map(unquote).filter(Boolean);
  }
}

// Top-level `variables:` of a .gitlab-ci.yml: [{ key, value, description, options }].
// Enough YAML for that block: `KEY: value`, or `KEY:` with value/description/options under it.
export function gitlabVariables(yaml) {
  const lines = String(yaml ?? "").replace(/\r/g, "").split("\n");
  const start = lines.findIndex((line) => /^variables:\s*(#.*)?$/.test(line));
  if (start < 0) {
    return [];
  }
  const variables = [];
  let current = null;
  let indent = null;
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || /^\s*#/.test(line)) {
      continue;
    }
    const lead = line.length - line.trimStart().length;
    if (lead === 0) {
      break;
    }
    indent ??= lead;
    const match = VARIABLE_LINE.exec(line);
    if (!match) {
      continue;
    }
    if (lead === indent) {
      current = topLevelVariable(match[1], match[2]);
      variables.push(current);
    } else if (current && lead > indent) {
      readVariableField(current, match[1], match[2]);
    }
  }
  return variables;
}
