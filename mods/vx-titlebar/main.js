import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, layout, run, window, settings, openOverlay, props, nextCommand, checking, spaces } from "herdr";
import { workspace, ctx } from "./ws.js";
import { quickMethods, QO_ROW, QO_ROWS, QO_HEAD } from "./quickopen.js";
import { emptyNav, navVisit, navStep } from "./nav-core.js";
import { TEXT, Icon } from "./ui.js";
import { loadIcons } from "./icons.js";
import { findNode } from "./layout-core.js";

class VxTitlebar extends View {
  static MOD = "vx-titlebar";
  static DEFAULT_WIDTH = 1200;
  static TRACK_MS = 300;
  static RESIZE_THRESHOLD = 4;
  static DEFAULT_LIGHTS_PADDING = 12;
  static TRAFFIC_LIGHTS_EXTRA = 64;
  static DISABLED_OPACITY = 0.4;
  static QUICK_MIN_WIDTH = 440;
  static QUICK_MAX_WIDTH = 720;
  static QUICK_WIDTH_RATIO = 0.42;
  static QUICK_TOP = 5;
  static QUICK_PADDING = 6;
  static CENTER_MIN_WIDTH = 200;
  static CENTER_MAX_WIDTH = 520;
  static CENTER_WIDTH_RATIO = 0.34;
  static GOTO_PREFIXES = { goto: "", commands: "> ", symbols: "@", line: ":", help: "?" };
  static STEPS = { back: -1, forward: 1 };

