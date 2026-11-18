const STATUS_RANK = { blocked: 5, working: 4, done: 3, idle: 2, unknown: 1 };
const IDLE_AGENT_STATUSES = new Set(["idle", "done"]);
const SHELL_STATUS = "shell";
const BUSY_STATUS = "running";
const TITLE_PREFIX = /^[A-Z]{1,4} \| /;
const SHELL_TITLE = /^Current Folder:/;

export const SORTS = ["opened", "status", "name"];
export const GROUPINGS = ["folder", "tree"];
// Keys shared with herdr-folders in ~/.local/state/herdr-folders/state.json, with their types.
const PREF_TYPES = { sort: "string", grouping: "string", spacing: "string", confirmKill: "boolean", collapsible: "boolean", collapsed: "object" };

export const DEFAULT_PREFS = { sort: "opened", grouping: "folder", spacing: "comfortable", confirmKill: false, collapsible: true, collapsed: {} };

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

// Agent titles look like "OC | session title"; shells set "Current Folder: ~/x".
export function displayTitle(title, label) {
  const clean = String(title ?? "").trim().replace(TITLE_PREFIX, "");
  if (!clean || SHELL_TITLE.test(clean) || clean.toLowerCase() === String(label).toLowerCase()) {
    return "";
  }
  return clean;
}

function terminalStatus(pane) {
  return pane.program?.shell === false ? BUSY_STATUS : SHELL_STATUS;
}

function rowOf(pane, place) {
  const isAgent = pane.status !== null && pane.status !== undefined;
  const label = pane.program?.name ?? pane.app ?? "shell";
  return {
    pane: pane.pane,
    terminal: pane.terminal,
    tab: pane.tab,
    space: place?.spaceId ?? null,
    spaceName: place?.spaceName ?? "",
    tabName: place?.tabName ?? "",
    kind: isAgent ? "agent" : "terminal",
    status: isAgent ? pane.status : terminalStatus(pane),
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
export function groupRunning({ panes, spaces = [], roots = {} }) {
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
    folders.get(path).rows.push(rowOf(pane, places.get(pane.tab)));
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
const isIdleAgent = (row) => row.kind === "agent" && IDLE_AGENT_STATUSES.has(row.status);

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
