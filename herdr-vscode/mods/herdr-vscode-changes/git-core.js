// Every read: no optional index locks, no fsmonitor daemon, no index refresh, so a read never
// writes under .git (which would wake our own folder watch and loop).
export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
export const NO_HELPERS = ["--no-ext-diff", "--no-textconv", "--no-color"];

const CONFLICT_KINDS = {
  UU: "both edited", AA: "both added", DD: "both deleted",
  DU: "deleted by you", UD: "deleted incoming", AU: "added by you", UA: "added incoming",
};
const BRANCH_PREFIX = "## ";
const STATUS_PATH_OFFSET = 3;
const MIN_STATUS_RECORD = 4;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;
const RECORD_SEPARATOR = "\x1e";
const AGE_UNITS = [["y", 31536000], ["mo", 2592000], ["w", 604800], ["d", 86400], ["h", 3600], ["m", 60]];
const MS_PER_SECOND = 1000;

function applyBranchHeader(status, header) {
  if (header.startsWith("HEAD (no branch)")) {
    status.detached = true;
  }
  const fresh = /^(?:No commits yet on|Initial commit on) (\S+)/.exec(header);
  if (fresh) {
    status.noCommits = true;
    status.branch = fresh[1];
  } else if (!status.detached) {
    status.branch = /^(.+?)(?:\.\.\.|\s|$)/.exec(header)?.[1] ?? header;
  }
  status.upstream = /\.\.\.(\S+)/.exec(header)?.[1] ?? null;
  status.ahead = Number(/ahead (\d+)/.exec(header)?.[1] ?? 0);
  status.behind = Number(/behind (\d+)/.exec(header)?.[1] ?? 0);
}

// One letter for a row: A new, D gone, U conflict, M otherwise.
function markOf(indexState, worktreeState, untracked, conflict) {
  if (conflict) {
    return "U";
  }
  if (untracked || indexState === "A") {
    return "A";
  }
  if (indexState === "D" || worktreeState === "D") {
    return "D";
  }
  return "M";
}

function fileFromRecord(record) {
  const indexState = record[0];
  const worktreeState = record[1];
  const states = indexState + worktreeState;
  const untracked = states === "??";
  const conflict = Object.hasOwn(CONFLICT_KINDS, states);
  return {
    path: record.slice(STATUS_PATH_OFFSET), x: indexState, y: worktreeState, untracked, conflict,
    conflictKind: conflict ? CONFLICT_KINDS[states] : null,
    staged: !untracked && !conflict && indexState !== " " && indexState !== "!",
    unstaged: untracked || conflict || worktreeState !== " ",
    mark: markOf(indexState, worktreeState, untracked, conflict),
  };
}

function countFile(status, file) {
  if (file.untracked) {
    status.untracked++;
  }
  if (file.conflict) {
    status.conflicts++;
  }
  if (file.staged) {
    status.staged++;
  }
  if (file.unstaged && !file.untracked && !file.conflict) {
    status.unstaged++;
  }
}

// `git status --porcelain=v1 -z -b --no-renames --untracked-files=all`.
export function parseStatus(stdout) {
  const status = {
    branch: null, detached: false, upstream: null, ahead: 0, behind: 0, noCommits: false,
    files: [], staged: 0, unstaged: 0, untracked: 0, conflicts: 0,
  };
  for (const record of String(stdout ?? "").split("\0")) {
    if (record.startsWith(BRANCH_PREFIX)) {
      applyBranchHeader(status, record.slice(BRANCH_PREFIX.length));
      continue;
    }
    if (record.length < MIN_STATUS_RECORD) {
      continue;
    }
    const file = fileFromRecord(record);
    status.files.push(file);
    countFile(status, file);
  }
  status.changed = status.files.length;
  return status;
}

// `git diff --numstat -z`: { path: {add, del, binary} }.
export function parseNumstat(stdout) {
  const stats = Object.create(null);
  for (const entry of String(stdout ?? "").split("\0")) {
    const [added, deleted, ...pathParts] = entry.split("\t");
    if (!pathParts.length) {
      continue;
    }
    stats[pathParts.join("\t")] = { add: Number(added) || 0, del: Number(deleted) || 0, binary: added === "-" };
  }
  return stats;
}

