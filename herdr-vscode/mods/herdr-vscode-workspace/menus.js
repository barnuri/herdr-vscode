import { div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { theme, props, closeOverlay, openOverlay, shared, setShared, home } from "herdr";
import { baseName, parentOf } from "./ws-core.js";
import { TEXT, Icon, Button, FileIcon } from "./ui.js";
import { CLIPBOARD_KEY, remoteLinkItems } from "./fileops-core.js";
import { fileWebLinks } from "./remote-url.js";

const MOD = "herdr-vscode-workspace";
const ITEM = 28;
const SEPARATOR_HEIGHT = 9;
const MENU_PADDING = 14;
const MENU_WIDTH = 260;
const MAX_RECENT = 6;
const DIALOG_WIDTH = 460;
const RENAME_DIALOG_HEIGHT = 180;
const NEW_DIALOG_HEIGHT = 420;
const ID_RADIX = 36;
const ID_SUFFIX_END = 7;
const COMMAND_KEY = "herdr-vscode.ws.cmd";
const REPLY_KEY = "herdr-vscode.ws.reply";
const KIND_HEADER = "header";
const KIND_ROOT = "root";
const KIND_RENAME = "rename";
const KIND_RENAME_FILE = "renameFile";
const KIND_ENTRY = "entry";

export const post = (command) => setShared(COMMAND_KEY, { ...command, id: `${Date.now()}-${Math.random().toString(ID_RADIX).slice(2, ID_SUFFIX_END)}` });

const visible = (items) => items.filter((item) => !item.off);

const tildePath = (path) => path.replace(home(), "~");

const closeThisOverlay = () => closeOverlay(props()?.overlay);

function headerItems(ws) {
  const recent = (shared("herdr-vscode.ws.recent") ?? []).filter((entry) => entry.file !== ws?.file).slice(0, MAX_RECENT);
  const items = [
    { id: "add", icon: "plus", label: "Add Folder to Workspace…", cmd: { cmd: "addFolder" }, off: !ws },
    { id: "new", icon: "layers", label: "New Workspace…", dialog: { kind: "new" } },
    { id: "open", icon: "folder", label: "Open Workspace…", cmd: { cmd: "pickOpen" } },
  ];
  if (ws && !ws.file) {
    items.push({ id: "saveas", icon: "download", label: "Save Workspace As…", dialog: { kind: "new", paths: ws.roots.map((root) => root.path), dir: ws.dir, name: ws.name } });
  }
  if (ws?.file) {
    items.push({ id: "reveal", icon: "external", label: "Reveal Workspace File", cmd: { cmd: "finder", path: ws.file, reveal: true } });
  }
  if (ws) {
    items.push({ id: "close", icon: "x", label: "Close Workspace", cmd: { cmd: "close" } });
  }
  if (recent.length) {
    items.push({ sep: true, id: "s1" });
    for (const entry of recent) {
      const location = entry.file ?? entry.dir;
      items.push({ id: `recent-${location}`, icon: "history", label: entry.name, sub: tildePath(location), cmd: { cmd: "open", file: entry.file, dir: entry.dir } });
    }
  }
  return visible(items);
}

function rootItems(menu, ws) {
  const root = menu.root;
  const notFile = !ws?.file;
  return visible([
    { id: "term", icon: "terminal", label: "Open in Terminal", cmd: { cmd: "terminal", path: root.path } },
    { id: "finder", icon: "folder", label: "Reveal in Finder", cmd: { cmd: "finder", path: root.path } },
    { id: "copy", icon: "copy", label: "Copy Path", copy: root.path },
    { sep: true, id: "s1" },
    { id: "rename", icon: "pencil", label: "Rename…", dialog: { kind: KIND_RENAME, path: root.path, name: root.name }, off: notFile },
    { id: "up", icon: "up", label: "Move Up", cmd: { cmd: "move", path: root.path, to: menu.index - 1 }, off: menu.index === 0 || notFile },
    { id: "down", icon: "chevron-down", label: "Move Down", cmd: { cmd: "move", path: root.path, to: menu.index + 1 }, off: menu.index >= menu.count - 1 || notFile },
    { id: "remove", icon: "minus", label: "Remove Folder from Workspace", cmd: { cmd: "remove", path: root.path }, off: notFile },
    { sep: true, id: "s2" },
    { id: "fetch", icon: "arrow-down", label: "Fetch…", cmd: { cmd: "fetch", path: root.path, name: root.name } },
  ]);
}

// VS Code's Explorer menu. Paste goes into the folder clicked, or the folder of the file clicked.
function entryItems(menu) {
  const abs = `${menu.root.path}/${menu.rel}`;
  const folder = menu.dir ? abs : parentOf(abs);
  const clip = shared(CLIPBOARD_KEY);
  const file = { root: menu.root.path, rel: menu.rel };
  const hasLink = (menu.links ?? []).length > 0;
  return visible([
    { id: "preview", icon: "eye", label: "Open", cmd: { cmd: "preview", ...file }, off: menu.dir },
    { id: "side", icon: "split", label: "Open to the Side", cmd: { cmd: "openSide", ...file }, off: menu.dir },
    { id: "term", icon: "terminal", label: "Open in Integrated Terminal", cmd: { cmd: "terminal", path: menu.dir ? abs : folder } },
    { id: "reveal", icon: "folder", label: "Reveal in Finder", cmd: { cmd: "finder", path: abs, reveal: true } },
    { sep: true, id: "s1" },
    { id: "cut", icon: "minus", label: "Cut", cmd: { cmd: "clip", path: abs, cut: true } },
    { id: "copyfile", icon: "copy", label: "Copy", cmd: { cmd: "clip", path: abs, cut: false } },
    { id: "paste", icon: "download", label: clip?.path ? `Paste ${baseName(clip.path)}` : "Paste", cmd: { cmd: "paste", folder }, off: !clip?.path },
    { sep: true, id: "s2" },
    { id: "copy", icon: "copy", label: "Copy Path", copy: abs },
    { id: "copyrel", icon: "copy", label: "Copy Relative Path", copy: menu.rel },
    { sep: true, id: "s3" },
    { id: "rename", icon: "pencil", label: "Rename…", dialog: { kind: KIND_RENAME_FILE, path: abs, name: baseName(abs) } },
    { id: "delete", icon: "trash", label: "Delete", cmd: { cmd: "delete", path: abs, dir: menu.dir } },
    { sep: true, id: "s4", off: !hasLink },
    ...remoteLinkItems(menu.links).map((item) => (item.kind === "open"
      ? { id: item.id, icon: "external", label: item.label, cmd: { cmd: "finder", path: item.url } }
      : { id: item.id, icon: "copy", label: item.label, copy: item.url })),
    { id: "history", icon: "history", label: "Git: View File History", cmd: { cmd: "fileHistory", ...file }, off: !hasLink || menu.dir },
  ]);
}

export const menuMethods = {
  command(command) {
    post(command);
  },

  // An entry's menu first looks up its remote links (none: no Git items).
  openMenu(menu) {
    if (menu.kind === KIND_ENTRY && menu.links === undefined) {
      fileWebLinks(`${menu.root.path}/${menu.rel}`, { dir: menu.dir }).catch(() => []).then((links) => this.openMenu({ ...menu, links }));
      return;
    }
    const items = this.menuItems(menu);
    const separators = items.filter((item) => item.sep).length;
    const height = (items.length - separators) * ITEM + separators * SEPARATOR_HEIGHT + MENU_PADDING;
    openOverlay({ mod: MOD, kind: "popup", width: MENU_WIDTH, height, props: { menu } });
  },

  menuItems(menu) {
    const ws = shared("herdr-vscode.workspace");
    if (menu.kind === KIND_HEADER) {
      return headerItems(ws);
    }
    if (menu.kind === KIND_ROOT) {
      return rootItems(menu, ws);
    }
    return entryItems(menu);
  },

  runMenuItem(item, cx) {
    if (item.copy) {
      cx.write_to_clipboard(item.copy);
    }
    if (item.cmd) {
      post(item.cmd);
    }
    if (item.dialog) {
      this.openDialog(item.dialog);
    }
    closeThisOverlay();
  },

  menuRow(t, item) {
    if (item.sep) {
      return div().id(item.id).h(1).my(4).flex_none().bg(t.border);
    }
    return h_flex().id(`m-${item.id}`).h(ITEM).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer().hover((style) => style.bg(t.hover))
      .tooltip(item.sub ?? item.label)
      .on_click((_event, cx) => this.runMenuItem(item, cx))
      .child(Icon(item.icon, 13).text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().child(item.label))
      .when(Boolean(item.sub), (el) => el.child(div().max_w(100).truncate().text_size(TEXT.caption).text_color(t.dim).child(baseName(parentOf(item.sub)))));
  },

  renderMenu() {
    const t = theme();
    return v_flex().id("herdr-vscode-ws-menu").size_full().p(6).gap(0).bg(t.popover ?? t.surface).text_color(t.foreground).text_size(TEXT.small)
      .children(this.menuItems(this.menu).map((item) => this.menuRow(t, item)));
  },

  openDialog(dialog) {
    const height = dialog.kind === KIND_RENAME || dialog.kind === KIND_RENAME_FILE ? RENAME_DIALOG_HEIGHT : NEW_DIALOG_HEIGHT;
    openOverlay({ mod: MOD, kind: "dialog", width: DIALOG_WIDTH, height, props: { dialog } });
  },

  // Text boxes are made in init (never in render).
  initDialog(dialog) {
    this.dlg = dialog;
    if (dialog.kind === KIND_RENAME || dialog.kind === KIND_RENAME_FILE) {
      this.nameInput = InputState.new({ value: dialog.name, placeholder: baseName(dialog.path) });
    } else {
      this.nameInput = InputState.new({ value: dialog.name ?? "", placeholder: "my-workspace" });
      this.newPaths = [...(dialog.paths ?? [])];
      this.newDir = dialog.dir ?? (this.newPaths[0] ? parentOf(this.newPaths[0]) : null);
    }
    this.nameInput.focus();
  },

  inputBox(t, state) {
    return h_flex().h(30).px(8).items_center().rounded(6).border_1().border_color(t.border).bg(t.input ?? t.background)
      .child(Input.new(state).flex_1().h(28).text_size(TEXT.small));
  },

  renameDialog(t, shell, dialog) {
    return shell
      .child(div().text_size(TEXT.title).font_semibold().child("Rename folder in workspace"))
      .child(this.inputBox(t, this.nameInput))
      .child(div().text_size(TEXT.caption).text_color(t.dim).child(`Only the name shown in the workspace; ${baseName(dialog.path)} on disk stays as it is. Empty = the folder's own name.`))
      .child(div().flex_1())
      .child(h_flex().gap(8).justify_end()
        .child(Button({ id: "cancel", label: "Cancel", onClick: closeThisOverlay }))
        .child(Button({
          id: "ok", label: "Rename", primary: true,
          onClick: () => {
            post({ cmd: "rename", path: dialog.path, name: this.nameInput.value().trim() });
            closeThisOverlay();
          },
        })));
  },

  renameFileDialog(t, shell, dialog) {
    const submit = () => {
      post({ cmd: "renameFile", path: dialog.path, name: this.nameInput.value().trim() });
      closeThisOverlay();
    };
    return shell
      .child(div().text_size(TEXT.title).font_semibold().child(`Rename ${baseName(dialog.path)}`))
      .child(this.inputBox(t, this.nameInput))
      .child(div().text_size(TEXT.caption).text_color(t.dim).child("A new name in the same folder. An existing name is never replaced."))
      .child(div().flex_1())
      .child(h_flex().gap(8).justify_end()
        .child(Button({ id: "cancel", label: "Cancel", onClick: closeThisOverlay }))
        .child(Button({ id: "ok", label: "Rename", primary: true, onClick: submit })));
  },

  newFolderRow(t, path) {
    return h_flex().id(`nf-${path}`).h(24).px(6).gap(6).items_center().rounded(5).hover((style) => style.bg(t.hover)).text_size(TEXT.small)
      .child(FileIcon(this.icons, baseName(path), { dir: true, size: 14 }))
      .child(div().flex_1().min_w(0).truncate().child(tildePath(path)))
      .child(div().id(`nfx-${path}`).cursor_pointer().text_color(t.dim).hover((style) => style.text_color(t.foreground))
        .on_click((_event, cx) => {
          this.newPaths = this.newPaths.filter((candidate) => candidate !== path);
          cx.notify();
        }).child(Icon("x", 12)));
  },

  // New workspace / Save As: a name, where to save it, and its folders.
  newWorkspaceDialog(t, shell, dialog) {
    const name = this.nameInput.value().trim();
    const file = this.newDir && name ? `${this.newDir}/${name}.code-workspace` : null;
    return shell
      .child(div().text_size(TEXT.title).font_semibold().child(dialog.paths?.length && dialog.name ? "Save Workspace As" : "New Workspace"))
      .child(div().text_size(TEXT.small).child("Name"))
      .child(this.inputBox(t, this.nameInput))
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(TEXT.small).child("Save in"))
        .child(div().flex_1().min_w(0).truncate().text_size(TEXT.small).text_color(this.newDir ? t.muted : t.dim).child(this.newDir ? tildePath(this.newDir) : "choose a folder"))
        .child(Button({ id: "where", label: "Choose…", onClick: () => post({ cmd: "pickDir", dialog: props()?.overlay }) })))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(TEXT.small).child(`Folders (${this.newPaths.length})`))
        .child(Button({ id: "addf", icon: "plus", label: "Add Folder…", onClick: () => post({ cmd: "pickNewFolder", dialog: props()?.overlay }) })))
      .child(v_flex().id("nf-list").flex_1().min_h(0).overflow_y_scrollbar().gap(1).rounded(6).border_1().border_color(t.border).p(4)
        .when(!this.newPaths.length, (el) => el.child(div().p(6).text_size(TEXT.caption).text_color(t.dim).child("No folders yet.")))
        .children(this.newPaths.map((path) => this.newFolderRow(t, path))))
      .child(div().text_size(TEXT.caption).text_color(t.dim).truncate().child(file ? tildePath(file) : " "))
      .child(h_flex().gap(8).justify_end()
        .child(Button({ id: "cancel", label: "Cancel", onClick: closeThisOverlay }))
        .child(Button({
          id: "create", label: "Create", primary: true, disabled: !file || !this.newPaths.length,
          onClick: () => {
            post({ cmd: "create", file, paths: this.newPaths });
            closeThisOverlay();
          },
        })));
  },

  renderDialog() {
    const t = theme();
    const dialog = this.dlg;
    const shell = v_flex().id("herdr-vscode-ws-dialog").size_full().p(18).gap(10).bg(t.popover ?? t.surface).text_color(t.foreground);
    if (dialog.kind === KIND_RENAME) {
      return this.renameDialog(t, shell, dialog);
    }
    if (dialog.kind === KIND_RENAME_FILE) {
      return this.renameFileDialog(t, shell, dialog);
    }
    return this.newWorkspaceDialog(t, shell, dialog);
  },

  // The panel answers a dialog's folder pick here.
  takeReply(cx) {
    const reply = shared(REPLY_KEY);
    if (!reply || reply.id === this.replySeen || reply.dialog !== props()?.overlay) {
      return;
    }
    this.replySeen = reply.id;
    if (reply.dir) {
      this.newDir = reply.dir;
    }
    if (reply.folder && !this.newPaths.includes(reply.folder)) {
      this.newPaths.push(reply.folder);
      this.newDir ??= parentOf(reply.folder);
    }
    cx.notify();
  },
};
