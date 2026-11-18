import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { theme, layout, run, shared, setShared, agents, nextCommand, notify, checking, props } from "herdr";
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
  static DEFAULT_ACCENT_FOREGROUND = "#ffffff";
  static COLOR_PREFIX = "#";
  static VIEWS = [
    { id: "explorer", icon: "files", title: "Explorer (⌘⇧E)", name: "Explorer" },
    { id: "search", icon: "search", title: "Search (⌘⇧F)", name: "Search" },
    { id: "scm", icon: "branch", title: "Source Control (⌘⇧G)", name: "Source Control" },
    { id: "ci", icon: "ci", title: "CI / CD", name: "CI / CD" },
    { id: "running", icon: "play", title: "Running (⌘⇧R)", name: "Running" },
    { id: "spaces", icon: "layers", title: "Spaces", name: "Spaces" },
    { id: "agents", icon: "bot", title: "Agents", name: "Agents" },
  ];

  init(given, cx) {
    const options = props() ?? given ?? {};
    this.tops = new Map();
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
    const waiting = (agents() ?? []).filter((agent) => VxActivity.WAITING_STATUSES.includes(agent.status)).length;
    return {
      scm: changed ? String(changed > VxActivity.BADGE_MAX ? `${VxActivity.BADGE_MAX}+` : changed) : null,
      ci: ciDot,
      agents: waiting ? String(waiting) : null,
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
    if (this.title) {
      return this.renderTitle();
    }
    const t = theme();
    const stack = findNode(layout(), VxActivity.STACK);
    const present = new Set((stack?.children ?? []).map((child) => child.id));
    const on = this.shown();
    const badges = this.badges(t);
    return v_flex().id("vx-activity").size_full().items_center().bg(t.canvas ?? t.chrome)
      .children(VxActivity.VIEWS.filter((view) => present.has(view.id))
        .map((view) => this.item(t, view.id, view.icon, view.title, on === view.id, () => this.click(view.id), badges[view.id] ?? null)))
      .child(div().flex_1())
      .child(this.item(t, "graph", "git-commit", "Commit Graph of the context repo", false, (cx) => this.openGraph(cx), null))
      .child(this.item(t, "settings", "gear", "Settings", false, () => run("app.settings"), null));
  }
}

export default VxActivity;
