import { displayTitle } from "./terminal-core.js";

export { displayTitle };
const STATUS_RANK = { blocked: 5, working: 4, orch: 3.5, done: 3, idle: 2, unknown: 1 };
const ORCH_STATUS = "orch";
const ORCH_TTL_SECS = 120;
const ORCH_MAX_SUMMARY = 200;
const MS_PER_SECOND = 1000;
const LIVE_JOB = "live";
const IDLE_AGENT_STATUSES = new Set(["idle", "done"]);
const SHELL_STATUS = "shell";
const BUSY_STATUS = "running";

export const SORTS = ["opened", "status", "name"];
export const GROUPINGS = ["folder", "tree"];
// Keys shared with herdr-folders in ~/.local/state/herdr-folders/state.json, with their types.
const PREF_TYPES = {
  sort: "string", grouping: "string", spacing: "string", confirmKill: "boolean", collapsible: "boolean", collapsed: "object", cardBackgrounds: "boolean",
};

export const DEFAULT_PREFS = {
  sort: "opened", grouping: "folder", spacing: "comfortable", confirmKill: false, collapsible: true, collapsed: {}, cardBackgrounds: true,
};

export function pickPrefs(parsed) {
  const prefs = { ...DEFAULT_PREFS };
  if (!parsed || typeof parsed !== "object") {
    return prefs;
  }
  for (const [key, type] of Object.entries(PREF_TYPES)) {
    if (typeof parsed[key] === type && parsed[key] !== null) {
      prefs[key] = parsed[key];
    }
  }
  return prefs;
}

export const CLOSE_MODES = ["empty-folders", "idle-agents-and-empty-folders", "terminals", "all"];

function baseName(path) {
  return String(path).split("/").filter(Boolean).pop() ?? path;
}

function rank(status) {
  return STATUS_RANK[status] ?? 0;
}

export function rollupStatus(statuses) {
  let best = null;
  for (const status of statuses) {
    if (best === null || rank(status) > rank(best)) {
      best = status;
    }
  }
  return best;
}

function spaceIndex(spaces) {
  const byTab = new Map();
  for (const space of spaces) {
    for (const tab of space.tabs ?? []) {
      byTab.set(tab.id, { spaceId: space.id, spaceName: space.name, tabName: tab.name ?? "" });
    }
  }
  return byTab;
}

function terminalStatus(pane) {
  return pane.program?.shell === false ? BUSY_STATUS : SHELL_STATUS;
}

function rowOf(pane, place, orchOf) {
  const isAgent = pane.status !== null && pane.status !== undefined;
  const label = pane.program?.name ?? pane.app ?? "shell";
  const orchSummary = isAgent && IDLE_AGENT_STATUSES.has(pane.status) ? orchOf(pane) : null;
  return {
    pane: pane.pane,
    terminal: pane.terminal,
    tab: pane.tab,
    space: place?.spaceId ?? pane.space ?? null,
    spaceName: place?.spaceName ?? "",
    tabName: place?.tabName ?? "",
    kind: isAgent ? "agent" : "terminal",
    status: orchSummary ? ORCH_STATUS : isAgent ? pane.status : terminalStatus(pane),
    orchSummary,
    label,
    title: displayTitle(pane.title, label),
    program: pane.program ?? null,
    branch: pane.branch ?? null,
    cwd: pane.cwd,
    focused: Boolean(pane.focused),
  };
}

function summarize(folder) {
  const agentRows = folder.rows.filter((row) => row.kind === "agent");
  return {
    ...folder,
    status: rollupStatus(agentRows.map((row) => row.status)),
    agentCount: agentRows.length,
    terminalCount: folder.rows.length - agentRows.length,
    branch: folder.rows.find((row) => row.branch)?.branch ?? null,
    focused: folder.rows.some((row) => row.focused),
  };
}

// Groups terminal panes by their repo root (from `roots`, keyed by cwd) or else their cwd, in
// Herdr's order: spaces, then tabs, then panes, as they were opened.
// `orchOf(pane)` names the orch work an idle agent still runs (see orchLookup), else null.
export function groupRunning({ panes, spaces = [], roots = {}, orchOf = () => null }) {
  const places = spaceIndex(spaces);
  const folders = new Map();
  for (const pane of panes) {
    if (!pane.terminal || !pane.cwd) {
      continue;
    }
    const path = roots[pane.cwd] ?? pane.cwd;
    if (!folders.has(path)) {
      folders.set(path, { path, name: baseName(path), isRepo: Boolean(roots[pane.cwd]), rows: [] });
    }
    folders.get(path).rows.push(rowOf(pane, places.get(pane.tab), orchOf));
  }
  return [...folders.values()].map(summarize);
}

function agentsFirst(rows) {
  return [...rows].sort((left, right) => (left.kind === right.kind ? 0 : left.kind === "agent" ? -1 : 1));
}

function byName(left, right) {
  return left.name.localeCompare(right.name);
}

function byStatus(left, right) {
  return rank(right.status) - rank(left.status) || byName(left, right);
}

export function sortFolders(folders, mode = "opened") {
  if (mode === "opened" || !SORTS.includes(mode)) {
    return folders;
  }
  const order = mode === "status" ? byStatus : byName;
  return folders.map((folder) => ({ ...folder, rows: agentsFirst(folder.rows) })).sort(order);
}

const isIdleShell = (row) => row.kind === "terminal" && row.status === SHELL_STATUS;
const isIdleAgent = (row) => row.kind === "agent" && IDLE_AGENT_STATUSES.has(row.status) && !row.orchSummary;

