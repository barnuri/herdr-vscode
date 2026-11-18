// Pure logic for tools/import-vscode-settings.mjs and tools/build-vscode-themes.mjs: VS Code
// settings to herdr-vscode settings.json, and VS Code color themes to Herdr themes.

// VS Code's defaults on macOS, for keys the user did not set.
export const VSCODE_DEFAULTS = {
  "editor.fontFamily": "Menlo, Monaco, 'Courier New', monospace",
  "editor.fontSize": 12,
  "editor.lineHeight": 0,
  "editor.fontLigatures": false,
  "editor.tabSize": 4,
  "editor.wordWrap": "off",
  "editor.renderWhitespace": "selection",
  "editor.cursorStyle": "line",
  "editor.cursorBlinking": "blink",
  "editor.minimap.enabled": true,
  "terminal.integrated.fontSize": 12,
  "terminal.integrated.lineHeight": 1,
  "workbench.editor.tabSizing": "fit",
  "workbench.editor.wrapTabs": false,
  "workbench.editor.enablePreview": true,
  "scm.defaultViewMode": "list",
  "diffEditor.renderSideBySide": true,
  "files.autoSave": "off",
};

// VS Code's lineHeight: 0 is automatic (about 1.5 × the font size), below 8 a multiple, else px.
export function lineHeightRatio(lineHeight, fontSize) {
  const height = Number(lineHeight) || 0;
  if (height <= 0) {
    return 1.5;
  }
  if (height < 8) {
    return height;
  }
  return Math.round((height / (Number(fontSize) || 12)) * 100) / 100;
}

