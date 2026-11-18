import { View, div, image } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, layout, settings, checking, props, shared, setShared, nextCommand, home } from "herdr";
import { ctx, contextKey, repoTop, baseName, workspace, rootFor, setActive } from "./ws.js";
import { PM_ICON, findProject, pmOf, chosenOf, allScripts, runScript } from "./scripts.js";
import { Icon, FileIcon, RootIcon, TEXT, ConfirmView } from "./ui.js";
import { showInViewer, keptTabs, viewerValue } from "./tabs.js";
import { describeTab, tabIcon, repoColor } from "./kinds.js";
import { popupMethods, postTabs } from "./popups.js";
import { loadIcons } from "./icons.js";
import { findNode } from "./layout-core.js";
import { logInfo, toast } from "./log.js";
import { askConfirm, confirmMethods } from "./actions.js";
import { isUntitledName, untitledDirtyKey, nextUntitledNumber, UNTITLED_PREFIX, UNTITLED_COUNTER_KEY, isEmptyEditorTab, closeDetail } from "./untitled-core.js";
import { whenSettings } from "./settings.js";

class HerdrVscodeTabs extends View {
  static MOD = "herdr-vscode-tabs";
  static PANELS = [["files", "Files", "file"], ["changes", "Changes", "branch"], ["ci", "CI", "ci"]];
  static VIEWER_MODS = ["herdr-vscode-files", "herdr-vscode-changes"];
  static FOLLOW_MS = 400;
  static SCRIPTS_RESCAN_MS = 15000;
  static PRUNE_MS = 5000;
  static PANEL_SETTLE_MS = 1000;
  static MRU_LIMIT = 30;
  static SWIPE_RESET_MS = 250;
  static SWIPE_FIRST_STEP = 20;
  static SWIPE_NEXT_STEP = 60;
  static SWIPE_MIN_INTERVAL_MS = 100;
  static TRAFFIC_LIGHTS_EXTRA = 64;
  static EDGE_PADDING = 10;
  static SHORT_SHA = 7;
  static MAX_SCRIPT_ROWS = 16;
  static SCRIPTS_MENU_BASE_HEIGHT = 112;
  static SCRIPTS_MENU_ROW_HEIGHT = 36;
  static KEY_MRU = "herdr-vscode.tabs.mru";
  static KEY_CMD = "herdr-vscode.tabs.cmd";
  static KEY_KEPT = "herdr-vscode.tabs.kept";
  static KEY_PINNED = "herdr-vscode.tabs.pinned";
  static KEY_DIRTY = "herdr-vscode.dirty";
  static TRANSIENT_VIEWER_FIELDS = ["at", "opening", "line"];

  static isFileKind(kind) {
    return kind === "preview" || kind === "diff";
  }

  static FILES_MOD = "herdr-vscode-files";
  static HERDR_APP = "herdr-app";

  static untitledDirty(tab) {
    return isUntitledName(tab.name) && Boolean(shared(HerdrVscodeTabs.KEY_DIRTY)?.[untitledDirtyKey(tab.name)]);
  }

  // Double-click on the empty tab bar: a new empty buffer in Edit mode, like VS Code.
  static openUntitled(space) {
    const allNames = spaces().flatMap((candidate) => candidate.tabs.map((tab) => tab.name));
    const number = nextUntitledNumber(allNames, shared(UNTITLED_COUNTER_KEY) ?? 0);
    setShared(UNTITLED_COUNTER_KEY, number);
    const name = `${UNTITLED_PREFIX}${number}`;
    const context = ctx();
    const folder = context.root?.path ?? context.cwd ?? space?.folder ?? home();
    run("tab.new", { space: space?.id, name, mod: HerdrVscodeTabs.FILES_MOD, props: { mode: "view", space: space?.id, untitled: { name, folder } } });
  }

  static EMPTY_MOD = "herdr-vscode-empty";
  static EMPTY_SETTLE_MS = 1500;

