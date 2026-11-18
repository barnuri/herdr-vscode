import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { theme, layout, run, shared, setShared, agents, nextCommand, notify, checking, props, openOverlay, closeOverlay } from "herdr";
import { ctx, repoTop, baseName, workspace } from "./ws.js";
import { showInViewer } from "./tabs.js";
import { Icon } from "./ui.js";
import { findNode } from "./layout-core.js";

class VxActivity extends View {
  static STACK = "sidebar-views";
  static SIDEBAR = "sidebar";
  static BOTTOM = "bottom";
  static PANEL_KEY = "vx.panel";
  static TITLE_REFRESH_MS = 300;
  static BADGE_REFRESH_MS = 1500;
  static PANEL_ACTION_DELAY_MS = 600;
  static BADGE_MAX = 999;
  static PANEL_VIEWS = ["problems", "terminal", "ports"];
  static WAITING_STATUSES = ["blocked", "done"];
  static WORKING_STATUS = "working";
  static PREFS_KEY = "vx.activity";
  static EXPLORER_SECTIONS = [
    { id: "timeline", icon: "history", name: "Explorer: Timeline" },
    { id: "npm", icon: "play", name: "Explorer: NPM Scripts" },
  ];
  static MENU_WIDTH = 220;
  static MENU_ROW_PX = 26;
  static MENU_PAD_PX = 12;
  static DROP_BAR_PX = 2;
  static END_TARGET = "end";
  static DEFAULT_ACCENT_FOREGROUND = "#ffffff";
  static COLOR_PREFIX = "#";
  static VIEWS = [
    { id: "explorer", icon: "files", title: "Explorer (⌘⇧E)", name: "Explorer" },
    { id: "search", icon: "search", title: "Search (⌘⇧F)", name: "Search" },
    { id: "scm", icon: "branch", title: "Source Control (⌘⇧G)", name: "Source Control" },
    { id: "history", icon: "history", title: "Git History", name: "Git History" },
    { id: "ci", icon: "ci", title: "CI / CD", name: "CI / CD" },
    { id: "running", icon: "play", title: "Running (⌘⇧R)", name: "Running" },
    { id: "spaces", icon: "layers", title: "Spaces", name: "Spaces" },
    { id: "agents", icon: "bot", title: "Agents", name: "Agents" },
  ];

