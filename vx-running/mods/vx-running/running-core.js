const STATUS_RANK = { blocked: 5, working: 4, done: 3, idle: 2, unknown: 1 };
const SHELL_STATUS = "shell";

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

function rowOf(pane, place) {
  const isAgent = pane.status !== null && pane.status !== undefined;
  return {
    pane: pane.pane,
    terminal: pane.terminal,
    tab: pane.tab,
    space: place?.spaceId ?? null,
    spaceName: place?.spaceName ?? "",
    tabName: place?.tabName ?? "",
    kind: isAgent ? "agent" : "terminal",
    status: isAgent ? pane.status : SHELL_STATUS,
    label: pane.program?.name ?? pane.app ?? "shell",
    title: pane.title ?? "",
    program: pane.program ?? null,
    branch: pane.branch ?? null,
    cwd: pane.cwd,
    focused: Boolean(pane.focused),
  };
}

function compareFolders(left, right) {
  const byStatus = rank(right.status) - rank(left.status);
  if (byStatus !== 0) {
    return byStatus;
  }
  return left.name.localeCompare(right.name);
}

// Groups terminal panes by their repo root (from `roots`, keyed by cwd) or else their cwd.
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
  return [...folders.values()]
    .map((folder) => {
      const agentRows = folder.rows.filter((row) => row.kind === "agent");
      return {
        ...folder,
        status: rollupStatus(agentRows.map((row) => row.status)),
        agentCount: agentRows.length,
        terminalCount: folder.rows.length - agentRows.length,
        branch: folder.rows.find((row) => row.branch)?.branch ?? null,
        focused: folder.rows.some((row) => row.focused),
      };
    })
    .sort(compareFolders);
}
