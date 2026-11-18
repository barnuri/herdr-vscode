export const CARDS = {
  "vx-workspace": ["vx-workspace", "vx-files"],
  "vx-changes": ["vx-changes", "vx-graph"],
  "vx-ci": ["vx-ci"],
  "vx-tabs": ["vx-tabs", "vx-scripts"],
  "vx-status": ["vx-status"],
  "vx-icons": ["vx-icons"],
  "vx-running": ["vx-running"],
  "vx-projects": ["vx-projects"],
};

export const LAYOUT_CARDS = {
  "vx-code": {
    layout: "vx-code",
    // These open at runtime (graph tabs, the vx-updates extension), so the layout does not name them.
    extra: ["vx-graph", "vx-updates"],
    themes: ["one-monokai"],
    keys: {
      "layout:vx-code": {
        "cmd-p": "vx-titlebar.goto",
        "cmd-shift-o": "vx-titlebar.symbols",
        "cmd-shift-f": "vx-activity.search",
        "cmd-shift-e": "vx-activity.explorer",
        "cmd-shift-g": "vx-activity.scm",
        "cmd-shift-r": "vx-activity.running",
        "cmd-j": "vx-activity.panel",
        "ctrl-`": "vx-activity.panel",
        "cmd-e": "vx-tabs.switch",
        "cmd-\\": "pane.split:right",
        "cmd-s": "vx-files.save",
      },
    },
  },
};

const VX_PREFIX = "vx-";
const ICON_MOD = "vx-icons";

// Every other vx mod draws its icons from vx-icons, so a layout always needs it.
export function layoutMods(tree, extra = []) {
  const mods = new Set([ICON_MOD, ...extra]);
  const walk = (node) => {
    const mod = node?.content?.mod;
    if (mod && mod.startsWith(VX_PREFIX)) {
      mods.add(mod);
    }
    for (const child of node?.children ?? []) {
      walk(child);
    }
  };
  walk(tree);
  return [...mods].sort();
}