  init(given, cx) {
    const options = props() ?? given ?? {};
    this.tops = new Map();
    if (options.visibilityMenu) {
      this.visibilityMenu = true;
      return;
    }
    if (options.title) {
      this.title = true;
      if (!checking()) {
        cx.timer.every(VxActivity.TITLE_REFRESH_MS, (cx) => cx.notify());
      }
      return;
    }
    if (checking()) {
      return;
    }
    cx.timer.every(VxActivity.BADGE_REFRESH_MS, (cx) => cx.notify());
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        this.handleCommand(command, cx);
        cx.notify();
      }
    });
  }

  handleCommand(command, cx) {
    if (VxActivity.VIEWS.some((view) => view.id === command)) {
      this.show(command);
    }
    if (command === "panel") {
      this.togglePanel();
    }
    // The bottom panel's tabs and actions, from anywhere (its header only hears keys while shown).
    if (VxActivity.PANEL_VIEWS.includes(command)) {
      this.panelView(command);
    }
    if (command === "checks") {
      this.panelView("problems", "vx-panel.checks", cx);
    }
    if (command === "newterm") {
      this.panelView("terminal", "vx-panel.new", cx);
    }
  }

  shown() {
    const root = layout();
    const side = findNode(root, VxActivity.SIDEBAR);
    if (!side || side.hidden) {
      return null;
    }
    return findNode(root, VxActivity.STACK)?.active ?? null;
  }

  show(id) {
    run("layout.select", { stack: VxActivity.STACK, child: id });
    run("layout.show", { id: VxActivity.SIDEBAR });
    if (id === "search") {
      run("vx-search.focus");
    }
  }

  click(id) {
    if (this.shown() === id) {
      run("layout.hide", { id: VxActivity.SIDEBAR });
    } else {
      this.show(id);
    }
  }

  // vx-panel starts a shell when it appears with none.
  togglePanel() {
    const bottom = findNode(layout(), VxActivity.BOTTOM);
    if (!bottom) {
      return notify({ title: "No bottom panel in this layout" });
    }
    if (!bottom.hidden) {
      return run("layout.hide", { id: VxActivity.BOTTOM });
    }
    run("layout.show", { id: VxActivity.BOTTOM });
    const panelState = shared(VxActivity.PANEL_KEY);
    if (panelState?.shown) {
      run("pane.focus", { terminal: panelState.shown });
    }
  }

  panelView(view, then, cx) {
    setShared(VxActivity.PANEL_KEY, { ...(shared(VxActivity.PANEL_KEY) ?? {}), view });
    run("layout.show", { id: VxActivity.BOTTOM });
    if (then) {
      cx.timer.after(VxActivity.PANEL_ACTION_DELAY_MS, () => run(then));
    }
  }

  openGraph(cx) {
    const context = ctx();
    if (!context.cwd) {
      return notify({ title: "No repo to graph", body: "Pick a repo in the Explorer, or focus a terminal inside one." });
    }
    cx.spawn(async () => {
      const top = await repoTop(this.tops, context.cwd, context.on);
      if (!top) {
        return notify({ title: "Not a git repository", body: context.cwd });
      }
      showInViewer("vx-graph", { root: top, on: context.on ?? null }, `Graph · ${baseName(top)}`);
    });
  }

  badges(t) {
    const roots = workspace()?.roots ?? [];
    const gitByRoot = shared("vx.git") ?? {};
    const changed = roots.reduce((sum, root) => sum + (gitByRoot[root.path]?.changed ?? 0), 0);
    const ciByRoot = shared("vx.ci.summary") ?? {};
    const kinds = roots.map((root) => ciByRoot[root.path]?.kind).filter(Boolean);
    const ciDot = VxActivity.ciDotColor(kinds, t);
    const all = agents() ?? [];
    const waiting = all.filter((agent) => VxActivity.WAITING_STATUSES.includes(agent.status)).length;
    const working = all.filter((agent) => agent.status === VxActivity.WORKING_STATUS).length;
    return {
      scm: changed ? String(changed > VxActivity.BADGE_MAX ? `${VxActivity.BADGE_MAX}+` : changed) : null,
      ci: ciDot,
      agents: working ? String(working) : null,
      running: waiting ? String(waiting) : null,
    };
  }

  static ciDotColor(kinds, t) {
    if (kinds.includes("failure")) {
      return t.ansi1;
    }
    if (kinds.includes("running")) {
      return t.ansi4;
    }
    return null;
  }

  static prefs() {
    const saved = shared(VxActivity.PREFS_KEY) ?? {};
    return { order: Array.isArray(saved.order) ? saved.order : [], hidden: Array.isArray(saved.hidden) ? saved.hidden : [] };
  }

  static savePrefs(patch) {
    setShared(VxActivity.PREFS_KEY, { ...VxActivity.prefs(), ...patch });
  }

  toggleHidden(id) {
    const hidden = new Set(VxActivity.prefs().hidden);
    if (hidden.has(id)) {
      hidden.delete(id);
    } else {
      hidden.add(id);
    }
    VxActivity.savePrefs({ hidden: [...hidden] });
  }

  openVisibilityMenu() {
    const rows = VxActivity.VIEWS.length + VxActivity.EXPLORER_SECTIONS.length;
    const height = rows * VxActivity.MENU_ROW_PX + VxActivity.MENU_PAD_PX * 2;
    openOverlay({ mod: "vx-activity", kind: "popup", width: VxActivity.MENU_WIDTH, height, props: { visibilityMenu: true } });
  }

  menuRow(t, id, icon, name, checked, onClick) {
    return div().id(`vis-${id}`).h(VxActivity.MENU_ROW_PX).px(8).gap(8).flex().items_center()
      .rounded(4).cursor_pointer().hover((style) => style.bg(t.hover))
      .on_click(onClick)
      .child(div().w(14).flex_none().child(checked ? "✓" : ""))
      .child(Icon(icon, 14))
      .child(div().flex_1().child(name));
  }

  static toggleSection(id) {
    const hidden = Boolean(findNode(layout(), id)?.hidden);
    run(hidden ? "layout.show" : "layout.hide", { id });
  }

  renderVisibilityMenu() {
    const t = theme();
    const hidden = new Set(VxActivity.prefs().hidden);
    const root = layout();
    return v_flex().id("vx-activity-menu").size_full().p(6).bg(t.popover ?? t.surface).text_size(12).text_color(t.foreground)
      .children(this.orderedViews().map((view) => this.menuRow(t, view.id, view.icon, view.name, !hidden.has(view.id), () => this.toggleHidden(view.id))))
      .child(div().h(1).my(5).bg(t.border))
      .children(VxActivity.EXPLORER_SECTIONS.filter((section) => findNode(root, section.id))
        .map((section) => this.menuRow(t, section.id, section.icon, section.name, !findNode(root, section.id).hidden, () => VxActivity.toggleSection(section.id))))
      .on_key_down((event) => {
        if (event.key === "escape") {
          closeOverlay(props()?.overlay);
        }
      });
  }

  orderedViews() {
    const order = VxActivity.prefs().order;
    const position = (id) => {
      const index = order.indexOf(id);
      return index === -1 ? order.length + VxActivity.VIEWS.findIndex((view) => view.id === id) : index;
    };
    return [...VxActivity.VIEWS].sort((left, right) => position(left.id) - position(right.id));
  }

  moveView(from, to) {
    const ids = this.orderedViews().map((view) => view.id).filter((id) => id !== from);
    const index = to === VxActivity.END_TARGET ? ids.length : ids.indexOf(to);
    ids.splice(index, 0, from);
    VxActivity.savePrefs({ order: ids });
  }

  draggable(el, t, id) {
    const target = this.drag && this.drag !== id && this.dropTarget === id;
    return el
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        this.openVisibilityMenu();
      })
      .on_mouse_down("left", () => {
        if (id === VxActivity.END_TARGET) {
          return;
        }
        this.drag = id;
        this.dropTarget = null;
      })
      .on_hover((hovered, cx) => {
        if (this.drag && hovered && this.dropTarget !== id) {
          this.dropTarget = id;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.drag;
        this.drag = null;
        this.dropTarget = null;
        if (from && from !== id) {
          this.moveView(from, id);
        }
        cx.notify();
      })
      .when(target, (item) => item.child(div().absolute().top(0).left(6).right(6).h(VxActivity.DROP_BAR_PX).bg(t.accent)));
  }

  item(t, id, icon, title, on, onClick, badge) {
    const foreground = t.accent_foreground ?? VxActivity.DEFAULT_ACCENT_FOREGROUND;
    const isText = typeof badge === "string" && !badge.startsWith(VxActivity.COLOR_PREFIX);
    const isDot = typeof badge === "string" && badge.startsWith(VxActivity.COLOR_PREFIX);
    return div().id(`act-${id}`).w_full().h(48).flex_none().relative().flex().items_center().justify_center().cursor_pointer()
      .text_color(on ? t.foreground : t.dim).hover((s) => s.text_color(t.foreground)).tooltip(title)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { onClick(cx); cx.notify(); })
      .child(Icon(icon, 22))
      .when(isText, (el) => el.child(div().absolute().right(6).bottom(8).h(15).min_w(15).px(4).rounded(8)
        .flex().items_center().justify_center().bg(t.accent).text_color(foreground).text_size(9.5).font_medium().child(badge)))
      .when(isDot, (el) => el.child(div().absolute().right(10).bottom(11).size(8).rounded(4).bg(badge)));
  }

  renderTitle() {
    const t = theme();
    const view = VxActivity.VIEWS.find((candidate) => candidate.id === findNode(layout(), VxActivity.STACK)?.active);
    return div().id("vx-side-title").size_full().pl(20).pr(8).flex().items_center().bg(t.chrome)
      .text_size(11).font_medium().text_color(t.foreground).child((view?.name ?? "").toUpperCase());
  }

  render() {
    if (this.visibilityMenu) {
      return this.renderVisibilityMenu();
    }
    if (this.title) {
      return this.renderTitle();
    }
    const t = theme();
    const stack = findNode(layout(), VxActivity.STACK);
    const present = new Set((stack?.children ?? []).map((child) => child.id));
    const on = this.shown();
    const badges = this.badges(t);
    const hidden = new Set(VxActivity.prefs().hidden);
    return v_flex().id("vx-activity").size_full().items_center().bg(t.canvas ?? t.chrome)
      .on_mouse_up("left", (_e, cx) => {
        if (this.drag) {
          this.drag = null;
          this.dropTarget = null;
          cx.notify();
        }
      })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        this.openVisibilityMenu();
      })
      .children(this.orderedViews().filter((view) => present.has(view.id) && !hidden.has(view.id))
        .map((view) => this.draggable(this.item(t, view.id, view.icon, view.title, on === view.id, () => this.click(view.id), badges[view.id] ?? null), t, view.id)))
      .child(this.draggable(div().id("act-end").w_full().flex_1().relative(), t, VxActivity.END_TARGET))
      .child(this.item(t, "graph", "git-commit", "Commit Graph of the context repo", false, (cx) => this.openGraph(cx), null))
      .child(this.item(t, "settings", "gear", "Settings", false, () => run("app.settings"), null));
  }
}

export default VxActivity;
