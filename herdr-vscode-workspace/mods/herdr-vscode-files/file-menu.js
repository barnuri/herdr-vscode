// The right-click menu inside an open file. The popup copy only posts a command
// (shared "herdr-vscode.files.menuCmd"); the viewer that opened it runs it, since it owns the editor.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, closeOverlay, openOverlay, shared, setShared, exec } from "herdr";
import { TEXT, Icon } from "./ui.js";
import { fileWebLinks } from "./remote-url.js";
import { remoteLinkItems } from "./fileops-core.js";
import { logInfo, logError } from "./log.js";

const MOD = "herdr-vscode-files";
const COMMAND_KEY = "herdr-vscode.files.menuCmd";
const ITEM = 28;
const SEPARATOR_HEIGHT = 9;
const PADDING = 14;
const WIDTH = 250;
const ID_RADIX = 36;
const ID_SUFFIX_END = 7;
const HISTORY_FILE = "file";
const HISTORY_LINE = "line";
const COPY_SCRIPT = 'printf %s "$1" | pbcopy';

const newId = () => `${Date.now()}-${Math.random().toString(ID_RADIX).slice(2, ID_SUFFIX_END)}`;

// 1-based lines of the UTF-16 range [start, end) in text.
export function linesOfRange(text, range) {
  const lineAt = (offset) => text.slice(0, offset).split("\n").length;
  const start = lineAt(range.start);
  const end = range.end > range.start ? lineAt(Math.max(range.start, range.end - 1)) : start;
  return { start, end };
}

export const copyText = (text) => exec("sh", ["-c", COPY_SCRIPT, "herdr-vscode-copy", text]);

function menuItems(menu) {
  const items = [];
  if (menu.editing) {
    items.push(
      { id: "cut", icon: "minus", label: "Cut", cmd: "cut", off: !menu.selected },
      { id: "copy", icon: "copy", label: "Copy", cmd: "copy", off: !menu.selected },
      { id: "paste", icon: "download", label: "Paste", cmd: "paste" },
      { id: "all", icon: "check", label: "Select All", cmd: "selectAll" },
      { sep: true, id: "s1" },
    );
  }
  items.push(...remoteLinkItems(menu.links).map((item) => ({
    id: item.id,
    icon: item.kind === "open" ? "external" : "copy",
    label: item.label,
    cmd: item.kind === "open" ? "remoteOpen" : "remoteCopy",
    link: item.url,
  })));
  if (menu.git) {
    items.push(
      { id: "file-history", icon: "history", label: "Git: View File History", cmd: "fileHistory" },
      { id: "line-history", icon: "line-history", label: "Git: View Line History", cmd: "lineHistory", off: !menu.lines },
    );
  }
  return items.filter((item) => !item.off);
}

export const fileMenuMethods = {
  // Right-click in the content: the menu knows the remote link and the clicked line / selection.
  openFileMenu(position) {
    const file = this.file;
    if (!file || file.untitled) {
      return;
    }
    const range = this.editor?.selected_range();
    const lines = range && this.editor ? linesOfRange(this.editor.value(), range) : (this.selLine ? { start: this.selLine } : null);
    const selected = Boolean(range && range.end > range.start);
    this.menuTarget = newId();
    fileWebLinks(`${file.root}/${file.rel}`, { lines, on: file.on ?? null }).catch(() => []).then((links) => {
      const menu = { target: this.menuTarget, editing: Boolean(this.editor), selected, lines, links, git: true };
      const items = menuItems(menu);
      const separators = items.filter((item) => item.sep).length;
      const height = (items.length - separators) * ITEM + separators * SEPARATOR_HEIGHT + PADDING;
      const at = position ? { x: Math.round(position.x), y: Math.round(position.y) } : undefined;
      openOverlay({ mod: MOD, kind: "popup", width: WIDTH, height, at, props: { fileMenu: menu } });
    });
  },

  // Runs what this viewer's popup posted (called from the viewer's timer).
  takeFileMenuCommand(cx) {
    const posted = shared(COMMAND_KEY);
    if (!posted || posted.target !== this.menuTarget || posted.id === this.menuDone) {
      return;
    }
    this.menuDone = posted.id;
    this.runFileMenuCommand(posted, cx);
  },

  runFileMenuCommand(posted, cx) {
    const editor = this.editor;
    const range = editor?.selected_range();
    const selection = editor && range ? editor.value().slice(range.start, range.end) : "";
    if (posted.cmd === "copy" || posted.cmd === "cut") {
      copyText(selection);
    }
    if (posted.cmd === "cut" && selection) {
      editor.replace("");
    }
    if (posted.cmd === "paste" && editor && posted.text !== undefined) {
      editor.replace(posted.text);
    }
    if (posted.cmd === "selectAll" && editor) {
      editor.set_selected_range({ start: 0, end: editor.value().length });
      editor.focus();
    }
    if (posted.cmd === "remoteOpen" && posted.link) {
      logInfo(MOD, "open remote link", posted.link);
      exec("open", [posted.link]).catch((error) => logError(MOD, "open remote link failed", String(error)));
    }
    if (posted.cmd === "remoteCopy" && posted.link) {
      copyText(posted.link);
    }
    if (posted.cmd === "fileHistory") {
      this.openHistory(HISTORY_FILE, cx);
    }
    if (posted.cmd === "lineHistory" && posted.lines?.start) {
      this.selLine = posted.lines.start;
      this.openHistory(HISTORY_LINE, cx);
    }
    cx.notify();
  },

  renderFileMenu() {
    const t = theme();
    const menu = this.fileMenu;
    const post = (item, cx) => {
      const text = item.cmd === "paste" ? cx.read_from_clipboard() : undefined;
      setShared(COMMAND_KEY, { target: menu.target, id: newId(), cmd: item.cmd, link: item.link, lines: menu.lines, text });
      closeOverlay(props()?.overlay);
    };
    return v_flex().id("herdr-vscode-file-menu").size_full().p(6).gap(0).bg(t.popover ?? t.surface).text_color(t.foreground).text_size(TEXT.small)
      .children(menuItems(menu).map((item) => (item.sep
        ? div().id(item.id).h(1).my(4).flex_none().bg(t.border)
        : h_flex().id(`fm-${item.id}`).h(ITEM).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer().hover((style) => style.bg(t.hover))
          .on_click((_event, cx) => post(item, cx))
          .child(Icon(item.icon, 13).text_color(t.dim))
          .child(div().flex_1().min_w(0).truncate().child(item.label)))));
  },
};
