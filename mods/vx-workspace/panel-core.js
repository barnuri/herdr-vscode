// The bottom panel's data: listening ports from lsof, workspace problems from what vx-workspace /
// vx-ci publish, and problems parsed from a repo's lint / typecheck output.

const TYPE_CHECK_SCRIPTS = ["typecheck", "type-check", "check-types", "types", "tsc"];
const LINT_SCRIPTS = ["lint:check", "lint"];
export const CHECK_SCRIPTS = [...TYPE_CHECK_SCRIPTS, ...LINT_SCRIPTS];

const ANSI_ESCAPE = /\x1b\[[0-9;]*[A-Za-z]/g;
const TSC_PAREN_LINE = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;
const TSC_PRETTY_LINE = /^(.+?):(\d+):(\d+) - (error|warning) (TS\d+): (.*)$/;
const ESLINT_FILE_LINE = /^(\/\S.*|[\w.@-][\w./@-]*\.\w+)$/;
const ESLINT_PROBLEM_LINE = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}(\S+))?\s*$/;
const LOCATION_LINE = /^([^\s:][^:]*):(\d+):(\d+):?\s+(?:(error|warning)\b:?\s*)?(.*)$/;

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

function addPort(ports, pid, command, address) {
  const match = /^(.*):(\d+)$/.exec(address);
  if (!match) {
    return;
  }
  const [, host, portText] = match;
  const port = Number(portText);
  const known = ports.get(port);
  if (!known) {
    ports.set(port, { port, pid, cmd: command, hosts: [host] });
    return;
  }
  if (!known.hosts.includes(host)) {
    known.hosts.push(host);
  }
}

// lsof -F pcn: p<pid> / c<command> / f<fd> / n<host:port> lines -> one entry per port.
export function parsePorts(text) {
  const ports = new Map();
  let pid = null;
  let command = null;
  for (const line of String(text ?? "").split("\n")) {
    const field = line[0];
    const value = line.slice(1);
    if (field === "p") {
      pid = Number(value);
    } else if (field === "c") {
      command = value;
    } else if (field === "n") {
      addPort(ports, pid, command, value);
    }
  }
  return [...ports.values()].sort((a, b) => a.port - b.port);
}

function rootProblems(root, status, lastRun) {
  const problems = [];
  const branch = status?.branch ?? "its branch";
  if (status?.error) {
    problems.push({ id: `err-${root.path}`, root, level: "error", text: status.error, view: "explorer" });
  }
  if (status?.conflicts) {
    problems.push({ id: `cf-${root.path}`, root, level: "error", text: `${plural(status.conflicts, "file")} with merge conflicts`, view: "scm" });
  }
  if (lastRun?.kind === "failure") {
    const number = lastRun.number ? ` #${lastRun.number}` : "";
    problems.push({ id: `ci-${root.path}`, root, level: "error", text: `Pipeline${number} failed on ${branch}`, view: "ci" });
  }
  if (status?.behind) {
    problems.push({ id: `bh-${root.path}`, root, level: "warning", text: `${plural(status.behind, "commit")} behind on ${branch}`, view: "scm" });
  }
  return problems;
}

// roots [{name, path}], git = shared("vx.git"), ci = shared("vx.ci.summary") -> problems.
export function workspaceProblems(roots, git = {}, ci = {}) {
  return (roots ?? []).flatMap((root) => rootProblems(root, git?.[root.path], ci?.[root.path]));
}

// The scripts worth running for problems, in order: type checks first, then linters.
export function pickChecks(scripts) {
  const names = new Set((scripts ?? []).map((script) => script.name));
  const typeCheck = TYPE_CHECK_SCRIPTS.find((name) => names.has(name));
  const lint = LINT_SCRIPTS.find((name) => names.has(name));
  return [typeCheck, lint].filter(Boolean);
}

const stripAnsi = (text) => text.replace(ANSI_ESCAPE, "");

function relativeTo(root, file) {
  const path = file.replace(/^\.\//, "");
  return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

// One output line -> { problem: [file, line, col, level, message, rule] } and the ESLint file
// that following indented lines belong to.
function readCheckLine(line, eslintFile) {
  let match = TSC_PAREN_LINE.exec(line) ?? TSC_PRETTY_LINE.exec(line);
  if (match) {
    return { problem: [match[1], match[2], match[3], match[4], match[6], match[5]], eslintFile: null };
  }
  const trimmed = line.trim();
  match = ESLINT_FILE_LINE.exec(trimmed);
  if (match && !/\s/.test(trimmed)) {
    return { problem: null, eslintFile: match[1] };
  }
  match = eslintFile ? ESLINT_PROBLEM_LINE.exec(line) : null;
  if (match) {
    return { problem: [eslintFile, match[1], match[2], match[3], match[4], match[5] ?? ""], eslintFile };
  }
  match = LOCATION_LINE.exec(line);
  if (match && /\.\w+$/.test(match[1])) {
    return { problem: [match[1], match[2], match[3], match[4] ?? "error", match[5]], eslintFile: null };
  }
  return { problem: null, eslintFile: trimmed ? eslintFile : null };
}

// Problems in a check's output, for the files under `dir` (the script's folder) of a repo at
// `root`. -> [{ rel, line, col, level: "error" | "warning", message, rule }]
export function parseCheckOutput(text, { root, dir = root } = {}) {
  const problems = [];
  const seen = new Set();
  const add = (file, line, col, level, message, rule = "") => {
    const absolute = (file.startsWith("/") ? file : `${dir}/${file.replace(/^\.\//, "")}`).replace(/\/\.\//g, "/");
    const rel = relativeTo(root, absolute);
    const key = `${rel}:${line}:${col}:${message}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    problems.push({ rel, line: Number(line), col: Number(col) || 1, level, message: message.trim(), rule });
  };
  let eslintFile = null;
  for (const raw of String(text ?? "").split("\n")) {
    const result = readCheckLine(stripAnsi(raw).replace(/\r$/, ""), eslintFile);
    eslintFile = result.eslintFile;
    if (result.problem) {
      add(...result.problem);
    }
  }
  return problems;
}

// Errors and warnings across workspace problems and check results (vx.checks).
export function countProblems(list, checks = {}) {
  const levels = [
    ...(list ?? []).map((problem) => problem.level),
    ...Object.values(checks ?? {}).flatMap((check) => (check?.items ?? []).map((item) => item.level)),
  ];
  const errors = levels.filter((level) => level === "error").length;
  return { errors, warnings: levels.length - errors };
}
