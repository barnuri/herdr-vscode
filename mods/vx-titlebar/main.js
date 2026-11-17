// vx-titlebar: VS Code's title bar, for the vx-code layout (a window_drag block).
//   left     room for the traffic lights, then the workspace's name
//   centre   ← → (back / forward through the tabs you visited) and the command center: opens
//            Go to File (⌘P, vx-titlebar.goto)
//   right    customise layout (Settings › Look), toggle the side bar, the panel, the right panel
// Go to File is a popup copy (props { goto }): every workspace root's files (git ls-files),
// ranked VS Code-style (quickopen-core.js); Enter opens the file preview. Typing ">" first hands
// over to Herdr's command palette, like VS Code.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { theme, layout, run, window, settings, openOverlay, closeOverlay, props, shared, setShared, nextCommand, checking, spaces } from "herdr";
import { workspace, git, baseName, ctx } from "./ws.js";
import { showInViewer } from "./tabs.js";
import { rankFiles } from "./quickopen-core.js";
import { emptyNav, navVisit, navStep } from "./nav-core.js";
import { TEXT, Icon, FileIcon } from "./ui.js";
import { loadIcons } from "./icons.js";

const MOD = "vx-titlebar";
const ROW = 28;
const SHOWN = 14;
const RECENT_KEY = "vx.goto.recent";
const find = (n, id) => (n?.id === id ? n : (n?.children ?? []).map((c) => find(c, id)).find(Boolean) ?? null);

