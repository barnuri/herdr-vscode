// What a tab is, for drawing it: its kind, icon, label, a faint context (repo · branch, or the
// file's folder) and a repo colour.
import { svg, image } from "gpui-kit";
import { panes, theme } from "herdr";
import { workspace, rootFor, baseName } from "./ws.js";
import { viewerValue, keptTabs } from "./tabs.js";
import { colorSlot } from "./colors-core.js";
import { FileIcon, Icon } from "./ui.js";

const GRAPH_MOD = "vx-graph";
const CHANGES_MOD = "vx-changes";
const VIEWERS = new Set(["vx-files", CHANGES_MOD, GRAPH_MOD]);
const DEFAULT_ICON_SIZE = 14;

// A status glyph or "[ ! ]" prefix an agent puts in its title, dropped.
const cleanTitle = (title) => (title ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();

function isUsefulTitle(live, lead, programName) {
  const looksLikePath = /^[~/]/.test((lead.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  return Boolean(live) && live !== lead.terminal && live !== programName && !looksLikePath
    && !live.includes("@") && live.toLowerCase() !== lead.program.key;
}

// A tab nobody named follows its agent's live title; a name you gave stays.
function liveLabel(tab, lead) {
  const programName = lead?.program?.name;
  const base = tab.named ? tab.name : programName ?? "Terminal";
  if (!lead?.program?.agent) {
    return base;
  }
  const live = cleanTitle(lead.title);
  const followsAgent = tab.name === programName || !tab.named;
  return followsAgent && isUsefulTitle(live, lead, programName) ? live : base;
}

function viewerKind(mod) {
  if (mod === GRAPH_MOD) {
    return "graph";
  }
  return mod === CHANGES_MOD ? "diff" : "preview";
}

function viewerLabel(tab, rel) {
  if (tab.named) {
    return tab.name;
  }
  return rel ? baseName(rel) : tab.name;
}

function viewerContext(rel, root) {
  if (rel && rel.includes("/")) {
    return rel.slice(0, rel.lastIndexOf("/"));
  }
  return root ? baseName(root) : "";
}

function describeViewer(tab, spaceId, mod, kept) {
  const value = kept?.value ?? (mod === GRAPH_MOD ? null : viewerValue(mod, spaceId));
  const rel = value?.rel ?? value?.path ?? null;
  const root = value?.root ?? null;
  return {
    kind: viewerKind(mod),
    mod,
    preview: !kept && mod !== GRAPH_MOD,
    value,
    label: viewerLabel(tab, rel),
    context: viewerContext(rel, root),
    repo: root ? (rootFor(root, workspace()?.roots)?.name ?? baseName(root)) : null,
    file: rel,
  };
}

function terminalKind(lead) {
  if (lead?.program?.agent) {
    return "agent";
  }
  return lead?.terminal ? "terminal" : "mod";
}

export function describeTab(tab, spaceId) {
  const inTab = panes().filter((pane) => pane.tab === tab.id);
  const lead = inTab.find((pane) => pane.program?.agent) ?? inTab.find((pane) => pane.terminal) ?? inTab[0];
  const modPane = inTab.find((pane) => pane.mod && VIEWERS.has(pane.mod));
  if (modPane && !inTab.some((pane) => pane.terminal)) {
    return describeViewer(tab, spaceId, modPane.mod, keptTabs()[tab.id]);
  }
  const cwd = lead?.cwd ?? null;
  const root = cwd ? rootFor(cwd, workspace()?.roots) : null;
  const repo = root?.name ?? (cwd && lead?.branch ? baseName(cwd) : null);
  return {
    kind: terminalKind(lead),
    lead,
    label: liveLabel(tab, lead),
    context: [repo, lead?.branch].filter(Boolean).join(" · "),
    repo,
  };
}

export function tabIcon(description, icons, size = DEFAULT_ICON_SIZE) {
  const t = theme();
  if (description.kind === "preview" || description.kind === "diff") {
    return description.file ? FileIcon(icons, description.file, { size }) : Icon("file", size).text_color(t.muted);
  }
  if (description.kind === "graph") {
    return Icon("git-commit", size).text_color(t.accent);
  }
  const program = description.lead?.program;
  if (!program?.icon) {
    return Icon("terminal", size).text_color(t.muted);
  }
  return program.tint ? svg(program.icon).size(size).flex_none().text_color(t.muted) : image(program.icon).size(size).flex_none();
}

export const repoColor = (repo, t = theme()) => (repo ? t[colorSlot(repo)] ?? t.accent : null);
