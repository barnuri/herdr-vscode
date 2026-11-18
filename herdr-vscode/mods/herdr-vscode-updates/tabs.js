// One reusable centre tab per space for a mod's viewer (a file preview, a diff): opening again only
// updates shared(`${mod}.view`)[spaceId], renames the tab and selects it, so browsing never piles up tabs.
import { panes, spaces, run, shared, setShared } from "herdr";

const PENDING_MS = 2000;
const MAX_RECENT_FILES = 50;
const KEPT_TABS_KEY = "herdr-vscode.tabs.kept";
const RECENT_FILES_KEY = "herdr-vscode.goto.recent";
const FILES_MOD = "herdr-vscode-files";
const PREVIEW_MODS = [FILES_MOD, "herdr-vscode-changes"];

const viewKey = (mod) => `${mod}.view`;

// Tabs you kept (double-click a preview in herdr-vscode-tabs) hold their own file and are never reused.
// shared("herdr-vscode.tabs.kept") = { [tabId]: { mod, value } }.
export const keptTabs = () => shared(KEPT_TABS_KEY) ?? {};

export function viewerTab(mod, spaceId) {
  const space = spaces().find((candidate) => candidate.id === spaceId);
  const tabIds = new Set((space?.tabs ?? []).map((tab) => tab.id));
  const kept = keptTabs();
  return panes().find((pane) => pane.mod === mod && tabIds.has(pane.tab) && !kept[pane.tab])?.tab ?? null;
}

export const isPreviewTab = (tabId, mod) => PREVIEW_MODS.includes(mod) && !keptTabs()[tabId];

// Quick Open's "recently opened": every local file previewed, from anywhere.
function rememberRecentFile(value) {
  const rest = (shared(RECENT_FILES_KEY) ?? []).filter((recent) => !(recent?.root?.path === value.root && recent.rel === value.rel));
  const entry = { root: { name: value.root.split("/").pop(), path: value.root }, rel: value.rel };
  setShared(RECENT_FILES_KEY, [entry, ...rest].slice(0, MAX_RECENT_FILES));
}

export function showInViewer(mod, value, name) {
  const space = spaces().find((candidate) => candidate.active);
  if (!space) {
    return;
  }
  if (mod === FILES_MOD && value?.root && value.rel && !value.on) {
    rememberRecentFile(value);
  }
  const key = viewKey(mod);
  const all = shared(key) ?? {};
  const previous = all[space.id];
  setShared(key, { ...all, [space.id]: { ...value, at: Date.now(), opening: previous?.opening ?? 0 } });
  const tab = viewerTab(mod, space.id);
  if (tab) {
    run("tab.rename", { id: tab, name });
    run("tab.select", { id: tab });
    return;
  }
  // A tab asked for a moment ago may not be listed yet: don't open a second one.
  if (previous?.opening && Date.now() - previous.opening < PENDING_MS) {
    return;
  }
  const now = shared(key) ?? {};
  setShared(key, { ...now, [space.id]: { ...now[space.id], opening: Date.now() } });
  run("tab.new", { space: space.id, name, mod, props: { mode: "view", space: space.id } });
}

export const viewerValue = (mod, spaceId) => (shared(viewKey(mod)) ?? {})[spaceId] ?? null;
