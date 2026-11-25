export const CARDS = {
  "herdr-vscode-workspace": ["herdr-vscode-workspace", "herdr-vscode-files"],
  "herdr-vscode-changes": ["herdr-vscode-changes", "herdr-vscode-graph"],
  "herdr-vscode-ci": ["herdr-vscode-ci"],
  "herdr-vscode-tabs": ["herdr-vscode-tabs", "herdr-vscode-scripts"],
  "herdr-vscode-status": ["herdr-vscode-status"],
  "herdr-vscode-icons": ["herdr-vscode-icons"],
  "herdr-vscode-running": ["herdr-vscode-running"],
  "herdr-vscode-projects": ["herdr-vscode-projects"],
};

export const LAYOUT_CARDS = {
  "herdr-vscode": {
    layout: "herdr-vscode",
    // These open at runtime (graph tabs, the herdr-vscode-updates extension), so the layout does not name them.
    extra: ["herdr-vscode-graph", "herdr-vscode-updates"],
    themes: ["one-monokai", "herdr-vscode-dark-plus", "herdr-vscode-dark-modern", "herdr-vscode-light-modern"],
    keys: {
      "layout:herdr-vscode": {
        "cmd-p": "herdr-vscode-titlebar.goto",
        "cmd-shift-o": "herdr-vscode-titlebar.symbols",
        "cmd-shift-f": "herdr-vscode-activity.search",
        "cmd-shift-e": "herdr-vscode-activity.explorer",
        "cmd-shift-g": "herdr-vscode-activity.scm",
        "cmd-shift-r": "herdr-vscode-activity.running",
        "cmd-j": "herdr-vscode-activity.panel",
        "ctrl-`": "herdr-vscode-activity.panel",
        "cmd-e": "herdr-vscode-tabs.switch",
        "cmd-\\": "pane.split:right",
        "cmd-s": "herdr-vscode-files.save",
        "cmd-f": "herdr-vscode-files.find",
        "cmd-alt-f": "herdr-vscode-files.replace",
        "cmd-w": "herdr-vscode-tabs.close",
      },
    },
  },
};

const VX_PREFIX = "herdr-vscode-";
const ICON_MOD = "herdr-vscode-icons";

// Every other herdr-vscode mod draws its icons from herdr-vscode-icons, so a layout always needs it.
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
