import { test } from "node:test";
import assert from "node:assert/strict";
import { displayTitle, isTerminalTab, editorTabs, fallbackTab, leadTerminal, panelTerminals, pickShown } from "../shared/terminal-core.js";

const SPACE_LABEL = "herdr-vscode.space";
const spaces = [
  { id: "s1", tabs: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "w" }] },
  { id: "s2", tabs: [{ id: "d" }] },
];
const panes = [
  { pane: "p1", tab: "a", terminal: "t1", title: "OC | fix the build", program: { name: "opencode", agent: true }, cwd: "/r" },
  { pane: "p2", tab: "b", terminal: null, mod: "herdr-vscode-files" },
  { pane: "p3", tab: "c", terminal: "t3", title: "Current Folder: ~/r", program: { name: "zsh", shell: true } },
  { pane: "p4", tab: "c", terminal: "t4", title: "vim", program: { name: "vim" }, focused: true },
  { pane: "p5", tab: "w", terminal: null, mod: "herdr-vscode-empty" },
  { pane: "p6", tab: "d", terminal: "t6", title: "x", program: { name: "zsh" } },
  { pane: "p7", tab: "b", terminal: "t7", title: "zsh" },
];

test("displayTitle: drops harness prefixes, shell folder titles and the program name", () => {
  assert.equal(displayTitle("OC | fix the build", "opencode"), "fix the build");
  assert.equal(displayTitle("Current Folder: ~/x", "zsh"), "");
  assert.equal(displayTitle("zsh", "zsh"), "");
});

test("isTerminalTab: terminals and no mod pane", () => {
  assert.equal(isTerminalTab("a", panes), true);
  assert.equal(isTerminalTab("b", panes), false);
  assert.equal(isTerminalTab("w", panes), false);
  assert.equal(isTerminalTab("missing", panes), false);
});

test("editorTabs and fallbackTab: most recent editor tab, else the first, else none", () => {
  assert.deepEqual(editorTabs(spaces[0], panes).map((tab) => tab.id), ["b", "w"]);
  assert.equal(fallbackTab(spaces[0], panes, ["a", "w", "b"]), "w");
  assert.equal(fallbackTab(spaces[0], panes, []), "b");
  assert.equal(fallbackTab(spaces[1], panes, []), null);
});

test("leadTerminal: focused pane, else the agent, else the first", () => {
  assert.equal(leadTerminal("c", panes), "t4");
  assert.equal(leadTerminal("a", panes), "t1");
  assert.equal(leadTerminal("b", panes), "t7");
});

test("panelTerminals: terminal tabs of the space, then the panel's own shells in start order", () => {
  const owned = [
    { address: "t9", labels: { [SPACE_LABEL]: "s1" }, program: { name: "zsh" } },
    { address: "t8", labels: {} },
    { address: "t5", labels: { [SPACE_LABEL]: "s2" } },
  ];
  const list = panelTerminals({ spaces, panes, owned, order: ["t8", "t9"], scope: "space", spaceId: "s1", spaceLabel: SPACE_LABEL });
  assert.deepEqual(list.map((entry) => entry.address), ["t1", "t3", "t4", "t8", "t9"]);
  assert.equal(list[0].title, "fix the build");
  assert.equal(list[0].label, "opencode");
  assert.equal(list[0].tab, "a");
  assert.equal(list[3].owned, true);
  const all = panelTerminals({ spaces, panes, owned, order: [], scope: "all", spaceId: "s1", spaceLabel: SPACE_LABEL });
  assert.deepEqual(all.map((entry) => entry.address), ["t1", "t3", "t4", "t6", "t9", "t8", "t5"]);
  const off = panelTerminals({ spaces, panes, owned, order: ["t8", "t9"], spaceId: "s1", inPanel: false, spaceLabel: SPACE_LABEL });
  assert.deepEqual(off.map((entry) => entry.address), ["t8", "t9"]);
});

test("pickShown: keeps a listed terminal, else the last one", () => {
  const entries = [{ address: "t1" }, { address: "t2" }];
  assert.equal(pickShown("t1", entries), "t1");
  assert.equal(pickShown("gone", entries), "t2");
  assert.equal(pickShown("t1", []), null);
});
