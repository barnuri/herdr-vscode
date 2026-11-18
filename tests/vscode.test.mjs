import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseJsonc } from "../shared/jsonc.js";
import { mapVscodeSettings, herdrTerminalSettings, lineHeightRatio, firstFont, flatten, scopeColor, mergeThemeChain, herdrTheme, parseAnsiDefaults, isSecretKey } from "../tools/vscode-core.mjs";

const fixture = parseJsonc(fs.readFileSync(new URL("./fixtures/vscode-settings.jsonc", import.meta.url), "utf8"));

test("mapVscodeSettings: the fixture's choices, VS Code defaults for the rest", () => {
  const out = mapVscodeSettings(fixture);
  assert.equal(out.editor.fontFamily, "Fira Code");
  assert.equal(out.editor.fontSize, 14);
  assert.equal(out.editor.lineHeight, 1.5);
  assert.equal(out.editor.tabSize, 2);
  assert.equal(out.editor.minimap, false);
  assert.equal(out.editor.wordWrap, false);
  assert.equal(out.scm.view, "tree");
  assert.equal(out.scm.diffLayout, "inline");
  assert.equal(out.files.autoSave, "afterDelay");
  assert.deepEqual(out.explorer, { indent: 20 });
});

test("mapVscodeSettings: nothing set gives VS Code's defaults and leaves our tree indent alone", () => {
  const out = mapVscodeSettings({});
  assert.equal(out.editor.fontFamily, "Menlo");
  assert.equal(out.editor.fontSize, 12);
  assert.equal(out.scm.view, "flat");
  assert.equal(out.scm.diffLayout, "split");
  assert.equal(out.files.autoSave, "off");
  assert.deepEqual(out.explorer, {});
});

test("mapVscodeSettings: never copies a secret", () => {
  assert.doesNotMatch(JSON.stringify(mapVscodeSettings(fixture)), /not-a-real-token/);
  assert.ok(isSecretKey("github.copilot.token"));
  assert.ok(!isSecretKey("editor.fontSize"));
});

test("herdrTerminalSettings: terminal font, clamped line height", () => {
  assert.deepEqual(herdrTerminalSettings(fixture), { font: "Example Mono Nerd Font", terminal_line_height: 2 });
});

test("lineHeightRatio and firstFont follow VS Code's rules", () => {
  assert.equal(lineHeightRatio(0, 12), 1.5);
  assert.equal(lineHeightRatio(1.8, 12), 1.8);
  assert.equal(lineHeightRatio(18, 12), 1.5);
  assert.equal(firstFont('"JetBrainsMono Nerd Font", monospace'), "JetBrainsMono Nerd Font");
});

test("flatten: blends #rrggbbaa over the background", () => {
  assert.equal(flatten("#FFFFFF80", "#000000"), "#808080");
  assert.equal(flatten("#ABCDEF"), "#abcdef");
  assert.equal(flatten("red"), null);
});

test("scopeColor: last exact rule wins, else the nearest parent scope", () => {
  const rules = [
    { scope: "keyword", settings: { foreground: "#111111" } },
    { scope: ["keyword.control", "x"], settings: { foreground: "#222222" } },
    { scope: "keyword.control", settings: { foreground: "#333333" } },
  ];
  assert.equal(scopeColor(rules, "keyword.control"), "#333333");
  assert.equal(scopeColor(rules, "keyword.operator"), "#111111");
  assert.equal(scopeColor(rules, "string"), null);
});

test("herdrTheme: maps workbench colors and fills registry defaults", () => {
  const { colors } = mergeThemeChain([{ colors: { "editor.background": "#101010" } }, { colors: { "button.background": "#0078D4", "sideBar.background": "#181818" } }]);
  const ansi = Array.from({ length: 16 }, () => "#123456");
  const theme = herdrTheme(colors, ansi, "dark");
  assert.equal(theme.background, "#101010");
  assert.equal(theme.colors.chrome, "#181818");
  assert.equal(theme.colors.solid, "#0078d4");
  assert.equal(theme.colors.selected, "#04395e");
  assert.equal(theme.ansi.length, 16);
});

test("parseAnsiDefaults: reads all 16 from a bundle snippet", () => {
  const names = ["Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White"];
  const all = [...names, ...names.map((name) => `Bright${name}`)];
  const text = all.map((name, index) => `"terminal.ansi${name}":{index:${index},defaults:{light:"#00000${index % 10}",dark:"#ffffff"`).join(",");
  const out = parseAnsiDefaults(text);
  assert.equal(out.dark.length, 16);
  assert.equal(out.light[3], "#000003");
  assert.equal(parseAnsiDefaults("nothing"), null);
});
