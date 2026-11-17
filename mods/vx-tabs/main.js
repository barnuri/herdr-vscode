// vx-tabs: the tab bar. Tabs of the shown space (agent status, rename on double-click, drag to
// reorder, right-click menu, wheel to switch), the + menu, and the side panel buttons:
// Files · Changes · CI (each shows its panel, again hides it, remembered per space), plus
// Graph, which opens the Commit Graph of the repo every vx panel is showing.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, layout, settings, notify, checking } from "herdr";
import { ctx, contextKey, repoTop, baseName } from "./ws.js";
import { PM_ICON, findProject, pmOf, chosenOf, allScripts, runScript } from "./scripts.js";
import { Icon } from "./ui.js";
import { showInViewer } from "./tabs.js";

const PANELS = [["files", "Files", "file"], ["changes", "Changes", "branch"], ["ci", "CI", "pipeline"]];
const find = (n, id) => (n?.id === id ? n : (n?.children ?? []).map((c) => find(c, id)).find(Boolean) ?? null);

// A status glyph or "[ ! ]" prefix an agent puts in its title, dropped.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();

// A tab nobody named follows its agent's live title; a name you gave stays.
function tabLabel(tab, lead) {
  const prog = lead?.program?.name;
  const base = tab.named ? tab.name : prog ?? "Terminal";
  if (!lead?.program?.agent) return base;
  const live = clean(lead.title);
  const looksLikePath = /^[~/]/.test((lead.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const useful = live && live !== lead.terminal && live !== prog && !looksLikePath && !live.includes("@") && live.toLowerCase() !== lead.program.key;
  return (tab.name === prog || !tab.named) && useful ? live : base;
}

class VxTabs extends View {
  init(_props, cx) {
    this.pressed = null;
    this.project = null;
    if (!checking()) {
      cx.timer.every(400, (cx) => this.detectScripts(cx));
      cx.timer.every(15000, (cx) => { this.scriptsKey = null; this.detectScripts(cx); });
    }
    this.scroll = ScrollHandle.new();
    this.tops = new Map();
    this.swipe = { acc: 0, steps: 0, at: 0, last: 0 };
    try {
      this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}") ?? {};
    } catch {
      this.panels = {};
    }
  }

  // A wheel notch, or about 25 px of a touchpad swipe, moves one tab (a long swipe: one per
  // 60 px, at most one per 100 ms).
  wheel(e) {
    if (e.delta_lines) {
      if (e.delta_lines.y) run(e.delta_lines.y > 0 ? "tab.prev" : "tab.next");
      return;
    }
    const s = this.swipe;
    const now = Date.now();
    if (e.touch_phase === "started" || now - s.at > 250 || e.delta.y * s.acc < 0) Object.assign(s, { acc: 0, steps: 0 });
    s.at = now;
    s.acc += e.delta.y;
    const need = s.steps ? 60 : 20;
    if (Math.abs(s.acc) < need || now - s.last < 100) return;
    s.acc -= Math.sign(s.acc) * need;
    s.steps++;
    s.last = now;
    run(e.delta.y > 0 ? "tab.prev" : "tab.next");
  }

  // The panel each space had open comes back when you switch to that space.
  syncPanel(space, panel, body) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    const ids = PANELS.map((p) => p[0]);
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id;
      this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null;
        const want = ids.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) this.showPanel(want);
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  // The package.json of the repo every vx panel shows, for the inline ▾ script ▶.
  detectScripts(cx) {
    const c = ctx();
    const key = contextKey(c);
    if (key === this.scriptsKey || this.scanning) return;
    this.scriptsKey = key;
    this.scanning = true;
    cx.spawn(async (cx) => {
      try {
        const top = c.cwd ? await repoTop(this.tops, c.cwd, c.on) : null;
        const start = c.source === "focus" || c.source === "repo" ? c.cwd : top ?? c.cwd;
        const project = start ? await findProject(start, c.on) : null;
        if (JSON.stringify(project) !== JSON.stringify(this.project)) {
          this.project = project;
          cx.notify();
        }
      } finally {
        this.scanning = false;
      }
    });
  }

  scriptsControl(t, stop) {
    const p = this.project;
    if (!p) return null;
    const x = chosenOf(p);
    const pm = pmOf(p);
    const rows = Math.min(16, allScripts(p).length + p.groups.length);
    return h_flex().flex_none().items_center()
      .child(h_flex().id("sc-pick").h(26).max_w(160).px(7).gap(5).items_center().rounded_l(6).border_1().border_color(t.border).bg(t.background)
        .cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(`${p.name}: ${allScripts(p).length} scripts · ${pm}\n${pm} run ${x.s.name}\n${x.s.cmd}`)
        .on_mouse_down("left", stop)
        .on_click(() => openOverlay({ mod: "vx-scripts", kind: "popup", width: 420, height: 112 + rows * 36, props: { menu: { project: p } } }))
        .child(image(PM_ICON(pm)).size(13).flex_none())
        .child(div().truncate().text_size(12).text_color(t.foreground).child(x.s.name))
        .child(Icon("chevron-down", 11).text_color(t.dim)))
      .child(div().id("sc-run").h(26).w(28).flex().items_center().justify_center().rounded_r(6).border_1().border_color(t.border).bg(t.background)
        .text_color(t.ansi2).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(`Run ${x.s.name} in a new tab`)
        .on_mouse_down("left", stop).on_click(() => runScript(p, x))
        .child(Icon("play", 11)));
  }

  showPanel(id) {
    run("layout.select", { stack: "panel-body", child: id });
    run("layout.show", { id: "panel" });
  }

  // The Commit Graph of the repo the panels show.
  openGraph(cx) {
    const c = ctx();
    if (!c.cwd) return notify({ title: "No repo to graph", body: "Pick a repo in Workspace, or focus a terminal inside one." });
    cx.spawn(async () => {
      const top = await repoTop(this.tops, c.cwd, c.on);
      if (!top) return notify({ title: "Not a git repository", body: c.cwd });
      showInViewer("vx-graph", { root: top, on: c.on ?? null }, `Graph · ${baseName(top)}`);
    });
  }

  render() {
    const t = theme();
    const space = spaces().find((s) => s.active);
    const shown = space?.tabs ?? [];
    const active = shown.findIndex((tab) => tab.active);
    if (shown[active]?.id !== this.selected || active !== this.selectedIndex) {
      this.selected = shown[active]?.id;
      this.selectedIndex = active;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action, tip) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim)
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const lead = panes().find((p) => p.tab === c.id && p.program?.agent) ?? panes().find((p) => p.tab === c.id);
      const program = lead?.program;
      const name = tabLabel(c, lead);
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        .when(i <= active, (el) => el.on_size_change((_s, cx) => { this.scroll.scroll_to_item(active); cx.notify(); }))
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed;
          this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: shown.findIndex((x) => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), (el) => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", (el) => el.child(Icon("spinner", 12).text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", (el) => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, (el) => el.child(div().id(`close-${c.id}`).text_color(t.dim).hover((s) => s.text_color(t.foreground))
          .on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); })
          .child(Icon("x", 12))));
    };
    const root = layout();
    const sidebar = find(root, "sidebar");
    const w = window();
    const lights = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel");
    const body = find(root, "panel-body");
    this.syncPanel(space, panel, body);
    const present = new Set((body?.children ?? []).map((c) => c.id));
    const panelButton = ([id, label, icon]) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6).text_size(12)
        .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
        .on_mouse_down("left", stop)
        .on_click(() => (on ? run("layout.hide", { id: "panel" }) : this.showPanel(id)))
        .child(Icon(icon, 14)).child(label);
    };
    return h_flex().size_full().min_w(0).px(10).pl(lights).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel((e) => this.wheel(e))
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().track_scroll(this.scroll)
        .on_size_change((_s, cx) => { if (active >= 0) { this.scroll.scroll_to_item(active); cx.notify(); } })
        .children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 }), "New terminal or agent"))
      .when(Boolean(this.project), (el) => el.child(div().w(6)).child(this.scriptsControl(t, stop)))
      .child(div().w(1).h(18).mx(6).flex_none().bg(t.border))
      .children(PANELS.filter(([id]) => present.has(id)).map(panelButton))
      .child(h_flex().id("graph").h(26).px(8).gap(5).flex_none().items_center().rounded(6).text_size(12).text_color(t.muted)
        .hover((s) => s.bg(t.hover)).tooltip("Commit Graph of the repo the panels show").on_mouse_down("left", stop)
        .on_click((_e, cx) => this.openGraph(cx)).child(Icon("git-commit", 14)).child("Graph"))
      .when(Boolean(w?.buttons), (el) => el
        .child(button("minimize", "−", () => run("window.minimize")))
        .child(button("maximize", "□", () => run("window.maximize")))
        .child(button("close-window", Icon("x", 13), () => run("window.close"))));
  }
}

export default VxTabs;
