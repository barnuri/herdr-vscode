import { View, div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { theme, shared, setShared, run, panes, spaces, exec, watchFolder, props, pickFolder, checking } from "herdr";
import {
  ctx, workspace, active, setActive, changedAt, git, findWorkspaceFile, folderRoots, loadWorkspace, rootFor,
  baseName, editWorkspaceFile, writeText, repoTop,
} from "./ws.js";
import { newWorkspace, stringifyWorkspace, workspaceName, parentOf } from "./ws-core.js";
import { parseStatus } from "./git-core.js";
import { askConfirm, confirmMethods, runAction } from "./actions.js";
import { CLIPBOARD_KEY, pastePlan } from "./fileops-core.js";
import { logInfo, toast, logError } from "./log.js";
import { TEXT, Icon, IconButton, ConfirmView } from "./ui.js";
import { loadIcons } from "./icons.js";
import { showInViewer } from "./tabs.js";
import { explorerMethods } from "./explorer.js";
import { menuMethods, post } from "./menus.js";

// Popups and dialogs post commands (shared "herdr-vscode.ws.cmd") that this panel runs, so a closing popup never drops half an action.
class HerdrVscodeWorkspace extends View {
  static MOD = "herdr-vscode-workspace";
  static STATUS_MS = 10000;
  static RECHECK_FILE_MS = 15000;
  static FOLLOW_MS = 400;
  static REPLY_POLL_MS = 250;
  static RECENT = 10;
  static CREATED_TOAST_MS = 3000;
  static RECENT_SHOWN = 5;
  static INITIAL_WIDTH = 240;
  static NARROW_WIDTH = 160;
  static RESIZE_THRESHOLD = 4;
  static TRANSPARENT = "#00000000";
  static NOISY_PATH = /\/(\.git|node_modules|\.next|dist)(\/|$)/;
  static NOT_A_REPO = /not a git repository/i;
  static KEY_RECENT = "recent";
  static KEY_CLOSED = "closed";
  static KEY_FILE = "file";
  static SHARED_WORKSPACE = "herdr-vscode.workspace";
  static SHARED_ACTIVE = "herdr-vscode.active";
  static SHARED_RECENT = "herdr-vscode.ws.recent";
  static SHARED_COMMAND = "herdr-vscode.ws.cmd";
  static SHARED_REPLY = "herdr-vscode.ws.reply";
  static SHARED_GIT = "herdr-vscode.git";
  static COMMAND_HANDLERS = {
    addFolder: "commandAddFolder",
    remove: "commandRemove",
    rename: "commandRename",
    move: "commandMove",
    pickOpen: "commandPickOpen",
    open: "commandOpen",
    close: "commandClose",
    create: "commandCreate",
    pickDir: "commandPickDir",
    pickNewFolder: "commandPickNewFolder",
    terminal: "commandTerminal",
    preview: "commandPreview",
    finder: "commandFinder",
    fetch: "commandFetch",
    openSide: "commandOpenSide",
    fileHistory: "commandFileHistory",
    clip: "commandClip",
    paste: "commandPaste",
    delete: "commandDelete",
    renameFile: "commandRenameFile",
  };
  static FILES_MOD = "herdr-vscode-files";

  static errorText(error) {
    return String(error?.message ?? error);
  }

  static workspaceKey(ws) {
    return ws?.file ?? ws?.dir;
  }

  static workspaceTitle(ws) {
    if (!ws) {
      return "Workspace";
    }
    return ws.file ? `${ws.name} (Workspace)` : ws.name;
  }

  static gitError(stderr) {
    if (HerdrVscodeWorkspace.NOT_A_REPO.test(stderr)) {
      return "not a git repo";
    }
    return (stderr || "git failed").trim();
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
    if (initProps.menu) {
      this.menu = initProps.menu;
      return;
    }
    // mod.open:herdr-vscode-workspace (a key) opens the workspace menu.
    if (initProps.overlay) {
      this.menu = { kind: "header" };
      return;
    }
    if (initProps.dialog) {
      this.initDialog(initProps.dialog);
      cx.timer.every(HerdrVscodeWorkspace.REPLY_POLL_MS, (cx) => this.takeReply(cx));
      return;
    }
    this.initPanel(cx);
  }

  initPanel(cx) {
    this.status = new Map();
    this.tops = new Map();
    this.width = HerdrVscodeWorkspace.INITIAL_WIDTH;
    this.initExplorer();
    this.filter = "";
    this.filterState = InputState.new({ placeholder: "Filter files in the workspace" });
    this.filterState.on("change", (_event, cx) => {
      this.filter = this.filterState.value().trim();
      if (this.filter) {
        this.buildIndex(cx);
      }
      cx.notify();
    });
    if (!checking()) {
      this.start(cx);
    }
  }

  loadRecent() {
    try {
      return JSON.parse(localStorage.getItem(HerdrVscodeWorkspace.KEY_RECENT) ?? "[]");
    } catch {
      return [];
    }
  }

  start(cx) {
    this.recent = this.loadRecent();
    setShared(HerdrVscodeWorkspace.SHARED_RECENT, this.recent);
    this.cmdSeen = shared(HerdrVscodeWorkspace.SHARED_COMMAND)?.id ?? null;
    cx.spawn(async (cx) => this.restoreWorkspace(cx));
    cx.timer.every(HerdrVscodeWorkspace.FOLLOW_MS, (cx) => this.follow(cx));
    cx.timer.every(HerdrVscodeWorkspace.STATUS_MS, (cx) => {
      this.refreshAll(cx);
      this.reloadOpen(cx);
    });
    cx.timer.every(HerdrVscodeWorkspace.RECHECK_FILE_MS, (cx) => {
      if (this.ws?.file) {
        this.openFile(this.ws.file, cx, { quiet: true });
      }
    });
  }

  async restoreWorkspace(cx) {
    if (localStorage.getItem(HerdrVscodeWorkspace.KEY_CLOSED) === "1") {
      cx.notify();
      return;
    }
    const saved = localStorage.getItem(HerdrVscodeWorkspace.KEY_FILE);
    const ws = workspace();
    if (ws?.roots?.length) {
      this.adopt(ws, cx);
    } else if (saved) {
      await this.openFile(saved, cx);
    }
    if (!this.ws) {
      await this.discover(cx);
    }
  }

  // Shows a workspace and makes it the one every herdr-vscode mod uses.
  adopt(ws, cx) {
    const changed = JSON.stringify(ws) !== JSON.stringify(this.ws);
    const switched = HerdrVscodeWorkspace.workspaceKey(ws) !== HerdrVscodeWorkspace.workspaceKey(this.ws);
    this.ws = ws;
    setShared(HerdrVscodeWorkspace.SHARED_WORKSPACE, ws);
    if (ws.file) {
      localStorage.setItem(HerdrVscodeWorkspace.KEY_FILE, ws.file);
    }
    localStorage.removeItem(HerdrVscodeWorkspace.KEY_CLOSED);
    if (switched) {
      this.resetForWorkspace(ws, cx);
    }
    if (changed) {
      this.refreshAll(cx);
    }
    cx.notify();
  }

  resetForWorkspace(ws, cx) {
    this.entries = new Map();
    this.index = new Map();
    this.restoreOpen();
    this.reloadOpen(cx);
    this.status = new Map();
    if (!ws.auto) {
      this.remember(ws);
    }
    // The active repo belongs to the workspace you left.
    if (active()?.root && !rootFor(active().root, ws.roots)) {
      setShared(HerdrVscodeWorkspace.SHARED_ACTIVE, null);
    }
  }

  remember(ws) {
    const key = HerdrVscodeWorkspace.workspaceKey(ws);
    const entry = { file: ws.file ?? null, dir: ws.file ? null : ws.dir, name: ws.name };
    const others = this.recent.filter((recent) => HerdrVscodeWorkspace.workspaceKey(recent) !== key);
    this.recent = [entry, ...others].slice(0, HerdrVscodeWorkspace.RECENT);
    localStorage.setItem(HerdrVscodeWorkspace.KEY_RECENT, JSON.stringify(this.recent));
    setShared(HerdrVscodeWorkspace.SHARED_RECENT, this.recent);
  }

  async openFile(file, cx, { quiet = false } = {}) {
    try {
      const ws = await loadWorkspace(file);
      if (!quiet || JSON.stringify(ws) !== JSON.stringify(this.ws)) {
        this.adopt(ws, cx);
      }
      this.error = null;
    } catch (error) {
      logError("herdr-vscode-workspace", "workspace discovery failed", String(error?.message ?? error));
      if (!quiet) {
        this.error = HerdrVscodeWorkspace.errorText(error);
      }
      cx.notify();
    }
  }

  async openDir(dir, cx) {
    const file = await findWorkspaceFile(dir);
    if (file && file.startsWith(`${dir}/`)) {
      return this.openFile(file, cx);
    }
    const roots = await folderRoots(dir);
    if (!roots.length) {
      return toast("herdr-vscode-workspace", { title: "No workspace there", body: "That folder has no .code-workspace file and no git repos.", level: "warning" });
    }
    this.adopt({ file: null, name: baseName(dir), dir, roots }, cx);
  }

  // At start: a .code-workspace at or above the focused folder, else its git subfolders.
  async discover(cx) {
    const dir = ctx().focus.cwd ?? ctx().focus.space?.folder;
    if (!dir) {
      return;
    }
    const file = await findWorkspaceFile(dir);
    if (file) {
      return this.openFile(file, cx);
    }
    const roots = await folderRoots(dir);
    if (roots.length) {
      this.adopt({ file: null, name: baseName(dir), dir, roots }, cx);
    }
  }

  // Focus moved to a terminal (or the terminal changed folder): a pick hands over to it.
  followFocus() {
    const focus = ctx().focus;
    const focusKey = `${focus.terminal ?? ""}|${focus.cwd ?? ""}`;
    if (focusKey === this.focusKey) {
      return;
    }
    const first = this.focusKey === undefined;
    this.focusKey = focusKey;
    const current = active();
    if (!first && focus.terminal && current?.by === "pick") {
      setShared(HerdrVscodeWorkspace.SHARED_ACTIVE, { ...current, by: "click" });
    }
  }

  // With no workspace open, the Explorer shows the focused terminal's repo (or folder).
  followActiveFolder(cx) {
    const cwd = ctx().focus.cwd;
    if (!cwd || (this.ws && !this.ws.auto) || cwd === this.autoCwd) {
      return;
    }
    this.autoCwd = cwd;
    const on = ctx().focus.space?.machine ?? null;
    cx.spawn(async (cx) => {
      const top = (await repoTop(this.tops, cwd, on).catch(() => null)) ?? cwd;
      if (this.autoCwd !== cwd || (this.ws && !this.ws.auto) || this.ws?.dir === top) {
        return;
      }
      this.adopt({ file: null, auto: true, name: baseName(top), dir: top, roots: [{ name: baseName(top), path: top, ...(on ? { on } : {}) }] }, cx);
    });
  }

  follow(cx) {
    this.followFocus();
    this.followActiveFolder(cx);
    const context = ctx();
    if (context.source === "root" && active()?.root !== context.root.path) {
      setActive(context.root, "focus");
    }
    if (changedAt() !== this.seenChange) {
      this.seenChange = changedAt();
      this.index = new Map();
      this.refreshAll(cx);
      this.reloadOpen(cx);
    }
    const command = shared(HerdrVscodeWorkspace.SHARED_COMMAND);
    if (command?.id && command.id !== this.cmdSeen) {
      this.cmdSeen = command.id;
      this.runCommand(command, cx);
    }
    const activeRoot = active()?.root ?? null;
    if (activeRoot !== this.watching) {
      this.watch(activeRoot, cx);
    }
  }

  async edit(op, cx) {
    if (!this.ws?.file) {
      return toast("herdr-vscode-workspace", { title: "Save the workspace first", body: "This is a folder of repos, not a .code-workspace file: use Save Workspace As… in the ⋯ menu.", level: "warning" });
    }
    try {
      const { ws, lostComments } = await editWorkspaceFile(this.ws.file, op);
      this.adopt(ws, cx);
      if (lostComments) {
        toast("herdr-vscode-workspace", { title: "Workspace saved", body: "Comments in the .code-workspace file were not kept.", level: "warning" });
      }
    } catch (error) {
      toast("herdr-vscode-workspace", { title: "Couldn't change the workspace", body: HerdrVscodeWorkspace.errorText(error), level: "error" });
    }
  }

  runCommand(command, cx) {
    const handler = HerdrVscodeWorkspace.COMMAND_HANDLERS[command.cmd];
    if (!handler) {
      return;
    }
    cx.spawn(async (cx) => this[handler](command, cx));
  }

  async commandAddFolder(_command, cx) {
    const dir = await pickFolder({ prompt: "Add Folder to Workspace" });
    if (dir) {
      await this.edit({ type: "add", paths: [dir] }, cx);
    }
  }

  async commandRemove(command, cx) {
    await this.edit({ type: "remove", path: command.path }, cx);
    if (active()?.root === command.path) {
      setShared(HerdrVscodeWorkspace.SHARED_ACTIVE, null);
    }
  }

  async commandRename(command, cx) {
    await this.edit({ type: "rename", path: command.path, name: command.name }, cx);
  }

  async commandMove(command, cx) {
    if (command.to >= 0 && command.to < (this.ws?.roots.length ?? 0)) {
      await this.edit({ type: "move", path: command.path, to: command.to }, cx);
    }
  }

  async commandPickOpen(_command, cx) {
    const dir = await pickFolder({ prompt: "Open a folder holding a .code-workspace file, or a folder of repos" });
    if (dir) {
      await this.openDir(dir, cx);
    }
  }

  async commandOpen(command, cx) {
    if (command.file) {
      await this.openFile(command.file, cx);
    } else if (command.dir) {
      await this.openDir(command.dir, cx);
    }
  }

  commandClose(_command, cx) {
    this.ws = null;
    setShared(HerdrVscodeWorkspace.SHARED_WORKSPACE, null);
    setShared(HerdrVscodeWorkspace.SHARED_ACTIVE, null);
    localStorage.setItem(HerdrVscodeWorkspace.KEY_CLOSED, "1");
    cx.notify();
  }

  async commandCreate(command, cx) {
    try {
      const exists = await exec("test", ["-e", command.file]);
      if (exists.code === 0) {
        throw new Error(`${command.file} already exists`);
      }
      const dir = command.file.replace(/\/[^/]+$/, "");
      await writeText(command.file, stringifyWorkspace(newWorkspace(dir, command.paths)));
      await this.openFile(command.file, cx);
      toast("herdr-vscode-workspace", { title: `Created ${workspaceName(command.file)}`, body: command.file, level: "success", timeout: HerdrVscodeWorkspace.CREATED_TOAST_MS });
    } catch (error) {
      toast("herdr-vscode-workspace", { title: "Couldn't create the workspace", body: HerdrVscodeWorkspace.errorText(error), level: "error" });
    }
  }

  async commandPickDir(command) {
    const dir = await pickFolder({ prompt: "Where to save the .code-workspace file" });
    if (dir) {
      setShared(HerdrVscodeWorkspace.SHARED_REPLY, { id: command.id, dialog: command.dialog, dir });
    }
  }

  async commandPickNewFolder(command) {
    const folder = await pickFolder({ prompt: "Add a folder to the new workspace" });
    if (folder) {
      setShared(HerdrVscodeWorkspace.SHARED_REPLY, { id: command.id, dialog: command.dialog, folder });
    }
  }

  commandTerminal(command) {
    this.openTerminal(command.path);
  }

  commandPreview(command) {
    showInViewer("herdr-vscode-files", { root: command.root, on: null, rel: command.rel }, baseName(command.rel));
  }

  static activeSpaceId() {
    return spaces().find((space) => space.active)?.id;
  }

  // A kept viewer of its own beside the current pane, like VS Code's Open to the Side.
  commandOpenSide(command) {
    const space = HerdrVscodeWorkspace.activeSpaceId();
    run("pane.split", { direction: "right", mod: HerdrVscodeWorkspace.FILES_MOD, props: { mode: "view", space, fixed: true, file: { root: command.root, rel: command.rel } } });
  }

  commandFileHistory(command) {
    const space = HerdrVscodeWorkspace.activeSpaceId();
    run("tab.new", { space, name: `History: ${baseName(command.rel)}`, mod: HerdrVscodeWorkspace.FILES_MOD, props: { mode: "view", space, fixed: true, history: "file", file: { root: command.root, rel: command.rel } } });
  }

  commandClip(command) {
    setShared(CLIPBOARD_KEY, { path: command.path, cut: command.cut });
    logInfo(HerdrVscodeWorkspace.MOD, command.cut ? "cut" : "copy", command.path);
  }

  // Copies (cp -R) or moves (mv) the clipboard entry into the folder; replacing asks first and trashes the old one.
  async commandPaste(command) {
    const clip = shared(CLIPBOARD_KEY);
    const listing = await exec("ls", ["-A", command.folder]).catch(() => null);
    const plan = pastePlan(clip, command.folder, (listing?.stdout ?? "").split("\n").filter(Boolean));
    if (plan.skip) {
      toast("herdr-vscode-workspace", { title: "Nothing pasted", body: plan.reason, level: "info" });
      return;
    }
    const move = plan.move ? { cmd: "mv", args: ["-n", plan.source, plan.target] } : { cmd: "cp", args: ["-R", "-n", plan.source, plan.target] };
    const action = { doing: plan.move ? "Moving" : "Copying", done: `Pasted ${baseName(plan.target)}`, root: command.folder, steps: [move] };
    if (plan.move) {
      setShared(CLIPBOARD_KEY, null);
    }
    if (!plan.conflict) {
      await runAction(action);
      return;
    }
    askConfirm(HerdrVscodeWorkspace.MOD, {
      title: `Replace ${baseName(plan.target)}?`,
      detail: `${command.folder} already has it. The old one goes to the Trash.`,
      label: "Replace",
      danger: true,
      action: { ...action, steps: [{ cmd: "trash", args: [plan.target] }, move] },
    });
  }

  commandDelete(command) {
    askConfirm(HerdrVscodeWorkspace.MOD, {
      title: `Delete ${baseName(command.path)}?`,
      detail: `Moves the ${command.dir ? "folder and everything in it" : "file"} to the Trash. You can put it back from there.`,
      label: "Move to Trash",
      danger: true,
      action: { doing: "Deleting", done: `Moved ${baseName(command.path)} to the Trash`, root: parentOf(command.path), steps: [{ cmd: "trash", args: [command.path] }] },
    });
  }

  async commandRenameFile(command) {
    const name = command.name;
    if (!name || name.includes("/") || name === baseName(command.path)) {
      return;
    }
    const target = `${parentOf(command.path)}/${name}`;
    const exists = await exec("test", ["-e", target]).catch(() => null);
    if (exists?.code === 0) {
      toast("herdr-vscode-workspace", { title: "Not renamed", body: `${name} already exists.`, level: "error" });
      return;
    }
    await runAction({ doing: "Renaming", done: `Renamed to ${name}`, root: parentOf(command.path), steps: [{ cmd: "mv", args: ["-n", command.path, target] }] });
  }

  commandFinder(command) {
    exec("open", command.reveal ? ["-R", command.path] : [command.path]).catch(() => {});
  }

  commandFetch(command) {
    askConfirm(HerdrVscodeWorkspace.MOD, {
      title: `Fetch ${command.name}?`,
      detail: "Downloads new commits and branches from the remote. Your files and branches don't change.",
      label: "Fetch",
      action: { cmd: "git", args: ["fetch", "--prune"], cwd: command.path, doing: "Fetching", done: `Fetched ${command.name}`, root: command.path },
    });
  }

  // A terminal already in that folder (its tab selected), else a new tab there.
  openTerminal(path) {
    const inside = (pane) => pane.terminal && pane.cwd && (pane.cwd === path || pane.cwd.startsWith(`${path}/`));
    const pane = panes().find(inside);
    if (!pane) {
      run("tab.new", { folder: path, name: baseName(path), space: spaces().find((space) => space.active)?.id });
      return;
    }
    run("tab.select", { id: pane.tab });
    run("pane.focus", { pane: pane.pane });
  }

  // Only the active repo is watched (recursive watches on eight node_modules-heavy repos wake
  // on every install); the rest refresh on the timer.
  watch(root, cx) {
    this.watcher?.cancel?.();
    this.watching = root;
    if (!root) {
      return;
    }
    cx.spawn(async (cx) => {
      while (this.watching === root) {
        let paths;
        try {
          this.watcher = watchFolder(root);
          paths = await this.watcher;
        } catch {
          return;
        }
        if (paths.length && paths.every((path) => HerdrVscodeWorkspace.NOISY_PATH.test(path))) {
          continue;
        }
        if (this.watching !== root) {
          return;
        }
        this.index.delete(root);
        this.refreshOne(root, cx);
        this.reloadOpen(cx);
      }
    });
  }

  refreshAll(cx) {
    for (const root of this.ws?.roots ?? []) {
      this.refreshOne(root.path, cx);
    }
  }

  async readStatus(path) {
    try {
      const result = await git(["status", "--porcelain=v1", "-z", "-b", "--no-renames", "--untracked-files=normal"], { cwd: path });
      return result.code === 0 ? parseStatus(result.stdout) : { error: HerdrVscodeWorkspace.gitError(result.stderr) };
    } catch (error) {
      logError("herdr-vscode-workspace", "file op failed", String(error?.message ?? error));
      return { error: HerdrVscodeWorkspace.errorText(error) };
    }
  }

  refreshOne(path, cx) {
    this.loading ??= new Set();
    if (this.loading.has(path)) {
      return;
    }
    this.loading.add(path);
    cx.spawn(async (cx) => {
      let next;
      try {
        next = await this.readStatus(path);
      } finally {
        this.loading.delete(path);
      }
      if (JSON.stringify(this.status.get(path)) === JSON.stringify(next)) {
        return;
      }
      this.status.set(path, next);
      this.publishSummary();
      cx.notify();
    });
  }

  // A small summary other mods may show (herdr-vscode-status, herdr-vscode-ci).
  publishSummary() {
    const summary = {};
    for (const [path, status] of this.status) {
      summary[path] = status.error
        ? { error: status.error }
        : { branch: status.branch, ahead: status.ahead, behind: status.behind, changed: status.changed, conflicts: status.conflicts };
    }
    setShared(HerdrVscodeWorkspace.SHARED_GIT, summary);
  }

  refreshEverything(cx) {
    this.index = new Map();
    this.refreshAll(cx);
    this.reloadOpen(cx);
  }

  resize(size, cx) {
    if (Math.abs(size.width - this.width) <= HerdrVscodeWorkspace.RESIZE_THRESHOLD) {
      return;
    }
    this.width = size.width;
    cx.notify();
  }

  panelHeader(t, narrow) {
    const ws = this.ws;
    return h_flex().id("ws-head").h(36).flex_none().pl(narrow ? 0 : 12).pr(narrow ? 0 : 6).gap(2).items_center().border_b(1).border_color(t.border)
      .when(narrow, (el) => el.justify_center().child(Icon("layers", 13)))
      .when(!narrow, (el) => el
        .child(Icon("layers", 13).text_color(t.dim))
        .child(div().flex_1().min_w(0).pl(6).truncate().font_medium().text_size(TEXT.body).child(HerdrVscodeWorkspace.workspaceTitle(ws)))
        .when(Boolean(ws), (row) => row
          .child(IconButton({ id: "ws-add", icon: "plus", label: "Add Folder to Workspace…", size: 22, onClick: () => post({ cmd: "addFolder" }) }))
          .child(IconButton({ id: "ws-dots", icon: "dot-files", label: this.showDots ? "Hide dotfiles" : "Show dotfiles", active: !this.showDots, size: 22, onClick: (cx) => this.toggleDots(cx) }))
          .child(IconButton({ id: "ws-collapse", icon: "collapse", label: "Collapse Folders", size: 22, onClick: (cx) => this.collapseAll(cx) }))
          .child(IconButton({ id: "ws-refresh", icon: "refresh", label: "Refresh", size: 22, spinning: (this.loading?.size ?? 0) > 0, onClick: (cx) => this.refreshEverything(cx) })))
        .child(IconButton({ id: "ws-more", icon: "more", label: "Workspace…", size: 22, onClick: () => this.openMenu({ kind: "header" }) })));
  }

  filterBox(t) {
    return h_flex().h(34).flex_none().px(8).items_center()
      .child(h_flex().flex_1().h(26).px(8).gap(6).items_center().rounded(6).border_1().border_color(t.border).bg(t.input ?? t.background)
        .child(Icon("search", 12).text_color(t.dim))
        .child(Input.new(this.filterState).flex_1().h(24).text_size(TEXT.small)));
  }

  actionButton(t, id, icon, label, onClick) {
    return h_flex().id(id).h(26).px(8).gap(6).items_center().rounded(6).bg(t.raised).cursor_pointer().hover((style) => style.bg(t.hover)).text_size(TEXT.small)
      .on_click(onClick).child(Icon(icon, 13)).child(label);
  }

  recentRow(t, recent) {
    const location = recent.file ?? recent.dir;
    return h_flex().id(`rc-${location}`).h(24).px(8).gap(6).items_center().rounded(6).cursor_pointer().hover((style) => style.bg(t.hover))
      .text_size(TEXT.small).tooltip(location).on_click(() => post({ cmd: "open", file: recent.file, dir: recent.dir }))
      .child(Icon("history", 12).text_color(t.dim)).child(div().truncate().child(recent.name));
  }

  noWorkspace(t) {
    const recent = (this.recent ?? []).slice(0, HerdrVscodeWorkspace.RECENT_SHOWN);
    return v_flex().px(12).py(6).gap(6)
      .child(div().text_size(TEXT.small).text_color(t.dim).whitespace_normal().child("No workspace open."))
      .child(this.actionButton(t, "ws-open", "folder", "Open Workspace…", () => post({ cmd: "pickOpen" })))
      .child(this.actionButton(t, "ws-new", "layers", "New Workspace…", () => this.openDialog({ kind: "new" })))
      .when(recent.length > 0, (el) => el.child(div().pt(4).text_size(TEXT.caption).text_color(t.dim).child("RECENT")))
      .children(recent.map((entry) => this.recentRow(t, entry)));
  }

  narrowRoots(t, ws) {
    return ws.roots.map((root) => div().id(`n-${root.path}`).h(30).flex().items_center().justify_center().cursor_pointer()
      .bg(active()?.root === root.path ? t.selected : HerdrVscodeWorkspace.TRANSPARENT).tooltip(root.name)
      .on_click((_event, cx) => {
        setActive(root, "pick");
        cx.notify();
      })
      .child(Icon("folder", 15).text_color(t.muted)));
  }

  fillBody(t, body, narrow) {
    const ws = this.ws;
    if (!ws) {
      if (!narrow) {
        body.child(this.noWorkspace(t));
      }
      return;
    }
    if (narrow) {
      body.children(this.narrowRoots(t, ws));
      return;
    }
    if (!ws.roots.length) {
      body.child(div().px(16).py(6).text_size(TEXT.small).text_color(t.dim).child("No folders. Use + to add one."));
    }
    body.children(this.filter ? this.filterRows(t, this.filter) : this.explorerRows(t));
  }

  renderPanel() {
    const t = theme();
    const narrow = this.width < HerdrVscodeWorkspace.NARROW_WIDTH;
    const root = v_flex().id(HerdrVscodeWorkspace.MOD).size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .on_size_change((size, cx) => this.resize(size, cx))
      .on_mouse_up("left", () => {
        this.drag = null;
      });
    root.child(this.panelHeader(t, narrow));
    if (this.ws && !narrow) {
      root.child(this.filterBox(t));
    }
    const body = v_flex().id("ws-body").flex_1().min_h(0).overflow_y_scrollbar().pb(6);
    if (this.error) {
      body.child(div().px(16).py(6).text_size(TEXT.small).text_color(t.ansi1).whitespace_normal().child(this.error));
    }
    this.fillBody(t, body, narrow);
    return root.child(body);
  }

  render(cx) {
    if (this.confirmSpec) {
      return ConfirmView(this);
    }
    if (this.menu) {
      return this.renderMenu();
    }
    if (this.dlg) {
      return this.renderDialog(cx);
    }
    return this.renderPanel();
  }
}

Object.assign(HerdrVscodeWorkspace.prototype, confirmMethods, explorerMethods, menuMethods);
export default HerdrVscodeWorkspace;
