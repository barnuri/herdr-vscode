// VS Code's tree layout (abstractTree): an 8px start, `indent` px per level, a 16px twistie
// (reserved for files too), then the icon and the label. Indent guides are 1px lines centred
// under each ancestor's twistie.
export const TREE_START_PX = 8;
export const TWISTIE_PX = 16;
export const TWISTIE_GAP_PX = 2;
export const DEFAULT_INDENT = 16;
export const MIN_INDENT = 0;
export const MAX_INDENT = 40;
export const GUIDES_ALWAYS = "always";
export const GUIDES_ON_HOVER = "onHover";
export const GUIDES_NONE = "none";
const GUIDE_MODES = [GUIDES_ALWAYS, GUIDES_ON_HOVER, GUIDES_NONE];

export function clampIndent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return DEFAULT_INDENT;
  }
  return Math.min(MAX_INDENT, Math.max(MIN_INDENT, Math.round(number)));
}

export const guideMode = (value) => (GUIDE_MODES.includes(value) ? value : GUIDES_ALWAYS);

// Left padding of a row at `depth` (0 = top level).
export const rowPadding = (depth, indent) => TREE_START_PX + depth * indent;

// x of the guide for ancestor `level` (0-based): the centre of that ancestor's twistie.
export const guideX = (level, indent) => TREE_START_PX + level * indent + TWISTIE_PX / 2;

// The levels that draw a guide in a row at `depth`, from `firstLevel` on.
export function guideLevels(depth, firstLevel = 0) {
  const levels = [];
  for (let level = Math.max(0, firstLevel); level < depth; level++) {
    levels.push(level);
  }
  return levels;
}

// The guide level that is bright for a row: the level of the selected folder when the row is
// inside it, else null.
export function activeGuideLevel(rowPath, selectedDir, selectedDepth) {
  if (!selectedDir || typeof rowPath !== "string" || !rowPath.startsWith(`${selectedDir}/`)) {
    return null;
  }
  return selectedDepth;
}
