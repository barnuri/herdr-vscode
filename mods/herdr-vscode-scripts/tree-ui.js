// Tree rows that look like VS Code's: indent and indent guides from settings.json
// (explorer.indent, explorer.indentGuides). Used by the Explorer, Files and Source Control trees.
import { div } from "gpui-kit";
import { getSetting } from "./settings.js";
import { tint } from "./ui.js";
import { clampIndent, guideMode, rowPadding, guideX, guideLevels, DEFAULT_INDENT, GUIDES_ALWAYS, GUIDES_NONE, GUIDES_ON_HOVER, TWISTIE_PX, TWISTIE_GAP_PX } from "./tree-core.js";

const FAINT_GUIDE_ALPHA = "38";
const BRIGHT_GUIDE_ALPHA = "90";

export const treeIndent = () => clampIndent(getSetting("explorer", "indent", DEFAULT_INDENT));
export const treeGuides = () => guideMode(getSetting("explorer", "indentGuides", GUIDES_ALWAYS));
export const treePadding = (depth) => rowPadding(depth, treeIndent());

// Applies the indent to a row (h_flex) and draws its guides. `hovered`: the tree has the mouse
// (for "onHover"); `activeLevel`: the guide level drawn brighter (the selected folder), or null.
export function withTreeIndent(row, t, { depth, height, firstLevel = 0, hovered = false, activeLevel = null }) {
  const indent = treeIndent();
  const mode = treeGuides();
  const show = mode !== GUIDES_NONE && (mode !== GUIDES_ON_HOVER || hovered);
  const out = row.relative().pl(rowPadding(depth, indent));
  if (!show || indent === 0) {
    return out;
  }
  const color = t.foreground ?? t.dim;
  return out.children(guideLevels(depth, firstLevel).map((level) => div().absolute().top(0).h(height).w(1)
    .left(guideX(level, indent))
    .bg(tint(color, level === activeLevel ? BRIGHT_GUIDE_ALPHA : FAINT_GUIDE_ALPHA))));
}

// The twistie slot: a chevron for a folder, the same empty width for a file.
export const twistieSlot = (chevron) => div().w(TWISTIE_PX).mr(TWISTIE_GAP_PX).flex_none().flex().items_center().justify_center().when(Boolean(chevron), (el) => el.child(chevron));