// A remote URL as { host, path } (path without .git), for https, ssh:// and scp-like forms.
export function parseRemote(url) {
  const text = String(url ?? "").trim();
  const urlForm = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(text);
  if (urlForm) {
    return { host: urlForm[1], path: urlForm[2] };
  }
  const scpForm = /^(?:[^@]+@)?([^:/]+):(.+?)(?:\.git)?\/?$/.exec(text);
  if (scpForm) {
    return { host: scpForm[1], path: scpForm[2].replace(/^\/+/, "") };
  }
  return null;
}

// The default branch from `git symbolic-ref --short refs/remotes/origin/HEAD` ("origin/master"), else null.
export function defaultBranchOf(symbolicRef) {
  const name = String(symbolicRef ?? "").trim().replace(/^origin\//, "");
  return name && name !== "HEAD" ? name : null;
}

export function providerOf(host) {
  if (/(^|\.)github\.com$/i.test(host ?? "")) {
    return "github";
  }
  return /gitlab/i.test(host ?? "") ? "gitlab" : null;
}

const hunkLength = (count) => (count === undefined ? 1 : Number(count));

function hunkKind(removed, added) {
  if (!added) {
    return "removed";
  }
  return removed ? "changed" : "added";
}

// `@@ -a,b +c,d @@` hunks of `git diff -U0` (or any -U), by line in the new file.
export function parseHunks(diff) {
  const hunks = [];
  let current = null;
  for (const text of String(diff ?? "").split("\n")) {
    const header = HUNK_HEADER.exec(text);
    if (header) {
      const gone = hunkLength(header[2]);
      const fresh = hunkLength(header[4]);
      current = { oldStart: Number(header[1]), newStart: Number(header[3]), gone, fresh, kind: hunkKind(gone, fresh), old: [] };
      hunks.push(current);
    } else if (current && text.startsWith("-")) {
      current.old.push(text.slice(1));
    }
  }
  return hunks;
}

// Unified diff lines -> rows with old/new line numbers ("@" hunk headers, "+", "-", " ").
export function diffRows(lines) {
  let oldLine = 0;
  let newLine = 0;
  const rows = [];
  for (const text of lines) {
    const header = DIFF_HUNK_HEADER.exec(text);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      rows.push({ kind: "@", text });
      continue;
    }
    const marker = text[0];
    if (marker === "+") {
      rows.push({ kind: "+", next: newLine++, text: text.slice(1) });
    } else if (marker === "-") {
      rows.push({ kind: "-", old: oldLine++, text: text.slice(1) });
    } else if (marker === " ") {
      rows.push({ kind: " ", old: oldLine++, next: newLine++, text: text.slice(1) });
    } else if (text && !text.startsWith("\\")) {
      rows.push({ kind: "", text });
    }
  }
  return rows;
}

// UTF-16 offset of the start of 1-based `line` in `text` (the end of the text past its last line).
export function lineStartOffset(text, line) {
  let offset = 0;
  for (let current = 1; current < line; current++) {
    const next = text.indexOf("\n", offset);
    if (next < 0) {
      return text.length;
    }
    offset = next + 1;
  }
  return offset;
}

// Side by side: removals and additions of one change paired by position.
export function splitRows(rows) {
  const out = [];
  let minus = [];
  let plus = [];
  const flush = () => {
    for (let i = 0; i < Math.max(minus.length, plus.length); i++) {
      out.push({ kind: "pair", left: minus[i] ?? null, right: plus[i] ?? null });
    }
    minus = [];
    plus = [];
  };
  for (const row of rows) {
    if (row.kind === "-") {
      minus.push(row);
    } else if (row.kind === "+") {
      plus.push(row);
    } else {
      flush();
      out.push(row.kind === " " ? { kind: "pair", left: row, right: row } : row);
    }
  }
  flush();
  return out;
}

export function splitRecords(stdout) {
  return String(stdout ?? "")
    .split(RECORD_SEPARATOR)
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.includes("\0"))
    .map((record) => record.split("\0"));
}

// Records split by \x1e and fields by \0: hash, short, author, unix time, subject.
export const LOG_FORMAT = "--format=%H%x00%h%x00%an%x00%at%x00%s%x1e";
export function parseLog(stdout) {
  return splitRecords(stdout).map(([hash, short, author, at, subject]) => ({ hash, short, author, at: Number(at), subject }));
}

export function ageLabel(seconds) {
  const unit = AGE_UNITS.find(([, size]) => seconds >= size);
  return unit ? `${Math.floor(seconds / unit[1])}${unit[0]}` : "now";
}

export function timeAgo(ms, now = Date.now()) {
  return ageLabel(Math.max(0, (now - ms) / MS_PER_SECOND));
}