  static isEmptyTab(tab) {
    return isEmptyEditorTab(tab.id, panes(), HerdrVscodeTabs.EMPTY_MOD);
  }

  static runsProgram(tab) {
    return panes().some((pane) => pane.tab === tab.id && pane.terminal && (pane.program?.agent || !pane.program?.shell));
  }

  static spaceOf(tab) {
    return spaces().find((space) => (space.tabs ?? []).some((candidate) => candidate.id === tab.id));
  }

  // Closing the last tab keeps the space: the empty editor takes its place (a running program still asks).
  static keepSpace(tab) {
    const space = HerdrVscodeTabs.spaceOf(tab);
    const others = (space?.tabs ?? []).filter((candidate) => candidate.id !== tab.id);
    if (!space || others.length > 0 || HerdrVscodeTabs.runsProgram(tab)) {
      return;
    }
    HerdrVscodeTabs.emptyOpenedAt = Date.now();
    run("tab.new", { space: space.id, name: "Welcome", mod: HerdrVscodeTabs.EMPTY_MOD });
  }

  // The empty editor leaves as soon as anything else opens in its space.
  static closeStaleEmpty() {
    if (Date.now() - (HerdrVscodeTabs.emptyOpenedAt ?? 0) < HerdrVscodeTabs.EMPTY_SETTLE_MS) {
      return;
    }
    for (const space of spaces()) {
      const tabs = space.tabs ?? [];
      const empties = tabs.filter((tab) => HerdrVscodeTabs.isEmptyTab(tab));
      if (empties.length > 0 && empties.length < tabs.length) {
        empties.forEach((tab) => {
          logInfo(HerdrVscodeTabs.MOD, "tab.close", closeDetail(tab, panes(), "stale empty editor"));
          run("tab.close", { id: tab.id, confirmed: true });
        });
      }
    }
  }

  // An Untitled tab with text asks before its buffer is thrown away.
  static closeTab(tab, reason = "close") {
    HerdrVscodeTabs.keepSpace(tab);
    if (!HerdrVscodeTabs.untitledDirty(tab)) {
      logInfo(HerdrVscodeTabs.MOD, "tab.close", closeDetail(tab, panes(), reason));
      run("tab.close", { id: tab.id });
      return;
    }
    logInfo(HerdrVscodeTabs.MOD, "tab.close asks to discard", closeDetail(tab, panes(), reason));
    askConfirm(HerdrVscodeTabs.MOD, {
      title: `Discard ${tab.name}?`,
      detail: "It was never saved. Its text is lost when the tab closes.",
      label: "Discard",
      danger: true,
      action: { doing: "Closing", done: "Closed", steps: [{ cmd: HerdrVscodeTabs.HERDR_APP, args: ["do", "tab.close", "--id", tab.id] }] },
    });
  }

  static activeSpace() {
    return spaces().find((s) => s.active);
  }

  init(given, cx) {
    const options = props() ?? given ?? {};
    whenSettings(cx);
    if (options.confirm) {
      this.confirmSpec = options.confirm;
      this.confirmFocus = cx.focus_handle();
      this.confirmFocus.focus();
      return;
    }
    loadIcons(this, cx);
    if (options.menu) {
      this.menu = options.menu;
      return;
    }
    if (options.breadcrumbs) {
      this.crumbs = true;
      if (!checking()) {
        cx.timer.every(HerdrVscodeTabs.FOLLOW_MS, (cx) => cx.notify());
      }
      return;
    }
    if (options.list || options.overlay) {
      this.listFocus = cx.focus_handle();
      // mod.open:herdr-vscode-tabs (a key) opens the switcher.
      this.initList(options.list ? options : { list: { mode: "switch" } }, cx);
      return;
    }
    this.initBar(options, cx);
  }

