// One reusable centre tab per space for a mod's viewer (a file preview, a diff).
// What it shows lives in shared(`${mod}.view`)[spaceId]; the tab is a pane of the same mod opened
// with props { mode: "view", space }. Opening again only updates the shared value, renames the
// tab and selects it, so browsing never piles up tabs.
import { panes, spaces, run, shared, setShared } from "herdr";

const PENDING_MS = 2000;

export function viewerTab(mod, spaceId) {
  const space = spaces().find((s) => s.id === spaceId);
  const ids = new Set((space?.tabs ?? []).map((t) => t.id));
  return panes().find((p) => p.mod === mod && ids.has(p.tab))?.tab ?? null;
}

export function showInViewer(mod, value, name) {
  const space = spaces().find((s) => s.active);
  if (!space) return;
  const key = `${mod}.view`;
  const all = shared(key) ?? {};
  const prev = all[space.id];
  setShared(key, { ...all, [space.id]: { ...value, at: Date.now(), opening: prev?.opening ?? 0 } });
  const tab = viewerTab(mod, space.id);
  if (tab) {
    run("tab.rename", { id: tab, name });
    run("tab.select", { id: tab });
    return;
  }
  // A tab asked for a moment ago may not be listed yet: don't open a second one.
  if (prev?.opening && Date.now() - prev.opening < PENDING_MS) return;
  const now = shared(key) ?? {};
  setShared(key, { ...now, [space.id]: { ...now[space.id], opening: Date.now() } });
  run("tab.new", { space: space.id, name, mod, props: { mode: "view", space: space.id } });
}

export const viewerValue = (mod, spaceId) => (shared(`${mod}.view`) ?? {})[spaceId] ?? null;
