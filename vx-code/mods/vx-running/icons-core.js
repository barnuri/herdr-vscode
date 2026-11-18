// vscode-icons picks by VS Code's rules: names match case-insensitively; a path rule beats a name,
// a name beats an extension, the longest extension wins.

export const ICON_DIR = "mods/vx-icons/icons";

const PATH_RULE_DEPTH = 3;
const LUMA_WEIGHTS = [0.299, 0.587, 0.114];
const HEX_CHANNEL_OFFSETS = [0, 2, 4];
const LIGHT_LUMA_THRESHOLD = 128;
const HEX_RADIX = 16;

const strip = (name) => name.replace(/^__(.+)__$/, "$1").replace(/^[._-]/, "");

function pathRuleId(parts, find) {
  for (let i = Math.max(0, parts.length - PATH_RULE_DEPTH); i < parts.length - 1; i++) {
    const id = find(parts.slice(i).join("/"));
    if (id) {
      return id;
    }
  }
  return undefined;
}

function extensionId(name, get) {
  for (let dot = name.indexOf("."); dot !== -1; dot = name.indexOf(".", dot + 1)) {
    const id = get("fileExtensions", name.slice(dot + 1));
    if (id) {
      return id;
    }
  }
  return undefined;
}

export function iconFor(table, path, { dir = false, open = false, light = false } = {}) {
  if (!table) {
    return null;
  }
  const get = (kind, key) => (light ? table.light?.[kind]?.[key] : undefined) ?? table[kind]?.[key];
  const parts = String(path).toLowerCase().split("/").filter(Boolean);
  const name = parts.at(-1) ?? "";
  const kind = dir ? (open ? "folderNamesExpanded" : "folderNames") : "fileNames";
  const find = (key) => get(kind, key) ?? (dir ? get(kind, strip(key)) : undefined);
  const pathId = pathRuleId(parts, find);
  if (dir) {
    const fallback = open ? (light ? table.light?.folderOpen : undefined) ?? table.folderOpen : (light ? table.light?.folder : undefined) ?? table.folder;
    return `${ICON_DIR}/${pathId ?? find(name) ?? fallback}.svg`;
  }
  const id = pathId ?? get(kind, name) ?? extensionId(name, get);
  return `${ICON_DIR}/${id ?? table.file}.svg`;
}

// Herdr's theme() has no light flag: a theme is light when its background is.
export function isLight(hex) {
  const match = /^#([0-9a-f]{6})/i.exec(hex ?? "");
  if (!match) {
    return false;
  }
  const channels = HEX_CHANNEL_OFFSETS.map((offset) => parseInt(match[1].slice(offset, offset + 2), HEX_RADIX));
  return channels.reduce((luma, channel, index) => luma + LUMA_WEIGHTS[index] * channel, 0) > LIGHT_LUMA_THRESHOLD;
}