  initBar(options, cx) {
    this.style = options.style === "vscode" ? "vscode" : "pill";
    this.pressed = null;
    this.project = null;
    this.scroll = ScrollHandle.new();
    this.tops = new Map();
    this.swipe = { acc: 0, steps: 0, at: 0, last: 0 };
    try {
      this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}") ?? {};
    } catch {
      this.panels = {};
    }
    if (checking()) {
      return;
    }
    this.cmdSeen = shared(HerdrVscodeTabs.KEY_CMD)?.id ?? null;
    cx.timer.every(HerdrVscodeTabs.FOLLOW_MS, (cx) => this.follow(cx));
    cx.timer.every(HerdrVscodeTabs.SCRIPTS_RESCAN_MS, (cx) => { this.scriptsKey = null; this.detectScripts(cx); });
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "switch") {
          this.openSwitcher();
        }
        if (command === "list") {
          this.openList();
        }
        if (command === "untitled") {
          HerdrVscodeTabs.openUntitled(HerdrVscodeTabs.activeSpace());
        }
        if (command === "close") {
          const tab = HerdrVscodeTabs.activeSpace()?.tabs?.find((candidate) => candidate.active);
          if (tab) {
            HerdrVscodeTabs.closeTab(tab, "command close");
          }
        }
        cx.notify();
      }
    });
  }

  follow(cx) {
    this.detectScripts(cx);
    this.recordRecentTab();
    this.applyPostedCommand();
    this.pruneClosedTabs();
    HerdrVscodeTabs.closeStaleEmpty();
  }

  recordRecentTab() {
    const space = HerdrVscodeTabs.activeSpace();
    const tab = space?.tabs?.find((t) => t.active)?.id;
    if (!space || !tab) {
      return;
    }
    const mru = shared(HerdrVscodeTabs.KEY_MRU) ?? {};
    if (mru[space.id]?.[0] === tab) {
      return;
    }
    const order = [tab, ...(mru[space.id] ?? []).filter((id) => id !== tab)].slice(0, HerdrVscodeTabs.MRU_LIMIT);
    setShared(HerdrVscodeTabs.KEY_MRU, { ...mru, [space.id]: order });
  }

  applyPostedCommand() {
    const posted = shared(HerdrVscodeTabs.KEY_CMD);
    if (!posted?.id || posted.id === this.cmdSeen) {
      return;
    }
    this.cmdSeen = posted.id;
    if (posted.cmd === "keep") {
      this.keep(posted.tab);
    }
    if (posted.cmd === "pin") {
      this.pin(posted.tab, true);
    }
    if (posted.cmd === "unpin") {
      this.pin(posted.tab, false);
    }
  }

  pruneClosedTabs() {
    if (this.pruneAt && Date.now() - this.pruneAt <= HerdrVscodeTabs.PRUNE_MS) {
      return;
    }
    this.pruneAt = Date.now();
    const live = new Set(spaces().flatMap((s) => (s.tabs ?? []).map((t) => t.id)));
    for (const key of [HerdrVscodeTabs.KEY_KEPT, HerdrVscodeTabs.KEY_PINNED]) {
      const map = shared(key) ?? {};
      const kept = Object.fromEntries(Object.entries(map).filter(([id]) => live.has(id)));
      if (Object.keys(kept).length !== Object.keys(map).length) {
        setShared(key, kept);
      }
    }
  }

  // The preview's copy (herdr-vscode-files / herdr-vscode-changes) follows herdr-vscode.tabs.kept from then on; the next file opened gets a fresh preview.
  keep(tabId) {
    const space = HerdrVscodeTabs.activeSpace();
    const pane = panes().find((p) => p.tab === tabId && HerdrVscodeTabs.VIEWER_MODS.includes(p.mod));
    if (!space || !pane || keptTabs()[tabId]) {
      return;
    }
    const value = viewerValue(pane.mod, space.id);
    if (!value) {
      return;
    }
    const rest = { ...value };
    for (const field of HerdrVscodeTabs.TRANSIENT_VIEWER_FIELDS) {
      delete rest[field];
    }
    setShared(HerdrVscodeTabs.KEY_KEPT, { ...keptTabs(), [tabId]: { mod: pane.mod, value: rest } });
  }

  pin(tabId, on) {
    const pinned = { ...(shared(HerdrVscodeTabs.KEY_PINNED) ?? {}) };
    if (on) {
      const count = Object.keys(pinned).length;
      pinned[tabId] = true;
      run("tab.move", { id: tabId, index: count + 1 });
    } else {
      delete pinned[tabId];
    }
    setShared(HerdrVscodeTabs.KEY_PINNED, pinned);
  }

  openSwitcher() {
    openOverlay({ mod: HerdrVscodeTabs.MOD, kind: "dialog", width: 520, height: 420, props: { list: { mode: "switch" } } });
  }

  openList() {
    openOverlay({ mod: HerdrVscodeTabs.MOD, kind: "popup", width: 420, height: 420, props: { list: { mode: "list" } } });
  }

  // One wheel notch, or a short swipe, moves one tab; further steps need a longer swipe.
  wheel(event) {
    if (event.delta_lines) {
      if (event.delta_lines.y) {
        run(event.delta_lines.y > 0 ? "tab.prev" : "tab.next");
      }
      return;
    }
    const swipe = this.swipe;
    const now = Date.now();
    if (event.touch_phase === "started" || now - swipe.at > HerdrVscodeTabs.SWIPE_RESET_MS || event.delta.y * swipe.acc < 0) {
      Object.assign(swipe, { acc: 0, steps: 0 });
    }
    swipe.at = now;
    swipe.acc += event.delta.y;
    const need = swipe.steps ? HerdrVscodeTabs.SWIPE_NEXT_STEP : HerdrVscodeTabs.SWIPE_FIRST_STEP;
    if (Math.abs(swipe.acc) < need || now - swipe.last < HerdrVscodeTabs.SWIPE_MIN_INTERVAL_MS) {
      return;
    }
    swipe.acc -= Math.sign(swipe.acc) * need;
    swipe.steps++;
    swipe.last = now;
    run(event.delta.y > 0 ? "tab.prev" : "tab.next");
  }

  // The right-panel buttons remember each space's open panel.
  syncPanel(space, panel, body) {
    if (!space || !panel) {
      return;
    }
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space && this.restorePanel(space, now)) {
      return;
    }
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) {
        return;
      }
      this.pending = null;
    }
    if (this.panels[space.id] === now) {
      return;
    }
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  // Returns true while a restore is in flight, so the stale panel state isn't recorded.
  restorePanel(space, now) {
    const first = this.space === undefined;
    this.space = space.id;
    this.pending = null;
    if (first && !(space.id in this.panels)) {
      return false;
    }
    const stored = this.panels[space.id] ?? null;
    const want = HerdrVscodeTabs.PANELS.some(([id]) => id === stored) ? stored : null;
    if (want === now) {
      return false;
    }
    this.pending = { want, until: Date.now() + HerdrVscodeTabs.PANEL_SETTLE_MS };
    if (want) {
      this.showPanel(want);
    } else {
      run("layout.hide", { id: "panel" });
    }
    return true;
  }

  showPanel(id) {
    run("layout.select", { stack: "panel-body", child: id });
    run("layout.show", { id: "panel" });
  }

  openGraph(cx) {
    const context = ctx();
    if (!context.cwd) {
      return toast("herdr-vscode-tabs", { title: "No repo to graph", body: "Pick a repo in the Explorer, or focus a terminal inside one." });
    }
    cx.spawn(async () => {
      const top = await repoTop(this.tops, context.cwd, context.on);
      if (!top) {
        return toast("herdr-vscode-tabs", { title: "Not a git repository", body: context.cwd });
      }
      showInViewer("herdr-vscode-graph", { root: top, on: context.on ?? null }, `Graph · ${baseName(top)}`);
    });
  }

  detectScripts(cx) {
    const context = ctx();
    const key = contextKey(context);
    if (key === this.scriptsKey || this.scanning) {
      return;
    }
    this.scriptsKey = key;
    this.scanning = true;
    cx.spawn(async (cx) => {
      try {
        const top = context.cwd ? await repoTop(this.tops, context.cwd, context.on) : null;
        const followsFocus = context.source === "focus" || context.source === "repo";
        const start = followsFocus ? context.cwd : top ?? context.cwd;
        const project = start ? await findProject(start, context.on) : null;
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
    const project = this.project;
    if (!project) {
      return null;
    }
    const chosen = chosenOf(project);
    const manager = pmOf(project);
    const scriptCount = allScripts(project).length;
    const rows = Math.min(HerdrVscodeTabs.MAX_SCRIPT_ROWS, scriptCount + project.groups.length);
    const menuHeight = HerdrVscodeTabs.SCRIPTS_MENU_BASE_HEIGHT + rows * HerdrVscodeTabs.SCRIPTS_MENU_ROW_HEIGHT;
    return h_flex().flex_none().items_center()
      .child(h_flex().id("sc-pick").h(24).max_w(150).px(7).gap(5).items_center().rounded_l(5).border_1().border_color(t.border).bg(t.background)
        .cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(`${project.name}: ${scriptCount} scripts · ${manager}\n${manager} run ${chosen.s.name}\n${chosen.s.cmd}`)
        .on_mouse_down("left", stop)
        .on_click(() => openOverlay({ mod: "herdr-vscode-scripts", kind: "popup", width: 420, height: menuHeight, props: { menu: { project } } }))
        .child(image(PM_ICON(manager)).size(13).flex_none())
        .child(div().truncate().text_size(12).text_color(t.foreground).child(chosen.s.name))
        .child(Icon("chevron-down", 11).text_color(t.dim)))
      .child(div().id("sc-run").h(24).w(26).flex().items_center().justify_center().rounded_r(5).border_1().border_color(t.border).bg(t.background)
        .text_color(t.ansi2).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(`Run ${chosen.s.name} in a new tab`)
        .on_mouse_down("left", stop).on_click(() => runScript(project, chosen))
        .child(Icon("play", 11)));
  }

  static tabFile(described) {
    const value = described.value;
    const rel = value?.rel ?? value?.path;
    return value?.root && rel ? `${value.root}/${rel}` : null;
  }

  static statusMark(t, tab) {
    if (tab.status === "working") {
      return Icon("spinner", 12).text_color(t.working).spin(900);
    }
    if (tab.status === "blocked" || tab.status === "done") {
      return div().size(7).rounded(4).bg(t[tab.status]);
    }
    return null;
  }

  static tabTooltip(described, pinned, italic) {
    let hint = "";
    if (pinned) {
      hint = "pinned";
    } else if (italic) {
      hint = "preview: double-click to keep";
    }
    return [described.label, described.context, hint].filter(Boolean).join("\n");
  }

  pressTab(event, cx, tab, index, italic) {
    cx.stop_propagation();
    this.pressed = index;
    if (event.click_count !== 2) {
      return;
    }
    if (italic) {
      postTabs({ cmd: "keep", tab: tab.id });
    } else {
      run("tab.rename", { id: tab.id });
    }
  }

  releaseTab(tab, index, shown) {
    const from = this.pressed;
    this.pressed = null;
    if (from !== null && from !== index) {
      run("tab.move", { id: shown[from].id, index: shown.findIndex((x) => x.id === tab.id) + 1 });
    } else {
      run("tab.select", { id: tab.id });
    }
  }

  hoverTab(tabId, hovering, cx) {
    if (hovering) {
      this.hovered = tabId;
    } else if (this.hovered === tabId) {
      this.hovered = null;
    }
    cx.notify();
  }

  styleTab(el, t, tab, pinned) {
    if (this.style === "vscode") {
      return el.h_full().pl(HerdrVscodeTabs.EDGE_PADDING).pr(pinned ? 10 : 6).relative().border_r(1).border_color(t.border)
        .bg(tab.active ? t.background : t.chrome).text_color(tab.active ? t.foreground : t.muted)
        .when(!tab.active, (inner) => inner.hover((s) => s.bg(t.hover)));
    }
    return el.h(29).px(10).rounded(7).border(1).border_color(tab.active ? t.border : t.chrome).bg(tab.active ? t.raised : t.chrome)
      .text_color(tab.active ? t.foreground : t.muted).hover((s) => s.bg(t.hover));
  }

  tabTrailing(t, tab, stop, { showClose, dirty, status }) {
    if (showClose) {
      return div().id(`close-${tab.id}`).size(18).flex().items_center().justify_center().rounded(4).text_color(t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); HerdrVscodeTabs.closeTab(tab, "tab close button"); })
        .child(Icon("x", 12));
    }
    if (dirty) {
      return div().size(8).rounded(4).bg(t.foreground);
    }
    return status ?? div();
  }

  tabEl(t, tab, index, shown, active, space, stop) {
    const described = describeTab(tab, space.id);
    const pinned = Boolean(shared(HerdrVscodeTabs.KEY_PINNED)?.[tab.id]);
    const italic = HerdrVscodeTabs.isFileKind(described.kind) && described.preview;
    const color = repoColor(described.repo, t);
    const file = HerdrVscodeTabs.tabFile(described);
    const dirty = Boolean(file && shared(HerdrVscodeTabs.KEY_DIRTY)?.[file]) || HerdrVscodeTabs.untitledDirty(tab);
    const showClose = !pinned && (this.hovered === tab.id || (tab.active && !dirty));
    const status = HerdrVscodeTabs.statusMark(t, tab);
    const el = h_flex().id(`tab-${tab.id}`).flex_none().items_center().gap(6).text_size(12.8)
      .when(index <= active, (inner) => inner.on_size_change((_s, cx) => { this.scroll.scroll_to_item(active); cx.notify(); }))
      .tooltip(HerdrVscodeTabs.tabTooltip(described, pinned, italic))
      .on_hover((hovering, cx) => this.hoverTab(tab.id, hovering, cx))
      .on_mouse_down("left", (event, cx) => this.pressTab(event, cx, tab, index, italic))
      .on_mouse_up("left", () => this.releaseTab(tab, index, shown))
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: HerdrVscodeTabs.MOD, kind: "popup", width: 240, height: 300, props: { menu: { tab: tab.id, preview: italic } } });
      });
    this.styleTab(el, t, tab, pinned)
      .when(Boolean(color) && !pinned, (inner) => inner.child(div().w(3).h(14).flex_none().rounded(2).bg(color)))
      .child(tabIcon(described, this.icons, 14));
    if (pinned) {
      return el.when(Boolean(status), (inner) => inner.child(status));
    }
    return el
      .child(div().max_w(170).truncate().when(italic, (inner) => inner.italic()).child(tab.zoomed ? `${described.label} Z` : described.label))
      .when(Boolean(described.context) && described.context !== described.label,
        (inner) => inner.child(div().max_w(140).truncate().text_size(11.5).text_color(t.dim).child(described.context)))
      .child(div().w(18).flex_none().flex().items_center().justify_center()
        .child(this.tabTrailing(t, tab, stop, { showClose, dirty, status })));
  }

  // Root path, folder parts and file of the active tab, or null when there's nothing to show.
  static crumbPath(described, roots) {
    if (HerdrVscodeTabs.isFileKind(described.kind) && described.value?.root) {
      return { rootPath: described.value.root, parts: (described.file ?? "").split("/").filter(Boolean), fileIcon: described.file };
    }
    const cwd = described.lead?.cwd;
    if (!cwd) {
      return null;
    }
    const root = rootFor(cwd, roots);
    if (root) {
      return { rootPath: root.path, parts: cwd.slice(root.path.length).split("/").filter(Boolean), fileIcon: null };
    }
    return { rootPath: null, parts: cwd.replace(home(), "~").split("/").filter(Boolean), fileIcon: null };
  }

  static crumb(t, id, label, { icon, tip, onClick, last } = {}) {
    return h_flex().id(id).h(20).px(3).gap(4).flex_none().items_center().rounded(4)
      .text_color(last ? t.foreground : t.muted).when(Boolean(tip), (el) => el.tooltip(tip))
      .when(Boolean(onClick), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { onClick(); cx.notify(); }))
      .when(Boolean(icon), (el) => el.child(icon)).child(div().max_w(220).truncate().child(label));
  }

  static revealRoot(root, roots) {
    if (roots.some((candidate) => candidate.path === root.path)) {
      setActive(root, "pick");
    }
    run("layout.select", { stack: "sidebar-views", child: "explorer" });
    run("layout.show", { id: "sidebar" });
  }

  static diffScope(value) {
    return value.scope === "commit" ? `@ ${String(value.sha ?? "").slice(0, HerdrVscodeTabs.SHORT_SHA)}` : value.scope;
  }

  renderCrumbs() {
    const t = theme();
    const space = HerdrVscodeTabs.activeSpace();
    const tab = space?.tabs?.find((x) => x.active);
    const bar = h_flex().id("herdr-vscode-crumbs").size_full().px(12).gap(2).items_center().overflow_hidden().bg(t.background).text_size(TEXT.small).text_color(t.muted);
    if (!tab) {
      return bar;
    }
    const described = describeTab(tab, space.id);
    if (described.kind === "graph") {
      return bar.child(Icon("git-commit", 13).text_color(t.accent)).child(div().pl(4).child(tab.name));
    }
    const roots = workspace()?.roots ?? [];
    const path = HerdrVscodeTabs.crumbPath(described, roots);
    if (!path) {
      return bar;
    }
    const { rootPath, parts, fileIcon } = path;
    const root = rootPath ? rootFor(rootPath, roots) ?? { name: baseName(rootPath), path: rootPath } : null;
    const items = [];
    if (root) {
      const inTerminal = described.kind === "agent" || described.kind === "terminal";
      items.push(HerdrVscodeTabs.crumb(t, "cr-root", root.name, {
        icon: inTerminal ? Icon("terminal", 13).text_color(t.dim) : RootIcon(false, 13),
        tip: `${root.path}\nShow in the Explorer`,
        onClick: () => HerdrVscodeTabs.revealRoot(root, roots),
      }));
    }
    parts.forEach((part, index) => {
      const last = index === parts.length - 1;
      if (items.length) {
        items.push(Icon("chevron-right", 12).text_color(t.dim));
      }
      items.push(HerdrVscodeTabs.crumb(t, `cr-${index}`, part, { last, icon: last && fileIcon ? FileIcon(this.icons, fileIcon, { size: 13 }) : null }));
    });
    if (described.kind === "diff" && described.value?.scope) {
      items.push(div().pl(6).text_size(TEXT.caption).text_color(t.dim).child(HerdrVscodeTabs.diffScope(described.value)));
    }
    return bar.children(items);
  }

  lightsPadding(root, win, vs) {
    const sidebar = findNode(root, "sidebar");
    if (vs || win?.platform !== "macos" || win.titlebar !== "none" || win.fullscreen || !root?.traffic_lights) {
      return HerdrVscodeTabs.EDGE_PADDING;
    }
    const sidebarWidth = sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0;
    return Math.max(HerdrVscodeTabs.EDGE_PADDING, (root.traffic_lights[0] + HerdrVscodeTabs.TRAFFIC_LIGHTS_EXTRA) / settings().zoom - sidebarWidth);
  }

  followSelection(shown, active) {
    if (shown[active]?.id === this.selected && active === this.selectedIndex) {
      return;
    }
    this.selected = shown[active]?.id;
    this.selectedIndex = active;
    if (active >= 0) {
      this.scroll.scroll_to_item(active);
    }
  }

  panelButtons(t, root, stop) {
    const panel = findNode(root, "panel");
    const body = findNode(root, "panel-body");
    const present = new Set((body?.children ?? []).map((child) => child.id));
    const panelButton = ([id, label, icon]) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6).text_size(12)
        .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
        .on_mouse_down("left", stop)
        .on_click(() => (on ? run("layout.hide", { id: "panel" }) : this.showPanel(id)))
        .child(Icon(icon, 14)).child(label);
    };
    return HerdrVscodeTabs.PANELS.filter(([id]) => present.has(id)).map(panelButton);
  }

  render() {
    if (this.confirmSpec) {
      return ConfirmView(this);
    }
    if (this.menu) {
      return this.renderMenu();
    }
    if (this.crumbs) {
      return this.renderCrumbs();
    }
    if (this.list) {
      return this.renderList();
    }
    const t = theme();
    const space = HerdrVscodeTabs.activeSpace();
    const shown = (space?.tabs ?? []).filter((x) => !x.settled && !HerdrVscodeTabs.isEmptyTab(x));
    const active = shown.findIndex((x) => x.active);
    this.followSelection(shown, active);
    const stop = (_e, cx) => cx.stop_propagation();
    const vs = this.style === "vscode";
    const button = (id, label, action, tip) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim)
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop).on_click(action).child(label);
    const root = layout();
    const win = window();
    const lights = this.lightsPadding(root, win, vs);
    this.syncPanel(space, findNode(root, "panel"), findNode(root, "panel-body"));
    const panelButtons = this.panelButtons(t, root, stop);
    return h_flex().size_full().min_w(0).pl(lights).pr(vs ? 6 : 10).gap(vs ? 0 : 3).items_center().bg(t.chrome).when(vs, (el) => el.rounded_t(11)).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel((event) => this.wheel(event))
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(vs ? 0 : 3).overflow_x_scrollbar().track_scroll(this.scroll)
        .on_size_change((_s, cx) => {
          if (active >= 0) {
            this.scroll.scroll_to_item(active);
            cx.notify();
          }
        })
        .children(shown.map((tab, index) => this.tabEl(t, tab, index, shown, active, space, stop)))
        .when(vs, (el) => el.child(div().id("tab-empty").flex_1().min_w(24).h_full()
          .on_click((event) => {
            if (event.click_count === 2) {
              HerdrVscodeTabs.openUntitled(space);
            }
          }))))
      .child(button("tab-new", Icon("plus", 14), () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 }), "New terminal or agent"))
      .when(vs, (el) => el.child(button("tab-split", Icon("split", 14), () => run("pane.split", { direction: "right" }), "Split Right")))
      .child(button("tab-list", Icon(vs ? "more" : "chevron-down", 14), () => this.openList(), `All tabs (${shown.length})`))
      .when(Boolean(this.project), (el) => el.child(div().w(6)).child(this.scriptsControl(t, stop)))
      .when(panelButtons.length > 0, (el) => el
        .child(div().w(1).h(18).mx(6).flex_none().bg(t.border))
        .children(panelButtons)
        .child(h_flex().id("graph").h(26).px(8).gap(5).flex_none().items_center().rounded(6).text_size(12).text_color(t.muted)
          .hover((s) => s.bg(t.hover)).tooltip("Commit Graph of the repo the panels show").on_mouse_down("left", stop)
          .on_click((_e, cx) => this.openGraph(cx)).child(Icon("git-commit", 14)).child("Graph")))
      .when(Boolean(win?.buttons) && !vs, (el) => el
        .child(button("minimize", "−", () => run("window.minimize")))
        .child(button("maximize", "□", () => run("window.maximize")))
        .child(button("close-window", Icon("x", 13), () => run("window.close"))));
  }
}

Object.assign(HerdrVscodeTabs.prototype, popupMethods, confirmMethods);
export default HerdrVscodeTabs;
