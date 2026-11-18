import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, layout, run, hc, exec, terminals, shared, setShared, nextCommand, notify, checking, props, home } from "herdr";
import { ctx, baseName, workspace, rootFor, setActive, repoTop } from "./ws.js";
import { findProject, pmOf } from "./scripts.js";
import { showInViewer } from "./tabs.js";
import { withContent, findNode } from "./layout-core.js";
import { parsePorts, workspaceProblems, pickChecks, parseCheckOutput, countProblems } from "./panel-core.js";
import { askConfirm, confirmMethods } from "./actions.js";
import { TEXT, Icon, ConfirmView, FileIcon, RootIcon } from "./ui.js";
import { loadIcons } from "./icons.js";

export default class VxPanel extends View {
  static MOD = "vx-panel";
  static STATE_KEY = "vx.panel";
  static CHECKS_KEY = "vx.checks";
  static PORTS_KEY = "vx.ports";
  static TERMINAL_LABEL_KEY = "vx.panel";
  static TERMINAL_LABEL = "vx.panel=1";
  static SIZE = 260;
  static MAXIMIZED_THRESHOLD = 40;
  static MAXIMIZED_SIZE = 2000;
  static PORTS_POLL_MS = 3000;
  static PROBLEMS_REDRAW_MS = 1500;
  static TIDY_MS = 1000;
  static PORT_COUNT_MS = 10000;
  static CHECK_TIMEOUT_MS = 600000;
  static CHECK_NOTIFY_MS = 4000;
  static FAILURE_TAIL_LINES = 2;
  static TRANSPARENT = "#00000000";
  static TERMINAL = "terminal";
  static PROBLEMS = "problems";
  static PORTS = "ports";
  static EMPTY = "empty";
  static VIEWS = [["problems", "Problems"], ["terminal", "Terminal"], ["ports", "Ports"]];
  static LOCAL_HOSTS = ["127.0.0.1", "[::1]", "localhost"];
  static LSOF_LISTEN_ARGS = ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"];
  static NO_PROBLEMS = "No problems in the workspace: no conflicts, no failing pipelines, nothing behind. Run checks to type-check and lint the repo you're in.";

  static {
    Object.assign(VxPanel.prototype, confirmMethods);
  }

  // Shared panel state: { view, shown: terminal address | null, list: [terminal address] }.
  static state() {
    return { view: VxPanel.TERMINAL, shown: null, list: [], ...(shared(VxPanel.STATE_KEY) ?? {}) };
  }

  static liveTerminals() {
    const panelTerminals = (terminals() ?? []).filter((terminal) => terminal.labels?.[VxPanel.TERMINAL_LABEL_KEY] === "1" && terminal.state === "live");
    return new Map(panelTerminals.map((terminal) => [terminal.address, terminal]));
  }

  static problems() {
    return workspaceProblems(workspace()?.roots ?? [], shared("vx.git") ?? {}, shared("vx.ci.summary") ?? {});
  }

  static checks() {
    return shared(VxPanel.CHECKS_KEY) ?? {};
  }

  static setChecks(top, entry) {
    setShared(VxPanel.CHECKS_KEY, { ...VxPanel.checks(), [top]: entry });
  }

  static isMaximized(bottom) {
    return (bottom?.size?.px ?? VxPanel.SIZE) > VxPanel.SIZE + VxPanel.MAXIMIZED_THRESHOLD;
  }

  static plural(count, word) {
    return `${count} ${word}${count === 1 ? "" : "s"}`;
  }