  init(given, cx) {
    const options = props() ?? given ?? {};
    loadIcons(this, cx);
    if (options.goto) {
      return this.initQuick(options, cx);
    }
    this.width = VxTitlebar.DEFAULT_WIDTH;
    this.nav = new Map();
    if (checking()) {
      return;
    }
    cx.timer.every(VxTitlebar.TRACK_MS, (cx) => this.track(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        this.handleCommand(command);
        cx.notify();
      }
    });
  }

  handleCommand(command) {
    if (Object.hasOwn(VxTitlebar.GOTO_PREFIXES, command)) {
      this.openGoto(VxTitlebar.GOTO_PREFIXES[command]);
    }
    if (Object.hasOwn(VxTitlebar.STEPS, command)) {
      this.go(VxTitlebar.STEPS[command]);
    }
  }

  track(cx) {
    const space = spaces().find((s) => s.active);
    const tab = space?.tabs?.find((t) => t.active)?.id;
    if (!space || !tab) {
      return;
    }
    const history = this.nav.get(space.id) ?? emptyNav();
    if (history.list[history.at] === tab) {
      return;
    }
    if (this.going === tab) {
      this.going = null;
    } else {
      this.nav.set(space.id, navVisit(history, tab));
    }
    cx.notify();
  }

  stepTarget(step) {
    const space = spaces().find((s) => s.active);
    const history = space && this.nav.get(space.id);
    if (!history) {
      return null;
    }
    return { space, next: navStep(history, step, new Set((space.tabs ?? []).map((t) => t.id))) };
  }

  go(step) {
    const target = this.stepTarget(step);
    if (!target?.next) {
      return;
    }
    this.nav.set(target.space.id, target.next);
    this.going = target.next.list[target.next.at];
    run("tab.select", { id: this.going });
  }

  canGo(step) {
    return Boolean(this.stepTarget(step)?.next);
  }

  // Quick Open sits over the command center, like VS Code's.
  openGoto(query = "") {
    const width = Math.round(Math.min(VxTitlebar.QUICK_MAX_WIDTH, Math.max(VxTitlebar.QUICK_MIN_WIDTH, this.width * VxTitlebar.QUICK_WIDTH_RATIO)));
    openOverlay({
      mod: VxTitlebar.MOD, kind: "popup", width, height: QO_HEAD + QO_ROWS * QO_ROW + VxTitlebar.QUICK_PADDING,
      at: { x: Math.round((this.width - width) / 2), y: VxTitlebar.QUICK_TOP }, props: { goto: { query } },
    });
  }

  static lightsPadding(root, win) {
    const zoom = settings().zoom || 1;
    if (win?.platform === "macos" && !win.fullscreen && root?.traffic_lights) {
      return (root.traffic_lights[0] + VxTitlebar.TRAFFIC_LIGHTS_EXTRA) / zoom;
    }
    return VxTitlebar.DEFAULT_LIGHTS_PADDING;
  }

  render() {
    if (this.quick) {
      return this.renderQuick();
    }
    const t = theme();
    const root = layout();
    const win = window();
    const lights = VxTitlebar.lightsPadding(root, win);
    const stop = (_e, cx) => cx.stop_propagation();
    const ws = workspace();
    const label = ws?.name ?? (ctx().root?.name ?? "Herdr");
    const toggle = (id, icon, tip, on, action) => div().id(`tb-${id}`).size(26).flex_none().flex().items_center().justify_center().rounded(5)
      .text_color(on ? t.foreground : t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", stop).on_click(action).child(Icon(icon, 15));
    const side = findNode(root, "sidebar");
    const bottom = findNode(root, "bottom");
    const right = findNode(root, "panel");
    const center = Math.min(VxTitlebar.CENTER_MAX_WIDTH, Math.max(VxTitlebar.CENTER_MIN_WIDTH, this.width * VxTitlebar.CENTER_WIDTH_RATIO));
    return h_flex().id("vx-titlebar").size_full().items_center().bg(t.canvas ?? t.chrome).text_size(TEXT.small)
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.width) > VxTitlebar.RESIZE_THRESHOLD) {
          this.width = size.width;
          cx.notify();
        }
      })
      .child(h_flex().flex_1().min_w(0).h_full().pl(lights).gap(6).items_center()
        .child(div().id("tb-ws").px(6).h(24).flex().items_center().rounded(5).truncate().text_color(t.muted).font_medium()
          .hover((s) => s.bg(t.hover)).tooltip(ws?.file ? `Workspace: ${ws.file}` : "No workspace open")
          .on_mouse_down("left", stop)
          .on_click(() => { run("layout.select", { stack: "sidebar-views", child: "explorer" }); run("layout.show", { id: "sidebar" }); })
          .child(label)))
      .child(toggle("back", "back", "Go Back", false, () => this.go(-1)).when(!this.canGo(-1), (el) => el.opacity(VxTitlebar.DISABLED_OPACITY)))
      .child(toggle("fwd", "forward", "Go Forward", false, () => this.go(1)).when(!this.canGo(1), (el) => el.opacity(VxTitlebar.DISABLED_OPACITY)))
      .child(div().w(6))
      .child(h_flex().id("tb-cc").w(center).h(24).flex_none().px(8).gap(6).items_center().justify_center().rounded(6)
        .border_1().border_color(t.border).bg(t.input ?? t.background).text_color(t.dim).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.muted)).tooltip("Search files by name (⌘P) · > for commands · ? for help")
        .on_mouse_down("left", stop).on_click(() => this.openGoto())
        .child(Icon("search", 12)).child(div().truncate().child(ws?.file ? `${label} (Workspace)` : label)))
      .child(h_flex().flex_1().min_w(0).h_full().pr(8).gap(2).items_center().justify_end()
        .child(toggle("look", "layout", "Customize Layout (Settings › Look)", false, () => run("app.settings", { section: "look" })))
        .when(Boolean(side), (el) => el.child(toggle("side", "sidebar", "Toggle Side Bar (⌘B)", !side.hidden, () => run("layout.toggle", { id: "sidebar" }))))
        .when(Boolean(bottom), (el) => el.child(toggle("bottom", "panel", "Toggle Panel (⌘J)", !bottom.hidden, () => run("vx-activity.panel"))))
        .when(Boolean(right), (el) => el.child(toggle("right", "panel-right", "Toggle Right Panel", !right.hidden, () => run("layout.toggle", { id: "panel" }))))
        .when(Boolean(win?.buttons), (el) => el
          .child(toggle("min", "minus", "Minimize", false, () => run("window.minimize")))
          .child(toggle("max", "maximize", "Maximize", false, () => run("window.maximize")))
          .child(toggle("close", "x", "Close", false, () => run("window.close")))));
  }
}

Object.assign(VxTitlebar.prototype, quickMethods);
export default VxTitlebar;
