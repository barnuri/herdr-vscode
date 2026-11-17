// Popups and dialogs of the Workspace panel. They are copies of this mod that close as soon as
// you choose, so they don't do the work themselves: they post a command (shared "vx.ws.cmd")
// and the panel runs it (see main.js runCommand).
import { div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { theme, props, closeOverlay, openOverlay, shared, setShared, home } from "herdr";
import { baseName, parentOf } from "./ws-core.js";
import { TEXT, Icon, Button, FileIcon } from "./ui.js";

const MOD = "vx-workspace";
const ITEM = 28;

export const post = (command) => setShared("vx.ws.cmd", { ...command, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}` });

export const menuMethods = {
  command(c) {
    post(c);
  },

  openMenu(menu) {
    const items = this.menuItems(menu).length;
    const seps = this.menuItems(menu).filter((i) => i.sep).length;
    openOverlay({ mod: MOD, kind: "popup", width: 260, height: (items - seps) * ITEM + seps * 9 + 14, props: { menu } });
  },

  menuItems(m) {
    const ws = shared("vx.workspace");
    const recent = (shared("vx.ws.recent") ?? []).filter((r) => r.file !== ws?.file).slice(0, 6);
    if (m.kind === "header") {
      const items = [
        { id: "add", icon: "plus", label: "Add Folder to Workspace…", cmd: { cmd: "addFolder" }, off: !ws },
        { id: "new", icon: "layers", label: "New Workspace…", dialog: { kind: "new" } },
        { id: "open", icon: "folder", label: "Open Workspace…", cmd: { cmd: "pickOpen" } },
      ];
      if (ws && !ws.file) items.push({ id: "saveas", icon: "download", label: "Save Workspace As…", dialog: { kind: "new", paths: ws.roots.map((r) => r.path), dir: ws.dir, name: ws.name } });
      if (ws?.file) items.push({ id: "reveal", icon: "external", label: "Reveal Workspace File", cmd: { cmd: "finder", path: ws.file, reveal: true } });
      if (ws) items.push({ id: "close", icon: "x", label: "Close Workspace", cmd: { cmd: "close" } });
      if (recent.length) {
        items.push({ sep: true, id: "s1" });
        for (const r of recent) items.push({ id: `recent-${r.file ?? r.dir}`, icon: "history", label: r.name, sub: (r.file ?? r.dir).replace(home(), "~"), cmd: { cmd: "open", file: r.file, dir: r.dir } });
      }
      return items.filter((i) => !i.off);
    }
    if (m.kind === "root") {
      const r = m.root;
      return [
        { id: "term", icon: "terminal", label: "Open in Terminal", cmd: { cmd: "terminal", path: r.path } },
        { id: "finder", icon: "folder", label: "Reveal in Finder", cmd: { cmd: "finder", path: r.path } },
        { id: "copy", icon: "copy", label: "Copy Path", copy: r.path },
        { sep: true, id: "s1" },
        { id: "rename", icon: "pencil", label: "Rename…", dialog: { kind: "rename", path: r.path, name: r.name }, off: !shared("vx.workspace")?.file },
        { id: "up", icon: "up", label: "Move Up", cmd: { cmd: "move", path: r.path, to: m.index - 1 }, off: m.index === 0 || !shared("vx.workspace")?.file },
        { id: "down", icon: "chevron-down", label: "Move Down", cmd: { cmd: "move", path: r.path, to: m.index + 1 }, off: m.index >= m.count - 1 || !shared("vx.workspace")?.file },
        { id: "remove", icon: "minus", label: "Remove Folder from Workspace", cmd: { cmd: "remove", path: r.path }, off: !shared("vx.workspace")?.file },
        { sep: true, id: "s2" },
        { id: "fetch", icon: "arrow-down", label: "Fetch…", cmd: { cmd: "fetch", path: r.path, name: r.name } },
      ].filter((i) => !i.off);
    }
    // a file or folder inside a root
    const abs = `${m.root.path}/${m.rel}`;
    return [
      ...(m.dir ? [{ id: "term", icon: "terminal", label: "Open in Terminal", cmd: { cmd: "terminal", path: abs } }] : [{ id: "preview", icon: "eye", label: "Open Preview", cmd: { cmd: "preview", root: m.root.path, rel: m.rel } }]),
      { id: "open", icon: "external", label: m.dir ? "Reveal in Finder" : "Open with Default App", cmd: { cmd: "finder", path: abs, reveal: m.dir ? false : undefined, app: !m.dir } },
      { id: "reveal", icon: "folder", label: "Reveal in Finder", cmd: { cmd: "finder", path: abs, reveal: true }, off: m.dir },
      { sep: true, id: "s1" },
      { id: "copy", icon: "copy", label: "Copy Path", copy: abs },
      { id: "copyrel", icon: "copy", label: "Copy Relative Path", copy: m.rel },
    ].filter((i) => !i.off);
  },

  renderMenu() {
    const t = theme();
    const m = this.menu;
    const close = () => closeOverlay(props()?.overlay);
    return v_flex().id("vx-ws-menu").size_full().p(6).gap(0).bg(t.popover ?? t.surface).text_color(t.foreground).text_size(TEXT.small)
      .children(this.menuItems(m).map((item) => item.sep
        ? div().id(item.id).h(1).my(4).flex_none().bg(t.border)
        : h_flex().id(`m-${item.id}`).h(ITEM).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
          .tooltip(item.sub ?? item.label)
          .on_click((_e, cx) => {
            if (item.copy) cx.write_to_clipboard(item.copy);
            if (item.cmd) post(item.cmd);
            if (item.dialog) this.openDialog(item.dialog);
            close();
          })
          .child(Icon(item.icon, 13).text_color(t.dim))
          .child(div().flex_1().min_w(0).truncate().child(item.label))
          .when(Boolean(item.sub), (el) => el.child(div().max_w(100).truncate().text_size(TEXT.caption).text_color(t.dim).child(baseName(parentOf(item.sub)))))));
  },

  // ── dialogs ────────────────────────────────────────────────────────────────────────────
  openDialog(d) {
    openOverlay({ mod: MOD, kind: "dialog", width: 460, height: d.kind === "rename" ? 180 : 420, props: { dialog: d } });
  },

  // Text boxes are made in init (never in render).
  initDialog(d) {
    this.dlg = d;
    if (d.kind === "rename") this.nameInput = InputState.new({ value: d.name, placeholder: baseName(d.path) });
    else {
      this.nameInput = InputState.new({ value: d.name ?? "", placeholder: "my-workspace" });
      this.newPaths = [...(d.paths ?? [])];
      this.newDir = d.dir ?? (this.newPaths[0] ? parentOf(this.newPaths[0]) : null);
    }
    this.nameInput.focus();
  },

  renderDialog(cx) {
    const t = theme();
    const d = this.dlg;
    const close = () => closeOverlay(props()?.overlay);
    const box = (state) => h_flex().h(30).px(8).items_center().rounded(6).border_1().border_color(t.border).bg(t.input ?? t.background).child(Input.new(state).flex_1().h(28).text_size(TEXT.small));
    const shell = v_flex().id("vx-ws-dialog").size_full().p(18).gap(10).bg(t.popover ?? t.surface).text_color(t.foreground);
    if (d.kind === "rename") {
      return shell
        .child(div().text_size(TEXT.title).font_semibold().child("Rename folder in workspace"))
        .child(box(this.nameInput))
        .child(div().text_size(TEXT.caption).text_color(t.dim).child(`Only the name shown in the workspace; ${baseName(d.path)} on disk stays as it is. Empty = the folder's own name.`))
        .child(div().flex_1())
        .child(h_flex().gap(8).justify_end()
          .child(Button({ id: "cancel", label: "Cancel", onClick: close }))
          .child(Button({ id: "ok", label: "Rename", primary: true, onClick: () => { post({ cmd: "rename", path: d.path, name: this.nameInput.value().trim() }); close(); } })));
    }
    // New workspace / Save As: a name, where to save it, and its folders.
    const name = this.nameInput.value().trim();
    const file = this.newDir && name ? `${this.newDir}/${name}.code-workspace` : null;
    return shell
      .child(div().text_size(TEXT.title).font_semibold().child(d.paths?.length && d.name ? "Save Workspace As" : "New Workspace"))
      .child(div().text_size(TEXT.small).child("Name"))
      .child(box(this.nameInput))
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(TEXT.small).child("Save in"))
        .child(div().flex_1().min_w(0).truncate().text_size(TEXT.small).text_color(this.newDir ? t.muted : t.dim).child(this.newDir ? this.newDir.replace(home(), "~") : "choose a folder"))
        .child(Button({ id: "where", label: "Choose…", onClick: () => post({ cmd: "pickDir", dialog: props()?.overlay }) })))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(TEXT.small).child(`Folders (${this.newPaths.length})`))
        .child(Button({ id: "addf", icon: "plus", label: "Add Folder…", onClick: () => post({ cmd: "pickNewFolder", dialog: props()?.overlay }) })))
      .child(v_flex().id("nf-list").flex_1().min_h(0).overflow_y_scrollbar().gap(1).rounded(6).border_1().border_color(t.border).p(4)
        .when(!this.newPaths.length, (el) => el.child(div().p(6).text_size(TEXT.caption).text_color(t.dim).child("No folders yet.")))
        .children(this.newPaths.map((p) => h_flex().id(`nf-${p}`).h(24).px(6).gap(6).items_center().rounded(5).hover((s) => s.bg(t.hover)).text_size(TEXT.small)
          .child(FileIcon(this.icons, baseName(p), { dir: true, size: 14 }))
          .child(div().flex_1().min_w(0).truncate().child(p.replace(home(), "~")))
          .child(div().id(`nfx-${p}`).cursor_pointer().text_color(t.dim).hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => { this.newPaths = this.newPaths.filter((x) => x !== p); cx.notify(); }).child(Icon("x", 12))))))
      .child(div().text_size(TEXT.caption).text_color(t.dim).truncate().child(file ? file.replace(home(), "~") : " "))
      .child(h_flex().gap(8).justify_end()
        .child(Button({ id: "cancel", label: "Cancel", onClick: close }))
        .child(Button({ id: "create", label: "Create", primary: true, disabled: !file || !this.newPaths.length,
          onClick: () => { post({ cmd: "create", file, paths: this.newPaths }); close(); } })));
  },

  // The panel answers a dialog's folder pick here (shared "vx.ws.reply").
  takeReply(cx) {
    const r = shared("vx.ws.reply");
    if (!r || r.id === this.replySeen || r.dialog !== props()?.overlay) return;
    this.replySeen = r.id;
    if (r.dir) this.newDir = r.dir;
    if (r.folder && !this.newPaths.includes(r.folder)) {
      this.newPaths.push(r.folder);
      this.newDir ??= parentOf(r.folder);
    }
    cx.notify();
  },
};