const CLOSE_SELECTORS = {
  "empty-folders": (folders) => folders.filter((folder) => folder.rows.every(isIdleShell)).flatMap((folder) => folder.rows),
  "idle-agents-and-empty-folders": (folders) => folders.flatMap((folder) => {
    if (folder.rows.every((row) => isIdleShell(row) || isIdleAgent(row))) {
      return folder.rows;
    }
    return folder.rows.filter(isIdleAgent);
  }),
  terminals: (folders) => folders.flatMap((folder) => folder.rows.filter((row) => row.kind === "terminal")),
  all: (folders) => folders.flatMap((folder) => folder.rows),
};

export function planClose(folders, mode) {
  const select = CLOSE_SELECTORS[mode];
  if (!select) {
    throw new Error(`unknown close mode "${mode}" (use one of: ${CLOSE_MODES.join(", ")})`);
  }
  return select(folders);
}

function insertPath(root, folder) {
  let node = root;
  for (const segment of folder.path.split("/").filter(Boolean)) {
    if (!node.children.has(segment)) {
      node.children.set(segment, { segment, children: new Map(), folder: null });
    }
    node = node.children.get(segment);
  }
  node.folder = folder;
}

function onlyChild(node) {
  return node.children.size === 1 ? [...node.children.values()][0] : null;
}

function convertNode(node, prefix) {
  let name = node.segment;
  let current = node;
  let full = `${prefix}/${node.segment}`;
  for (let next = onlyChild(current); !current.folder && next && !next.folder; next = onlyChild(current)) {
    current = next;
    name = `${name}/${next.segment}`;
    full = `${full}/${next.segment}`;
  }
  const children = [...current.children.values()].map((child) => convertNode(child, full)).sort(byName);
  if (current.folder) {
    return { type: "folder", name: current.folder.name, path: full, folder: current.folder, children };
  }
  return { type: "dir", name, path: full, children };
}

// Nests folders by path. A directory with no panes and one child merges into it ("code/personal"),
// and the ancestors every folder shares are skipped.
export function buildTree(folders) {
  const root = { segment: "", children: new Map(), folder: null };
  for (const folder of folders) {
    insertPath(root, folder);
  }
  let top = root;
  let topPath = "";
  for (let next = onlyChild(top); !top.folder && next && !next.folder && next.children.size === 1; next = onlyChild(top)) {
    top = next;
    topPath = `${topPath}/${next.segment}`;
  }
  return [...top.children.values()].map((child) => convertNode(child, topPath)).sort(byName);
}

const GIT_MARKS = [["behind", "↓"], ["ahead", "↑"], ["added", "+"], ["untracked", "?"], ["modified", "±"], ["deleted", "-"], ["conflicts", "!"]];
const MODIFIED_STATES = new Set(["M", "T", "R", "C"]);

// Counts like the minimal-git prompt, from git-core's parseStatus (porcelain v1 -b).
export function gitCounts(status) {
  const counts = { branch: status.branch, behind: status.behind, ahead: status.ahead, added: 0, untracked: 0, modified: 0, deleted: 0, conflicts: 0 };
  for (const file of status.files) {
    if (file.untracked) {
      counts.untracked++;
    } else if (file.conflict) {
      counts.conflicts++;
    } else {
      counts.added += file.x === "A" ? 1 : 0;
      counts.modified += MODIFIED_STATES.has(file.x) || MODIFIED_STATES.has(file.y) ? 1 : 0;
      counts.deleted += file.x === "D" || file.y === "D" ? 1 : 0;
    }
  }
  return counts;
}

// "main ↓1 ↑2 +3 ?4 ±5 -6 !7", or "main =" when clean, like herdr-folders.
export function formatGitLine(counts) {
  const branch = counts.branch ?? "detached";
  const marks = GIT_MARKS.filter(([key]) => counts[key] > 0).map(([key, mark]) => `${mark}${counts[key]}`);
  return marks.length ? `${branch} ${marks.join(" ")}` : `${branch} =`;
}

function activeSummary(record, nowMs) {
  if (!record || typeof record !== "object" || record.active !== true || !Number.isFinite(record.updated_at)) {
    return null;
  }
  if (nowMs / MS_PER_SECOND - record.updated_at > ORCH_TTL_SECS) {
    return null;
  }
  const summary = typeof record.summary === "string" ? record.summary.trim().slice(0, ORCH_MAX_SUMMARY) : "";
  return summary || "orch running";
}

// ~/.harness-orch/activity/*.json, one record per line: pane id -> summary of active, fresh work.
export function parseActivity(text, nowMs) {
  const byPane = new Map();
  for (const line of String(text ?? "").split("\n")) {
    let record = null;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const summary = activeSummary(record, nowMs);
    if (summary && typeof record.pane === "string" && record.pane) {
      byPane.set(record.pane, summary);
    }
  }
  return byPane;
}

// `hc ls --json --all --label orch=1`: live job count per parent terminal.
export function parseOrchJobs(json) {
  let data = null;
  try {
    data = typeof json === "string" ? JSON.parse(json) : json;
  } catch {
    return new Map();
  }
  const byParent = new Map();
  for (const job of Array.isArray(data?.terminals) ? data.terminals : []) {
    if (job?.state === LIVE_JOB && typeof job.parent === "string") {
      byParent.set(job.parent, (byParent.get(job.parent) ?? 0) + 1);
    }
  }
  return byParent;
}

const bareAddress = (terminal) => String(terminal ?? "").split("/").pop();

// The orchOf for groupRunning: an activity record for the pane or terminal, else live child jobs.
export function orchLookup({ activity = new Map(), jobs = new Map() }) {
  return (pane) => {
    const terminal = bareAddress(pane.terminal);
    const own = activity.get(pane.pane) ?? activity.get(terminal);
    if (own) {
      return own;
    }
    const count = jobs.get(terminal) ?? 0;
    return count > 0 ? `${count} orch job${count === 1 ? "" : "s"} running` : null;
  };
}
