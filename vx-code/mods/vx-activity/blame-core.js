import { ageLabel } from "./git-core.js";

const BLAME_HEADER = /^([0-9a-f]{40}|[0-9a-f]{64}) (\d+) (\d+)(?: (\d+))?$/;
const MS_PER_SECOND = 1000;

function newCommitInfo(sha) {
  return { sha, author: "", time: 0, summary: "", boundary: false };
}

function readCommitField(info, text) {
  if (text.startsWith("author ")) {
    info.author = text.slice("author ".length);
  } else if (text.startsWith("author-time ")) {
    info.time = Number(text.slice("author-time ".length));
  } else if (text.startsWith("summary ")) {
    info.summary = text.slice("summary ".length);
  } else if (text === "boundary") {
    info.boundary = true;
  }
}

// `git blame --porcelain` -> [{ line, sha, author, time, summary, boundary }] by line (from 1).
export function parseBlame(stdout) {
  const commits = new Map();
  const entries = [];
  let current = null;
  for (const text of String(stdout ?? "").split("\n")) {
    const header = BLAME_HEADER.exec(text);
    if (header) {
      const sha = header[1];
      if (!commits.has(sha)) {
        commits.set(sha, newCommitInfo(sha));
      }
      current = { sha, line: Number(header[3]) };
      continue;
    }
    if (!current) {
      continue;
    }
    const info = commits.get(current.sha);
    if (text.startsWith("\t")) {
      entries.push({ line: current.line, ...info });
      current = null;
      continue;
    }
    readCommitField(info, text);
  }
  return entries.sort((a, b) => a.line - b.line);
}

export const NOT_COMMITTED = /^0+$/;

// 0 (oldest in the file) .. 1 (newest), by rank so one ancient line doesn't flatten the rest.
export function heat(entries) {
  const times = [...new Set(entries.map((entry) => entry.time))].sort((a, b) => a - b);
  const rank = new Map(times.map((time, index) => [time, times.length > 1 ? index / (times.length - 1) : 1]));
  return entries.map((entry) => (NOT_COMMITTED.test(entry.sha) ? 1 : rank.get(entry.time) ?? 0));
}

export function shortAge(unix, now = Date.now()) {
  return ageLabel(Math.max(0, now / MS_PER_SECOND - unix));
}