  static groupBy(items, keyOf) {
    const groups = new Map();
    for (const item of items) {
      const key = keyOf(item);
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    return groups;
  }

  static listListeningPorts() {
    return exec("lsof", VxPanel.LSOF_LISTEN_ARGS).catch(() => null);
  }

  init(given, cx) {
    const initProps = props() ?? given ?? {};
    loadIcons(this, cx);
    if (initProps.confirm) {
      this.confirmSpec = initProps.confirm;
      this.confirmOverlay = initProps.overlay;
      this.confirmFocus = cx.focus_handle();
      this.confirmFocus.focus();
      return;
    }
    if (initProps.view || initProps.empty) {
      this.initView(initProps.view ?? VxPanel.EMPTY, cx);
      return;
    }
    if (checking()) {
      return;
    }
    this.tops = new Map();
    cx.timer.every(VxPanel.TIDY_MS, (cx) => this.tidy(cx));
    cx.timer.every(VxPanel.PORT_COUNT_MS, (cx) => this.countPorts(cx));
    this.countPorts(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        await this.handleCommand(await nextCommand(), cx);
        cx.notify();
      }
    });
  }

  initView(view, cx) {
    this.view = view;
    if (checking()) {
      return;
    }
    if (view === VxPanel.PORTS) {
      this.cwds = new Map();
      this.loadPorts(cx);
      cx.timer.every(VxPanel.PORTS_POLL_MS, (cx) => this.loadPorts(cx));
    }
    if (view === VxPanel.PROBLEMS) {
      cx.timer.every(VxPanel.PROBLEMS_REDRAW_MS, (cx) => cx.notify());
    }
  }

  async handleCommand(command, cx) {
    if (command === "new") {
      await this.add(cx);
    }
    if (command === "checks") {
      this.runChecks(cx);
    }
    if (VxPanel.VIEWS.some(([id]) => id === command)) {
      this.pick(command);
    }
  }

  bottom() {
    return findNode(layout(), "bottom");
  }

  want(state) {
    if (state.view === VxPanel.PROBLEMS || state.view === VxPanel.PORTS) {
      return { mod: VxPanel.MOD, props: { view: state.view } };
    }
    return state.shown ? { terminal: state.shown } : { mod: VxPanel.MOD, props: { empty: true } };
  }

  apply(state = VxPanel.state()) {
    const tree = layout();
    const term = findNode(tree, "term");
    if (!term) {
      return;
    }
    const content = this.want(state);
    if (JSON.stringify(term.content) === JSON.stringify(content)) {
      return;
    }
    const next = withContent(tree, "term", content);
    if (next) {
      run("layout.set", { layout: next });
    }
  }

  commit(state) {
    setShared(VxPanel.STATE_KEY, state);
    this.apply(state);
  }

  pick(view) {
    const state = { ...VxPanel.state(), view };
    this.commit(state);
    if (view !== VxPanel.TERMINAL) {
      return;
    }
    if (state.shown) {
      run("pane.focus", { terminal: state.shown });
    } else {
      this.autostart = true;
    }
  }

  // Forgets shells that ended, and starts one when TERMINAL shows with none.
  tidy(cx) {
    const bottom = this.bottom();
    const visible = Boolean(bottom && !bottom.hidden);
    const appeared = visible && !this.wasVisible;
    this.wasVisible = visible;
    const live = VxPanel.liveTerminals();
    const state = VxPanel.state();
    const list = state.list.filter((address) => live.has(address));
    for (const address of live.keys()) {
      if (!list.includes(address)) {
        list.push(address);
      }
    }
    const shown = live.has(state.shown) ? state.shown : list[list.length - 1] ?? null;
    const next = { ...state, shown, list };
    const onTerminal = state.view === VxPanel.TERMINAL;
    if (list.join() !== state.list.join() || shown !== state.shown) {
      setShared(VxPanel.STATE_KEY, next);
      if (state.list.length && !list.length && visible && onTerminal) {
        run("layout.hide", { id: "bottom" });
      }
    }
    this.apply(next);
    const shouldStart = (appeared || this.autostart) && visible && onTerminal && !list.length;
    this.autostart = false;
    if (shouldStart && !this.starting) {
      this.autoAdd(cx);
    }
    cx.notify();
  }

  autoAdd(cx) {
    this.starting = true;
    cx.spawn(async (cx) => {
      try {
        await this.add(cx);
      } finally {
        this.starting = false;
        cx.notify();
      }
    });
  }

  async start() {
    const context = ctx();
    const cwd = context.root?.path ?? context.cwd ?? home();
    const args = ["run", "--bg", "--json", "--keep", "--no-parent", "--outlive-parent", "--no-notify", "--label", VxPanel.TERMINAL_LABEL, "--cwd", cwd];
    if (context.on) {
      args.push("--on", context.on);
    }
    const result = await hc(args);
    if (result.code !== 0) {
      notify({ title: "Couldn't start a panel terminal", body: (result.stderr || result.stdout).trim(), level: "error" });
      return null;
    }
    try {
      return JSON.parse(result.stdout).address ?? null;
    } catch {
      return null;
    }
  }

  async add(_cx) {
    const address = await this.start();
    if (!address) {
      return;
    }
    const state = VxPanel.state();
    this.commit({ ...state, view: VxPanel.TERMINAL, shown: address, list: [...state.list.filter((other) => other !== address), address] });
    run("layout.show", { id: "bottom" });
    run("pane.focus", { terminal: address });
  }

  show(address) {
    this.commit({ ...VxPanel.state(), view: VxPanel.TERMINAL, shown: address });
    run("pane.focus", { terminal: address });
  }

  kill() {
    const state = VxPanel.state();
    if (!state.shown) {
      return;
    }
    run("terminal.kill", { terminal: state.shown });
    const list = state.list.filter((address) => address !== state.shown);
    const next = { ...state, shown: list[list.length - 1] ?? null, list };
    this.commit(next);
    if (!next.shown) {
      run("layout.hide", { id: "bottom" });
    }
  }

  maximize() {
    const px = VxPanel.isMaximized(this.bottom()) ? VxPanel.SIZE : VxPanel.MAXIMIZED_SIZE;
    run("layout.resize", { id: "bottom", px });
  }

  runChecks(cx) {
    if (this.checking) {
      return;
    }
    const context = ctx();
    if (!context.cwd) {
      notify({ title: "No repo to check", body: "Pick a repo in the Explorer, or focus a terminal inside one." });
      return;
    }
    this.checking = true;
    cx.spawn(async (cx) => {
      let top = null;
      try {
        top = (await repoTop(this.tops, context.cwd, context.on)) ?? context.cwd;
        await this.checkRepo(context, top);
      } finally {
        this.checking = false;
        if (top && VxPanel.checks()[top]?.running) {
          VxPanel.setChecks(top, { ...VxPanel.checks()[top], running: null });
        }
        cx.notify();
      }
    });
  }

  async checkRepo(context, top) {
    const project = await findProject(context.root?.path ?? top, context.on);
    const scripts = project ? pickChecks(project.groups[0]?.scripts ?? []) : [];
    if (!project || !scripts.length) {
      VxPanel.setChecks(top, { at: Date.now(), scripts: [], items: [], note: "No typecheck or lint script in package.json." });
      return;
    }
    const pm = pmOf(project);
    VxPanel.setChecks(top, { ...(VxPanel.checks()[top] ?? {}), running: scripts, at: Date.now() });
    const items = [];
    const failed = [];
    for (const name of scripts) {
      const { found, failure } = await this.runCheckScript({ pm, name, project, top, on: context.on });
      items.push(...found);
      if (failure) {
        failed.push(failure);
      }
    }
    VxPanel.setChecks(top, { at: Date.now(), scripts, items, pm, note: failed.join("\n") || null });
    const errors = items.filter((item) => item.level === "error").length;
    const warnings = items.length - errors;
    notify({
      title: `Checks done in ${baseName(top)}`,
      body: `${scripts.join(" + ")}: ${VxPanel.plural(errors, "error")}, ${VxPanel.plural(warnings, "warning")}`,
      level: errors ? "error" : "success",
      timeout: VxPanel.CHECK_NOTIFY_MS,
    });
  }

  async runCheckScript({ pm, name, project, top, on }) {
    const result = await exec("sh", ["-lc", `${pm} run ${name} 2>&1`], { cwd: project.root, on, timeout: VxPanel.CHECK_TIMEOUT_MS })
      .catch((error) => ({ code: -1, stdout: String(error?.message ?? error), stderr: "" }));
    const found = parseCheckOutput(`${result.stdout}\n${result.stderr}`, { root: top, dir: project.root }).map((item) => ({ ...item, script: name }));
    if (result.code === 0 || found.length) {
      return { found, failure: null };
    }
    const tail = (result.stdout || result.stderr).trim().split("\n").slice(-VxPanel.FAILURE_TAIL_LINES).join(" ");
    return { found, failure: `${name} exited ${result.code} with nothing parsed: ${tail}` };
  }

  countPorts(cx) {
    cx.spawn(async () => {
      const result = await VxPanel.listListeningPorts();
      const count = parsePorts(result?.stdout).length;
      if (shared(VxPanel.PORTS_KEY) !== count) {
        setShared(VxPanel.PORTS_KEY, count);
      }
    });
  }

  loadPorts(cx) {
    if (this.loadingPorts) {
      return;
    }
    this.loadingPorts = true;
    cx.spawn(async (cx) => {
      try {
        const result = await VxPanel.listListeningPorts();
        const ports = parsePorts(result?.stdout);
        for (const port of ports) {
          await this.learnCwd(port.pid);
        }
        this.ports = ports;
      } finally {
        this.loadingPorts = false;
        cx.notify();
      }
    });
  }

  async learnCwd(pid) {
    if (this.cwds.has(pid)) {
      return;
    }
    const result = await exec("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]).catch(() => null);
    const nameLine = (result?.stdout ?? "").split("\n").find((line) => line.startsWith("n"));
    this.cwds.set(pid, nameLine?.slice(1) ?? null);
  }

  static folderLabel(cwd, root) {
    if (root) {
      return `${root.name}${cwd.slice(root.path.length)}`;
    }
    return cwd ? cwd.replace(home(), "~") : "";
  }

  confirmStop(port, folder) {
    askConfirm(VxPanel.MOD, {
      title: `Stop ${port.cmd} on port ${port.port}?`,
      detail: `Sends SIGTERM to pid ${port.pid}${folder ? ` (running in ${folder})` : ""}.`,
      label: "Stop",
      danger: true,
      action: { cmd: "kill", args: [String(port.pid)], doing: "Stopping", done: `Stopped ${port.cmd}` },
    });
  }

  portRow(t, port, roots) {
    const cwd = this.cwds.get(port.pid);
    const root = cwd ? rootFor(cwd, roots) : null;
    const folder = VxPanel.folderLabel(cwd, root);
    const url = `http://localhost:${port.port}`;
    const local = [...port.hosts].every((host) => VxPanel.LOCAL_HOSTS.includes(host));
    const action = (id) => div().id(id).size(22).flex_none().flex().items_center().justify_center().rounded(4).text_color(t.dim);
    return h_flex().id(`port-${port.port}`).h(26).flex_none().px(12).gap(8).items_center().hover((style) => style.bg(t.hover))
      .child(h_flex().w(70).gap(5).items_center().child(Icon("plug", 12).text_color(root ? t.accent : t.dim)).child(String(port.port)))
      .child(div().w(150).truncate().text_color(t.muted).tooltip(local ? "Only this machine can reach it" : "Reachable from the network").child([...port.hosts].join(", ")))
      .child(div().w(180).truncate().text_color(t.muted).child(`${port.cmd} (${port.pid})`))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).tooltip(cwd ?? "").child(folder))
      .child(action(`port-open-${port.port}`)
        .hover((style) => style.bg(t.raised).text_color(t.foreground)).tooltip(`Open ${url}`)
        .on_click(() => exec("open", [url]).catch(() => {})).child(Icon("globe", 13)))
      .child(action(`port-stop-${port.port}`)
        .hover((style) => style.bg(t.raised).text_color(t.ansi1)).tooltip(`Stop ${port.cmd} (pid ${port.pid})…`)
        .on_click(() => this.confirmStop(port, folder))
        .child(Icon("stop", 13)));
  }

  renderPorts(t) {
    const roots = workspace()?.roots ?? [];
    const list = this.ports;
    const body = v_flex().id("vp-ports").size_full().bg(t.background).text_size(TEXT.small).text_color(t.foreground)
      .child(h_flex().h(24).flex_none().px(12).gap(8).items_center().text_size(TEXT.caption).text_color(t.dim).border_b(1).border_color(t.border)
        .child(div().w(70).child("PORT")).child(div().w(150).child("ADDRESS")).child(div().w(180).child("PROCESS")).child(div().flex_1().child("FOLDER")));
    if (!list) {
      return body.child(div().p(12).text_color(t.dim).child("Looking for listening ports…"));
    }
    if (!list.length) {
      return body.child(div().p(12).text_color(t.dim).child("Nothing is listening on a TCP port here."));
    }
    return body.child(v_flex().id("vp-port-rows").flex_1().min_h(0).overflow_y_scrollbar()
      .children(list.map((port) => this.portRow(t, port, roots))));
  }

  static checksSummary(checks) {
    return Object.entries(checks)
      .filter(([, entry]) => entry.at && !entry.running && entry.scripts?.length)
      .map(([root, entry]) => `${baseName(root)}: ${entry.scripts?.length ? `${entry.scripts.join(" + ")}, ${entry.items.length} found` : entry.note ?? "nothing to run"}`)
      .join(" · ");
  }

  problemsToolbar(t, checks) {
    const context = ctx();
    const running = Object.entries(checks).find(([, entry]) => entry.running);
    const target = context.root?.name ?? (context.cwd ? baseName(context.cwd) : null);
    const label = running ? `Running ${running[1].running.join(" + ")} in ${baseName(running[0])}…` : `Run checks${target ? ` · ${target}` : ""}`;
    return h_flex().h(28).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().id("vp-run-checks").h(22).px(8).gap(5).flex().items_center().rounded(5).cursor_pointer()
        .bg(running ? t.raised : t.solid ?? t.accent).text_color(running ? t.muted : t.solid_foreground ?? t.accent_foreground)
        .tooltip(target ? `Run the typecheck and lint scripts of ${target}` : "Pick a repo first")
        .on_click(() => run("vx-panel.checks"))
        .child(Icon(running ? "spinner" : "play", 11)).child(label))
      .child(div().flex_1().min_w(0).truncate().text_size(TEXT.caption).text_color(t.dim).child(VxPanel.checksSummary(checks)));
  }

  rootRow(t, key, name, count) {
    return h_flex().id(`pr-h-${key}`).h(22).flex_none().px(10).gap(6).items_center().text_color(t.muted)
      .child(RootIcon(true, 13)).child(name).child(div().text_size(TEXT.caption).text_color(t.dim).child(String(count)));
  }

  levelGlyph(t, level) {
    const isError = level === "error";
    return div().w(14).flex_none().text_color(isError ? t.ansi1 : t.ansi3).child(isError ? "✕" : "!");
  }

  static revealProblem(problem) {
    setActive(problem.root, "pick");
    run("layout.select", { stack: "sidebar-views", child: problem.view });
    run("layout.show", { id: "sidebar" });
  }

  workspaceProblemRows(t) {
    const rows = [];
    for (const items of VxPanel.groupBy(VxPanel.problems(), (problem) => problem.root.path).values()) {
      rows.push(this.rootRow(t, items[0].root.path, items[0].root.name, items.length));
      rows.push(...items.map((problem) => h_flex().id(`pr-${problem.id}`).h(22).flex_none().pl(28).pr(10).gap(6).items_center().cursor_pointer().hover((style) => style.bg(t.hover))
        .on_click(() => VxPanel.revealProblem(problem))
        .child(this.levelGlyph(t, problem.level)).child(div().flex_1().min_w(0).truncate().child(problem.text))));
    }
    return rows;
  }

  checkFileRows(t, rootPath, rel, items) {
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const fileRow = h_flex().id(`ck-f-${rootPath}-${rel}`).h(22).flex_none().pl(24).pr(10).gap(6).items_center().text_color(t.foreground)
      .child(FileIcon(this.icons, rel, { size: 13 })).child(div().flex_none().max_w(260).truncate().child(baseName(rel)))
      .child(div().flex_1().min_w(0).truncate().text_size(TEXT.caption).text_color(t.dim).child(dir))
      .child(div().text_size(TEXT.caption).text_color(t.dim).child(String(items.length)));
    const itemRows = items.map((item, index) => h_flex().id(`ck-${rootPath}-${rel}-${index}`).h(22).flex_none().pl(44).pr(10).gap(6).items_center().cursor_pointer().hover((style) => style.bg(t.hover))
      .tooltip(`${rel}:${item.line}:${item.col}${item.rule ? ` · ${item.rule}` : ""}`)
      .on_click(() => showInViewer("vx-files", { root: rootPath, on: null, rel, line: item.line }, baseName(rel)))
      .child(this.levelGlyph(t, item.level)).child(div().flex_1().min_w(0).truncate().child(item.message))
      .child(div().flex_none().text_size(TEXT.caption).text_color(t.dim).child(`${item.rule ? `${item.rule}  ` : ""}[Ln ${item.line}, Col ${item.col}]`)));
    return [fileRow, ...itemRows];
  }

  checkRows(t, checks, roots) {
    const rows = [];
    for (const [rootPath, entry] of Object.entries(checks)) {
      if (!entry.items?.length && !entry.note) {
        continue;
      }
      const root = rootFor(rootPath, roots) ?? { name: baseName(rootPath), path: rootPath };
      rows.push(this.rootRow(t, `ck-${rootPath}`, `${root.name} · ${(entry.scripts ?? []).join(" + ") || "checks"}`, entry.items?.length ?? 0));
      if (entry.note) {
        rows.push(div().id(`ck-note-${rootPath}`).pl(28).pr(10).py(2).text_size(TEXT.caption).text_color(t.dim).child(entry.note));
      }
      for (const [rel, items] of VxPanel.groupBy(entry.items ?? [], (item) => item.rel)) {
        rows.push(...this.checkFileRows(t, rootPath, rel, items));
      }
    }
    return rows;
  }

  renderProblems(t) {
    const roots = workspace()?.roots ?? [];
    const checks = VxPanel.checks();
    const body = v_flex().id("vp-problems").size_full().bg(t.background).text_size(TEXT.small).text_color(t.foreground)
      .child(this.problemsToolbar(t, checks));
    const rows = [...this.workspaceProblemRows(t), ...this.checkRows(t, checks, roots)];
    if (!rows.length) {
      return body.child(div().p(12).text_color(t.dim).child(VxPanel.NO_PROBLEMS));
    }
    return body.child(v_flex().id("vp-problem-rows").flex_1().min_h(0).overflow_y_scrollbar().py(4).children(rows));
  }

  renderEmpty(t) {
    return v_flex().size_full().items_center().justify_center().gap(6).bg(t.background).text_color(t.dim).text_size(TEXT.small)
      .child(Icon("terminal", 22)).child("No terminal yet. Press ⌘J, or + above.");
  }

  static stopPropagation(_e, cx) {
    cx.stop_propagation();
  }

  headerButton(t, id, icon, tip, action) {
    return div().id(`vp-${id}`).size(22).flex_none().flex().items_center().justify_center().rounded(4)
      .text_color(t.dim).hover((style) => style.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", VxPanel.stopPropagation)
      .on_click((_e, cx) => {
        action(cx);
        cx.notify();
      })
      .child(Icon(icon, 14));
  }

  viewTab(t, [id, label], state, counts) {
    const selected = state.view === id;
    return h_flex().id(`vp-tab-${id}`).h_full().px(8).gap(5).flex_none().items_center().cursor_pointer()
      .text_color(selected ? t.foreground : t.muted).hover((style) => style.text_color(t.foreground))
      .on_mouse_down("left", VxPanel.stopPropagation)
      .on_click((_e, cx) => {
        this.pick(id);
        cx.notify();
      })
      .child(div().h_full().flex().items_center().border_b(1).border_color(selected ? t.foreground : VxPanel.TRANSPARENT).child(label))
      .when(Boolean(counts[id]), (el) => el.child(div().h(15).min_w(15).px(4).rounded(8).flex().items_center().justify_center()
        .bg(t.raised).text_size(TEXT.tiny).text_color(t.foreground).child(String(counts[id]))));
  }

  shellTab(t, address, index, state, live) {
    const selected = address === state.shown;
    return div().id(`vp-t-${address}`).h(20).px(6).flex_none().flex().items_center().rounded(4).cursor_pointer()
      .bg(selected ? t.selected : VxPanel.TRANSPARENT).text_color(selected ? t.foreground : t.muted).hover((style) => style.bg(t.hover))
      .tooltip(live.get(address)?.cwd ?? address).on_mouse_down("left", VxPanel.stopPropagation)
      .on_click((_e, cx) => {
        this.show(address);
        cx.notify();
      })
      .child(`${index + 1}`);
  }

  terminalControls(t, el, state, live) {
    const current = live.get(state.shown);
    const shells = state.list.filter((address) => live.has(address));
    const where = current?.cwd ? (current.cwd === home() ? "~" : baseName(current.cwd)) : "";
    return el
      .when(shells.length > 1, (row) => row.children(shells.map((address, index) => this.shellTab(t, address, index, state, live))))
      .when(Boolean(current), (row) => row.child(h_flex().h(20).px(6).gap(5).flex_none().items_center().text_color(t.muted).tooltip(current?.cwd ?? "")
        .child(Icon("terminal", 12)).child(div().max_w(220).truncate().child(`${current?.agent ?? "shell"} - ${where}`))))
      .child(this.headerButton(t, "new", "plus", "New Terminal in the context repo", (cx) => cx.spawn(async (cx) => {
        await this.add(cx);
        cx.notify();
      })))
      .child(this.headerButton(t, "kill", "trash", "Kill Terminal", () => this.kill()));
  }

  render() {
    if (this.confirmSpec) {
      return ConfirmView(this);
    }
    const t = theme();
    if (this.view === VxPanel.PORTS) {
      return this.renderPorts(t);
    }
    if (this.view === VxPanel.PROBLEMS) {
      return this.renderProblems(t);
    }
    if (this.view === VxPanel.EMPTY) {
      return this.renderEmpty(t);
    }
    const state = VxPanel.state();
    const live = VxPanel.liveTerminals();
    const big = VxPanel.isMaximized(this.bottom());
    const problemCounts = countProblems(VxPanel.problems(), VxPanel.checks());
    const counts = { problems: problemCounts.errors + problemCounts.warnings, ports: shared(VxPanel.PORTS_KEY) || null };
    return h_flex().id("vx-panel").size_full().pl(4).pr(8).gap(2).items_center().bg(t.background).text_size(TEXT.small)
      .children(VxPanel.VIEWS.map((view) => this.viewTab(t, view, state, counts)))
      .child(div().flex_1())
      .when(state.view === VxPanel.TERMINAL, (el) => this.terminalControls(t, el, state, live))
      .child(this.headerButton(t, "max", big ? "chevron-down" : "maximize", big ? "Restore Panel Size" : "Maximize Panel Size", () => this.maximize()))
      .child(this.headerButton(t, "hide", "x", "Hide Panel (⌘J)", () => run("layout.hide", { id: "bottom" })));
  }
}
