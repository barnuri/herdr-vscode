// The bottom panel's terminal list when terminals live in the panel (terminal.inPanel): which
// tabs are terminal tabs (hidden from the editor tab bar), the terminals the panel lists, and
// the editor tab to show again when a terminal tab gets selected.

const TITLE_PREFIX = /^[A-Z]{1,4} \| /;
const SHELL_TITLE = /^Current Folder:/;

// Agent titles look like "OC | session title"; shells set "Current Folder: ~/x".
export function displayTitle(title, label) {
  const clean = String(title ?? "").trim().replace(TITLE_PREFIX, "");
  if (!clean || SHELL_TITLE.test(clean) || clean.toLowerCase() === String(label).toLowerCase()) {
    return "";
  }
  return clean;
}

// A tab with terminals and no mod pane. Mixed tabs (a terminal beside a file) stay editor tabs.
export function isTerminalTab(tabId, panes) {
  const inTab = (panes ?? []).filter((pane) => pane.tab === tabId);
  return inTab.some((pane) => pane.terminal) && !inTab.some((pane) => !pane.terminal);
}

export function editorTabs(space, panes) {
  return (space?.tabs ?? []).filter((tab) => !isTerminalTab(tab.id, panes));
}

// The editor tab to show in place of a terminal tab: the most recent one, else the first.
export function fallbackTab(space, panes, mru = []) {
  const editors = editorTabs(space, panes);
  const ids = new Set(editors.map((tab) => tab.id));
  return mru.find((id) => ids.has(id)) ?? editors[0]?.id ?? null;
}

// The terminal a selected terminal tab stands for: its focused pane, else its agent, else its first.
export function leadTerminal(tabId, panes) {
  const inTab = (panes ?? []).filter((pane) => pane.tab === tabId && pane.terminal);
  return (inTab.find((pane) => pane.focused) ?? inTab.find((pane) => pane.program?.agent) ?? inTab[0])?.terminal ?? null;
}

function entryOf(source, extra) {
  const label = source.program?.name ?? source.app ?? source.agent ?? "zsh";
  return {
    address: source.terminal ?? source.address,
    label,
    title: displayTitle(source.title, label),
    program: source.program ?? null,
    cwd: source.cwd ?? null,
    status: source.status ?? null,
    ...extra,
  };
}

// Every terminal the panel lists, in Herdr's order (spaces, tabs, panes), then the panel's own
// shells in the order they were started.
// spaces: spaces(); panes: panes(); owned: the panel's paneless shells (terminals() entries,
// `labels[spaceLabel]` names their space; none: every space); order: their addresses in start order;
// scope: "space" (spaceId's terminals) or "all"; inPanel false: only the panel's own shells.
export function panelTerminals({ spaces = [], panes = [], owned = [], order = [], scope = "space", spaceId = null, inPanel = true, spaceLabel = "" }) {
  const inScope = (id) => scope === "all" || !id || id === spaceId;
  const tabSpace = new Map(spaces.flatMap((space) => (space.tabs ?? []).map((tab) => [tab.id, space.id])));
  const fromTabs = inPanel
    ? panes.filter((pane) => pane.terminal && isTerminalTab(pane.tab, panes) && inScope(tabSpace.get(pane.tab)))
      .map((pane) => entryOf(pane, { tab: pane.tab, space: tabSpace.get(pane.tab) ?? null, owned: false }))
    : [];
  const rank = (address) => {
    const index = order.indexOf(address);
    return index < 0 ? order.length : index;
  };
  const own = owned.filter((terminal) => inScope(terminal.labels?.[spaceLabel]))
    .sort((a, b) => rank(a.address) - rank(b.address))
    .map((terminal) => entryOf(terminal, { tab: null, space: terminal.labels?.[spaceLabel] ?? null, owned: true }));
  return [...fromTabs, ...own];
}

// The terminal to keep showing: the current one while listed, else the last listed.
export function pickShown(current, entries) {
  return entries.some((entry) => entry.address === current) ? current : entries[entries.length - 1]?.address ?? null;
}