// The first family in a CSS font list, without quotes: what Herdr and gpui can use.
export function firstFont(list) {
  const first = String(list ?? "").split(",")[0]?.trim() ?? "";
  return first.replace(/^['"]|['"]$/g, "");
}

const pick = (settings, key) => (settings?.[key] !== undefined ? settings[key] : VSCODE_DEFAULTS[key]);

// The herdr-vscode settings.json sections that come from VS Code. Only keys the user set win over
// our own defaults for tree indent and guides (VS Code's 8 px reads as barely indented here).
export function mapVscodeSettings(settings) {
  const editorFontSize = Number(pick(settings, "editor.fontSize")) || 12;
  const out = {
    editor: {
      fontFamily: firstFont(pick(settings, "editor.fontFamily")),
      fontSize: editorFontSize,
      lineHeight: lineHeightRatio(pick(settings, "editor.lineHeight"), editorFontSize),
      fontLigatures: Boolean(pick(settings, "editor.fontLigatures")),
      tabSize: Number(pick(settings, "editor.tabSize")) || 4,
      wordWrap: pick(settings, "editor.wordWrap") !== "off",
      renderWhitespace: String(pick(settings, "editor.renderWhitespace")),
      cursorStyle: String(pick(settings, "editor.cursorStyle")),
      cursorBlink: pick(settings, "editor.cursorBlinking") !== "solid",
      minimap: pick(settings, "editor.minimap.enabled") !== false,
    },
    tabs: {
      sizing: String(pick(settings, "workbench.editor.tabSizing")),
      wrap: Boolean(pick(settings, "workbench.editor.wrapTabs")),
      preview: pick(settings, "workbench.editor.enablePreview") !== false,
    },
    scm: {
      view: pick(settings, "scm.defaultViewMode") === "tree" ? "tree" : "flat",
      diffLayout: pick(settings, "diffEditor.renderSideBySide") === false ? "inline" : "split",
    },
    files: { autoSave: pick(settings, "files.autoSave") === "off" ? "off" : "afterDelay" },
    explorer: {},
  };
  if (settings?.["workbench.tree.indent"] !== undefined) {
    out.explorer.indent = Number(settings["workbench.tree.indent"]);
  }
  if (settings?.["workbench.tree.renderIndentGuides"] !== undefined) {
    out.explorer.indentGuides = settings["workbench.tree.renderIndentGuides"];
  }
  return out;
}

// Herdr's own settings.json keys for terminals (app-wide: Herdr has no per-mod terminal font).
export function herdrTerminalSettings(settings) {
  const out = {};
  const family = settings?.["terminal.integrated.fontFamily"] ?? settings?.["editor.fontFamily"];
  if (family) {
    out.font = firstFont(family);
  }
  if (settings?.["terminal.integrated.fontSize"] !== undefined) {
    out.font_size = Number(settings["terminal.integrated.fontSize"]);
  }
  if (settings?.["terminal.integrated.lineHeight"] !== undefined) {
    out.terminal_line_height = Math.min(2, Math.max(0.8, Number(settings["terminal.integrated.lineHeight"])));
  }
  if (settings?.["editor.fontLigatures"] !== undefined) {
    out.font_ligatures = Boolean(settings["editor.fontLigatures"]);
  }
  return out;
}

// Keys whose names suggest a secret: never copied, logged or printed.
export const isSecretKey = (key) => /token|secret|password|apikey|api[_-]?key|credential|auth/i.test(key);

// Themes ------------------------------------------------------------------------------------

const HEX = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i;

// A #rrggbbaa color blended over `under` (#rrggbb): Herdr theme files take #rrggbb.
export function flatten(color, under) {
  const match = HEX.exec(color ?? "");
  if (!match) {
    return null;
  }
  if (!match[2]) {
    return `#${match[1].toLowerCase()}`;
  }
  const base = HEX.exec(under ?? "#000000")?.[1] ?? "000000";
  const alpha = parseInt(match[2], 16) / 255;
  const mix = (i) => {
    const top = parseInt(match[1].slice(i, i + 2), 16);
    const bottom = parseInt(base.slice(i, i + 2), 16);
    return Math.round(top * alpha + bottom * (1 - alpha)).toString(16).padStart(2, "0");
  };
  return `#${mix(0)}${mix(2)}${mix(4)}`;
}

// A theme and its `include` chain, as one { colors, tokenColors }: the including theme wins.
export function mergeThemeChain(chain) {
  const colors = {};
  const tokenColors = [];
  for (const theme of chain) {
    Object.assign(colors, theme.colors ?? {});
    tokenColors.push(...(theme.tokenColors ?? []));
  }
  return { colors, tokenColors };
}

// The foreground for a TextMate scope: the last rule naming it exactly, else the last rule
// naming its nearest parent scope ("keyword.control" falls back to "keyword").
export function scopeColor(tokenColors, scope) {
  for (let parts = scope.split("."); parts.length; parts.pop()) {
    const wanted = parts.join(".");
    let found = null;
    for (const rule of tokenColors) {
      const scopes = Array.isArray(rule.scope) ? rule.scope : String(rule.scope ?? "").split(",").map((part) => part.trim());
      if (scopes.includes(wanted) && rule.settings?.foreground) {
        found = rule.settings.foreground;
      }
    }
    if (found) {
      return found;
    }
  }
  return null;
}

// Our lexer's token kinds and the VS Code scopes they stand for.
export const SYNTAX_SCOPES = {
  comment: "comment", string: "string", number: "constant.numeric", keyword: "storage.type",
  type: "entity.name.type", fn: "entity.name.function",
  constant: "constant.language", key: "meta.object-literal.key", tag: "entity.name.tag",
};

export function syntaxFromTokens(tokenColors) {
  const out = {};
  for (const [kind, scope] of Object.entries(SYNTAX_SCOPES)) {
    const color = scopeColor(tokenColors, scope);
    if (color) {
      out[kind] = color.toLowerCase();
    }
  }
  return out;
}

// Registry defaults for workbench colors a theme file leaves out (VS Code's colorRegistry).
export const WORKBENCH_DEFAULTS = {
  dark: {
    "editor.background": "#1E1E1E", "editor.foreground": "#D4D4D4", "editor.selectionBackground": "#264F78",
    "sideBar.background": "#252526", "activityBar.background": "#333333", "editorWidget.background": "#252526",
    "list.hoverBackground": "#2A2D2E", "list.activeSelectionBackground": "#04395E", "input.background": "#3C3C3C",
    "input.border": "#3C3C3C", "descriptionForeground": "#CCCCCCB3", "editorLineNumber.foreground": "#858585",
    "focusBorder": "#007FD4", "button.background": "#0E639C", "button.foreground": "#FFFFFF", "panel.border": "#80808059",
  },
  light: {
    "editor.background": "#FFFFFF", "editor.foreground": "#000000", "editor.selectionBackground": "#ADD6FF",
    "sideBar.background": "#F3F3F3", "activityBar.background": "#2C2C2C", "editorWidget.background": "#F3F3F3",
    "list.hoverBackground": "#E8E8E8", "list.activeSelectionBackground": "#0060C0", "input.background": "#FFFFFF",
    "input.border": "#CECECE", "descriptionForeground": "#717171", "editorLineNumber.foreground": "#237893",
    "focusBorder": "#0090F1", "button.background": "#007ACC", "button.foreground": "#FFFFFF", "panel.border": "#80808059",
  },
};

// A Herdr theme (themes/<name>.json) from merged VS Code colors and the 16 terminal ANSI colors.
export function herdrTheme(colors, ansi, type) {
  const merged = { ...WORKBENCH_DEFAULTS[type], ...colors };
  const background = flatten(merged["editor.background"]);
  const chrome = flatten(merged["sideBar.background"], background);
  const at = (key, under = background) => flatten(merged[key], under);
  const first = (...keys) => keys.map((key) => at(key)).find(Boolean) ?? null;
  const foreground = first("terminal.foreground", "editor.foreground");
  const theme = {
    background,
    foreground,
    selection: first("terminal.selectionBackground", "editor.selectionBackground"),
    cursor: first("terminalCursor.foreground", "editorCursor.foreground") ?? foreground,
    ansi: ansi.map((color) => flatten(color, background)),
    colors: {
      canvas: first("titleBar.activeBackground", "activityBar.background") ?? chrome,
      chrome,
      surface: background,
      popover: first("menu.background", "editorWidget.background"),
      raised: first("input.background", "dropdown.background"),
      hover: at("list.hoverBackground", chrome),
      selected: at("list.activeSelectionBackground", chrome),
      border: first("sideBar.border", "panel.border", "editorGroup.border"),
      input: first("input.border", "dropdown.border"),
      muted: at("descriptionForeground", chrome),
      dim: first("editorLineNumber.foreground"),
      accent: first("focusBorder", "button.background"),
      accent_foreground: first("button.foreground"),
      solid: first("button.background"),
      solid_foreground: first("button.foreground"),
    },
  };
  for (const [key, value] of Object.entries(theme.colors)) {
    if (!value) {
      delete theme.colors[key];
    }
  }
  return theme;
}

// VS Code's terminal ANSI defaults from its bundle: "terminal.ansiBlack":{index:0,defaults:{light:"#..",dark:"#.."
export function parseAnsiDefaults(bundleText) {
  const out = { dark: [], light: [] };
  const pattern = /"terminal\.ansi\w+":\{index:(\d+),defaults:\{light:"(#[0-9a-fA-F]{6})",dark:"(#[0-9a-fA-F]{6})"/g;
  for (const match of bundleText.matchAll(pattern)) {
    const index = Number(match[1]);
    out.light[index] = match[2].toLowerCase();
    out.dark[index] = match[3].toLowerCase();
  }
  const complete = (list) => list.length === 16 && list.every(Boolean);
  return complete(out.dark) && complete(out.light) ? out : null;
}