class VxTitlebar extends View {
  init(given, cx) {
    const p = props() ?? given ?? {};
    loadIcons(this, cx);
    if (p.goto) return this.initGoto(p, cx);
    this.width = 1200;
    this.nav = new Map(); // space -> { list: [tab ids], at }
    if (checking()) return;
    cx.timer.every(300, (cx) => this.track(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "goto") this.openGoto();
        if (c === "commands") this.openGoto(">");
        if (c === "back") this.go(-1);
        if (c === "forward") this.go(1);
        cx.notify();
      }
    });
  }

  // ── back / forward: the tabs you visited in this space, like VS Code's navigation ──────
  track(cx) {
    const space = spaces().find((s) => s.active);
    const tab = space?.tabs?.find((t) => t.active)?.id;
    if (!space || !tab) return;
    const h = this.nav.get(space.id) ?? emptyNav();
    if (h.list[h.at] === tab) return;
    if (this.going === tab) this.going = null;
    else this.nav.set(space.id, navVisit(h, tab));
    cx.notify();
  }

  go(step) {
    const space = spaces().find((s) => s.active);
    const h = space && this.nav.get(space.id);
    const next = h && navStep(h, step, new Set((space.tabs ?? []).map((t) => t.id)));
    if (!next) return;
    this.nav.set(space.id, next);
    this.going = next.list[next.at];
    run("tab.select", { id: this.going });
  }

  canGo(step) {
    const space = spaces().find((s) => s.active);
    const h = space && this.nav.get(space.id);
    return Boolean(h && navStep(h, step, new Set((space.tabs ?? []).map((t) => t.id))));
  }

  openGoto(query = "") {
    const width = Math.min(640, Math.max(360, this.width - 80));
    if (query === ">") return run("app.palette");
    openOverlay({ mod: MOD, kind: "popup", width, height: 52 + SHOWN * ROW + 26, at: { x: Math.round((this.width - width) / 2), y: 40 }, props: { goto: { query } } });
  }

  // ── Go to File ─────────────────────────────────────────────────────────────────────────
  initGoto(p, cx) {
    this.goto = true;
    this.files = null;
    this.cursor = 0;
    this.focusHandle = cx.focus_handle();
    this.filter = InputState.new({ placeholder: "Search files by name (type > for commands)" });
    this.filter.on("change", (_e, cx) => {
      this.cursor = 0;
      if (this.filter.value().startsWith(">")) {
        closeOverlay(props()?.overlay);
        run("app.palette");
        return;
      }
      cx.notify();
    });
    this.filter.on("submit", (_e, cx) => this.choose(this.cursor, cx));
    this.filter.focus();
    const roots = workspace()?.roots ?? [];
    const c = ctx();
    const list = roots.length ? roots : c.cwd ? [{ name: baseName(c.cwd), path: c.cwd }] : [];
    cx.spawn(async (cx) => {
      const files = [];
      for (const root of list) {
        const out = await git(["ls-files", "-z", "-co", "--exclude-standard"], { cwd: root.path }).catch(() => null);
        if (out?.code === 0) for (const rel of out.stdout.split("\0")) if (rel) files.push({ root, rel });
      }
      this.files = files;
      cx.notify();
    });
  }

  items() {
    const q = this.filter.value().trim();
    if (!q) {
      const live = new Set((workspace()?.roots ?? []).map((r) => r.path));
      return (shared(RECENT_KEY) ?? []).filter((r) => live.size === 0 || live.has(r.root.path)).slice(0, SHOWN * 2);
    }
    return this.files ? rankFiles(this.files, q, 200) : [];
  }

  choose(i, _cx) {
    const it = this.items()[i];
    closeOverlay(props()?.overlay);
    if (!it) return;
    const recent = (shared(RECENT_KEY) ?? []).filter((r) => !(r.root.path === it.root.path && r.rel === it.rel));
    setShared(RECENT_KEY, [{ root: it.root, rel: it.rel }, ...recent].slice(0, 40));
    showInViewer("vx-files", { root: it.root.path, on: null, rel: it.rel }, baseName(it.rel));
  }

  renderGoto() {
    const t = theme();
    const items = this.items();
    const cur = Math.min(this.cursor, Math.max(0, items.length - 1));
    const multi = (workspace()?.roots ?? []).length > 1;
    const q = this.filter.value().trim();
    const note = !q ? (items.length ? "recently opened" : "Type a file name. > runs a command.")
      : !this.files ? "Indexing…" : items.length ? `${items.length >= 200 ? "200+" : items.length} files` : "No matching files.";
    return v_flex().id("vx-goto").size_full().p(6).gap(4).bg(t.popover ?? t.surface).text_color(t.foreground)
      .track_focus(this.focusHandle)
      .on_key_down((e, cx) => {
        if (e.key === "down") { this.cursor = Math.min(items.length - 1, cur + 1); cx.stop_propagation(); cx.notify(); }
        else if (e.key === "up") { this.cursor = Math.max(0, cur - 1); cx.stop_propagation(); cx.notify(); }
        else if (e.key === "enter") { cx.stop_propagation(); this.choose(cur, cx); }
        else if (e.key === "escape") { cx.stop_propagation(); closeOverlay(props()?.overlay); }
      })
      .child(h_flex().h(32).flex_none().px(8).gap(6).items_center().rounded(6).border_1().border_color(t.accent).bg(t.input ?? t.background)
        .child(Icon("search", 13).text_color(t.dim)).child(Input.new(this.filter).flex_1().h(30).text_size(TEXT.body)))
      .child(div().h(18).flex_none().px(8).text_size(TEXT.caption).text_color(t.dim).child(note))
      .child(v_flex().id("goto-rows").flex_none().h(SHOWN * ROW).overflow_y_scrollbar()
        .children(items.map((it, i) => {
          const name = baseName(it.rel);
          const dir = it.rel.includes("/") ? it.rel.slice(0, it.rel.lastIndexOf("/")) : "";
          return h_flex().id(`g-${it.root.path}-${it.rel}`).h(ROW).flex_none().px(8).gap(8).items_center().rounded(5).cursor_pointer()
            .bg(i === cur ? t.selected : "#00000000").hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.choose(i, cx))
            .child(FileIcon(this.icons, it.rel, { size: 15 }))
            .child(div().flex_none().max_w(260).truncate().text_size(TEXT.body).child(name))
            .child(div().flex_1().min_w(0).truncate().text_size(TEXT.caption).text_color(t.dim).child(multi ? `${it.root.name}${dir ? ` · ${dir}` : ""}` : dir));
        })));
  }

  // ── the bar ────────────────────────────────────────────────────────────────────────────
  render() {
    if (this.goto) return this.renderGoto();
    const t = theme();
    const root = layout();
    const w = window();
    const zoom = settings().zoom || 1;
    const lights = w?.platform === "macos" && !w.fullscreen && root?.traffic_lights ? (root.traffic_lights[0] + 64) / zoom : 12;
    const stop = (_e, cx) => cx.stop_propagation();
    const ws = workspace();
    const label = ws?.name ?? (ctx().root?.name ?? "Herdr");
    const toggle = (id, icon, tip, on, action) => div().id(`tb-${id}`).size(26).flex_none().flex().items_center().justify_center().rounded(5)
      .text_color(on ? t.foreground : t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", stop).on_click(action).child(Icon(icon, 15));
    const side = find(root, "sidebar");
    const bottom = find(root, "bottom");
    const right = find(root, "panel");
    const center = Math.min(520, Math.max(200, this.width * 0.34));
    return h_flex().id("vx-titlebar").size_full().items_center().bg(t.canvas ?? t.chrome).text_size(TEXT.small)
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 4) { this.width = size.width; cx.notify(); } })
      .child(h_flex().flex_1().min_w(0).h_full().pl(lights).gap(6).items_center()
        .child(div().id("tb-ws").px(6).h(24).flex().items_center().rounded(5).truncate().text_color(t.muted).font_medium()
          .hover((s) => s.bg(t.hover)).tooltip(ws?.file ? `Workspace: ${ws.file}` : "No workspace open")
          .on_mouse_down("left", stop)
          .on_click(() => { run("layout.select", { stack: "sidebar-views", child: "explorer" }); run("layout.show", { id: "sidebar" }); })
          .child(label)))
      .child(toggle("back", "back", "Go Back", false, () => this.go(-1)).when(!this.canGo(-1), (el) => el.opacity(0.4)))
      .child(toggle("fwd", "forward", "Go Forward", false, () => this.go(1)).when(!this.canGo(1), (el) => el.opacity(0.4)))
      .child(div().w(6))
      .child(h_flex().id("tb-cc").w(center).h(24).flex_none().px(8).gap(6).items_center().justify_center().rounded(6)
        .border_1().border_color(t.border).bg(t.input ?? t.background).text_color(t.dim).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.muted)).tooltip("Go to File (⌘P) · type > for commands")
        .on_mouse_down("left", stop).on_click(() => this.openGoto())
        .child(Icon("search", 12)).child(div().truncate().child(label)))
      .child(h_flex().flex_1().min_w(0).h_full().pr(8).gap(2).items_center().justify_end()
        .child(toggle("look", "layout", "Customize Layout (Settings › Look)", false, () => run("app.settings", { section: "look" })))
        .when(Boolean(side), (el) => el.child(toggle("side", "sidebar", "Toggle Side Bar (⌘B)", !side.hidden, () => run("layout.toggle", { id: "sidebar" }))))
        .when(Boolean(bottom), (el) => el.child(toggle("bottom", "panel", "Toggle Panel (⌘J)", !bottom.hidden, () => run("vx-activity.panel"))))
        .when(Boolean(right), (el) => el.child(toggle("right", "panel-right", "Toggle Right Panel", !right.hidden, () => run("layout.toggle", { id: "panel" }))))
        .when(Boolean(w?.buttons), (el) => el
          .child(toggle("min", "minus", "Minimize", false, () => run("window.minimize")))
          .child(toggle("max", "maximize", "Maximize", false, () => run("window.maximize")))
          .child(toggle("close", "x", "Close", false, () => run("window.close")))));
  }
}

export default VxTitlebar;
