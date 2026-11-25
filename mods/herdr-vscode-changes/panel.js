import { div } from "gpui-kit";
import { v_flex, h_flex, Textarea } from "gpui-base";
import { theme, shared, exec } from "herdr";
import { ctx, spaceCtx, focusInfo, active, contextKey, git, repoTop, changedAt, bump, baseName } from "./ws.js";
import { parseStatus, parseNumstat } from "./git-core.js";
import { chooseContext } from "./ws-core.js";
import { primaryAction, discardPlan, subjectInfo } from "./scm-core.js";
import { TEXT, Icon, IconButton, FileIcon, Message, tint, SPIN_MS } from "./ui.js";
import { isLight } from "./icons-core.js";
import { workspace } from "./ws.js";
import { showInViewer } from "./tabs.js";
import { RepoButton } from "./repo-picker.js";
import { askConfirm, runAction } from "./actions.js";
import { openScmMenu, openScmAsk } from "./scm-popups.js";
import { toast, logError } from "./log.js";
import { getSetting, setSetting, whenSettings } from "./settings.js";
import { withTreeIndent, twistieSlot, treePadding } from "./tree-ui.js";

const MOD = "herdr-vscode-changes";
const HISTORY_PART = "history";
const FILES_MOD = "herdr-vscode-files";
const COMMAND_KEY = "herdr-vscode.changes.cmd";
const CLOSED_KEY = "closed";
// Before settings.json "View as Tree/List" lived in localStorage: still the default.
const OLD_VIEW_KEY = "view";
const VIEW_TREE = "tree";
const VIEW_FLAT = "flat";
const VIEW_COMMAND = "view";
const STAGED = "staged";
const STAGE = "stage";
const UNSTAGE = "unstage";
const AMEND = "amend";
const COMMIT = "commit";
const COMMIT_ALL = "commitAll";
const SHOWN_FILES_LIMIT = 1000;
const INDEX_BATCH = 200;
const ROW_HEIGHT = 22;
const GROUP_HEIGHT = 22;
const GRAPH_GROUP = "graph";
const COMMITS_SECTION = "commits";
// VS Code's gitDecoration colours (Dark Modern, Light Modern).
const DECORATION = {
  dark: { M: "#E2C08D", A: "#73C991", U: "#73C991", R: "#73C991", C: "#73C991", D: "#C74E39", conflict: "#E4676B" },
  light: { M: "#895503", A: "#587C0C", U: "#587C0C", R: "#587C0C", C: "#587C0C", D: "#AD0707", conflict: "#AD0707" },
};
const BADGE = { dark: { bg: "#616161", fg: "#F8F8F8" }, light: { bg: "#CCCCCC", fg: "#3B3B3B" } };
const DISABLED_BUTTON_ALPHA = "80";
const WRITE_TIMEOUT_MS = 120000;
const SUCCESS_TIMEOUT_MS = 3000;
const SHORT_SHA = 8;
const COMMIT_MENU_WIDTH = 250;
const ID_RADIX = 36;
const ID_SUFFIX_START = 2;
const ID_SUFFIX_END = 7;
const TRANSPARENT = "#00000000";
const PRESSED_TINT = "#ffffff";
const STATUS_ARGS = ["status", "--porcelain=v1", "-z", "-b", "--no-renames", "--untracked-files=all"];
const NUMSTAT_ARGS = ["--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv"];
const REMOTE_COMMANDS = new Set(["fetch", "pull", "push", "sync", "publish"]);

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

const tone = (colors) => (isLight(colors.background) ? "light" : "dark");
const decorationColor = (colors, letter, conflict) => DECORATION[tone(colors)][conflict ? "conflict" : letter] ?? colors.foreground;

const commandFailure = (result) => new Error((result.stderr || result.stdout).trim());

function stagedLetter(file) {
  if (file.x === "A" || file.x === "D") {
    return file.x;
  }
  return "M";
}

function unstagedLetter(file) {
  if (file.untracked) {
    return "U";
  }
  if (file.conflict) {
    return "!";
  }
  return file.y === "D" ? "D" : "M";
}

function primaryIcon(kind) {
  if (kind === "sync") {
    return "sync";
  }
  if (kind === "publish") {
    return "cloud-upload";
  }
  return kind === AMEND ? "pencil" : "commit-check";
}

function syncDetail(behind, ahead, afterCommit) {
  const pulls = behind ? `Pulls ${plural(behind, "commit")}${ahead ? ", replaying your unpushed commits on top" : ""}` : "Pulls anything new";
  const pushes = ahead ? `, then pushes ${afterCommit ? "your commits" : plural(ahead, "commit")}. Other people will see them.` : ".";
  return `${pulls}${pushes}`;
}

function discardDetail(restore, trash, single) {
  const restoreText = single ? "It goes" : `${plural(restore.length, "edited file")} go`;
  const trashText = single ? "This new file goes" : `${plural(trash.length, "new file")} go`;
  return [
    restore.length ? `${restoreText} back to the last staged or committed version.` : "",
    trash.length ? `${trashText} to the Trash.` : "",
    "Staged changes stay.",
  ].filter(Boolean).join(" ");
}

function buildTree(files) {
  const root = { dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    parts.pop();
    let node = root;
    for (const part of parts) {
      if (!node.dirs.has(part)) {
        node.dirs.set(part, { dirs: new Map(), files: [] });
      }
      node = node.dirs.get(part);
    }
    node.files.push(file);
  }
  return root;
}

// Folds a chain of single-child folders into one label.
function filesUnder(node) {
  return [...node.files, ...[...node.dirs.values()].flatMap(filesUnder)];
}

function foldSingleChildren(name, node) {
  let label = name;
  let current = node;
  while (current.files.length === 0 && current.dirs.size === 1) {
    const [[childName, child]] = [...current.dirs];
    label += `/${childName}`;
    current = child;
  }
  return { label, node: current };
}

export const panelMethods = {
  initPanel(cx) {
    this.uid = `scm-${Date.now().toString(ID_RADIX)}-${Math.random().toString(ID_RADIX).slice(ID_SUFFIX_START, ID_SUFFIX_END)}`;
    this.tops = new Map();
    this.files = [];
    this.stats = [{}, {}];
    try {
      this.closed = new Set(JSON.parse(localStorage.getItem(CLOSED_KEY) ?? "[]"));
    } catch {
      this.closed = new Set();
    }
    const viewOf = (fallback) => (getSetting("scm", "view", fallback) === VIEW_TREE ? VIEW_TREE : VIEW_FLAT);
    this.view = viewOf(localStorage.getItem(OLD_VIEW_KEY));
    whenSettings(cx, () => {
      this.view = viewOf(this.view);
    });
    this.amend = false;
    this.ahead = 0;
    this.behind = 0;
    this.message.on("change", (_e, cx) => cx.notify());
  },

  // The repo to show. A repo picked here wins until focus moves to another terminal (or its folder
  // changes). Focus on a terminal shows that terminal's repo. Focus on a mod pane keeps the last one.
  scmContext() {
    const focus = focusInfo();
    const focusKey = `${focus.terminal ?? ""}|${focus.cwd ?? ""}`;
    if (focus.terminal && focusKey !== this.focusKey) {
      this.focusKey = focusKey;
      this.focusAt = Date.now();
    }
    const pick = active();
    if (pick?.by === "pick" && pick.at > (this.focusAt ?? 0)) {
      return ctx();
    }
    if (focus.terminal) {
      this.lastContext = chooseContext({ focus, roots: workspace()?.roots ?? [], active: null, spaceFolder: focus.space?.folder ?? null });
    }
    return this.lastContext ?? spaceCtx();
  },

  followPanel(cx) {
    const key = contextKey(this.scmContext());
    if (key !== this.key) {
      this.key = key;
      this.note = null;
      this.files = [];
      this.root = null;
      this.amend = false;
      this.refresh(cx);
    } else if (changedAt() !== this.seenChange) {
      this.seenChange = changedAt();
      this.refresh(cx);
    }
    this.takeScmCommand(cx);
  },

  // Menu commands (Open Changes, Stage, ...) arrive on a shared key: checked every COMMAND_MS.
  takeScmCommand(cx) {
    const cmd = shared(COMMAND_KEY);
    if (cmd?.owner !== this.uid || cmd.id === this.seenCmd) {
      return;
    }
    this.seenCmd = cmd.id;
    this.runCmd(cmd, cx);
    cx.notify();
  },

  applyStatus(top, context, results) {
    const { status, staged, unstaged, head } = results;
    const parsed = parseStatus(status.stdout);
    if (top !== this.root) {
      this.amend = false;
    }
    this.root = top;
    this.on = context.on;
    this.source = context.source;
    this.branch = parsed.detached ? null : parsed.branch;
    this.syncPlaceholder();
    this.detached = parsed.detached;
    this.upstream = parsed.upstream;
    this.ahead = parsed.ahead;
    this.behind = parsed.behind;
    this.files = parsed.files;
    this.stats = [parseNumstat(staged.stdout), parseNumstat(unstaged.stdout)];
    this.head = head.code === 0 ? head.stdout.trim() : null;
    this.error = null;
    return `${top}|${this.head}|${parsed.upstream}|${parsed.ahead}|${parsed.behind}|${status.stdout}`;
  },

  async readRepo(context, key, cx) {
    const top = await repoTop(this.tops, context.cwd, context.on);
    if (contextKey(this.scmContext()) !== key) {
      return;
    }
    if (!top) {
      this.root = null;
      this.error = "Not a git repository. Pick a repo in Workspace.";
      return;
    }
    const runGit = (args) => git(args, { cwd: top, on: context.on });
    const startedAt = Date.now();
    const [status, staged, unstaged, head] = await Promise.all([
      runGit(STATUS_ARGS),
      runGit(["diff", "--cached", ...NUMSTAT_ARGS]),
      runGit(["diff", ...NUMSTAT_ARGS]),
      runGit(["rev-parse", "--verify", "-q", "HEAD"]),
    ]);
    if (contextKey(this.scmContext()) !== key) {
      return;
    }
    if (status.code !== 0) {
      throw new Error(status.stderr.trim() || "git status failed");
    }
    // Sections reload only when HEAD, the tree or the upstream moved.
    const signature = this.applyStatus(top, context, { status, staged, unstaged, head });
    this.pollPacer?.note({ changed: signature !== this.sectionsSig, tookMs: Date.now() - startedAt });
    if (signature !== this.sectionsSig) {
      this.sectionsSig = signature;
      this.refreshSections(cx);
    }
  },

  // A refresh asked for while one runs (the repo changed) runs right after it, not on the next timer.
  // `polled` is the timer's: any other caller (a click, a git action, a repo switch) resets the poll to its base rate.
  refresh(cx, polled = false) {
    if (!polled) {
      this.pollPacer?.reset();
    }
    if (this.loading) {
      this.refreshAgain = true;
      return;
    }
    const context = this.scmContext();
    const key = contextKey(context);
    if (!context.cwd) {
      return;
    }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        await this.readRepo(context, key, cx);
      } catch (error) {
        logError("herdr-vscode-changes", "read repo failed", String(error?.message ?? error));
        this.error = String(error?.message ?? error);
      } finally {
        this.loading = false;
        cx.notify();
        if (this.refreshAgain) {
          this.refreshAgain = false;
          this.refresh(cx);
        }
      }
    });
  },

  setView(view, cx) {
    this.view = view;
    setSetting("scm", "view", this.view);
    cx.notify();
  },

  runFileCmd(command, file, cx) {
    switch (command.cmd) {
      case STAGE: return this.index(STAGE, [file], cx);
      case UNSTAGE: return this.index(UNSTAGE, [file], cx);
      case "discard": return this.askDiscard([file]);
      case "openDiff": return this.openDiff(file, command.scope);
      default: return undefined;
    }
  },

  runCmd(command, cx) {
    const file = command.path ? this.files.find((candidate) => candidate.path === command.path) : null;
    if (REMOTE_COMMANDS.has(command.cmd)) {
      return this.askGit(command.cmd, {}, cx);
    }
    switch (command.cmd) {
      case COMMIT: return this.commit(cx, command.then ?? null, command.kind ?? null);
      case AMEND: return this.setAmend(!this.amend, cx);
      case "stageAll": return this.index(STAGE, this.groups().unstaged, cx);
      case "unstageAll": return this.index(UNSTAGE, this.groups().staged, cx);
      case "discardAll": return this.askDiscard(this.groups().unstaged);
      case STAGE:
      case UNSTAGE:
      case "discard":
      case "openDiff": return file && this.runFileCmd(command, file, cx);
      case "openFile": return this.openFile(command.path);
      case "reveal": return exec("open", ["-R", `${this.root}/${command.path}`]).catch(() => {});
      case VIEW_COMMAND: return this.setView(command.value, cx);
      case "stashAsk": return openScmAsk(this.uid, { kind: "stash", staged: Boolean(command.staged) });
      case "stashPush": return this.stashPush(command, cx);
      case "branchAsk": return openScmAsk(this.uid, { kind: "branch", from: this.branch ?? this.head?.slice(0, SHORT_SHA) });
      case "createBranch": return this.createBranch(command, cx);
      case "checkout": return this.branchMenu();
      default: return this.runSectionCmd(command, cx);
    }
  },

  // A write that a dialog already confirmed: run it, report how it went, reread everything.
  runWrite(args, { doing, done }, cx) {
    const root = this.root;
    if (!root || this.busy) {
      return;
    }
    this.busy = true;
    this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const result = await git(args, { cwd: root, on: this.on, timeout: WRITE_TIMEOUT_MS });
        if (result.code !== 0) {
          throw commandFailure(result);
        }
        toast("herdr-vscode-changes", { title: done, body: (result.stdout || result.stderr).trim().split("\n").pop() || undefined, level: "success", timeout: SUCCESS_TIMEOUT_MS });
        bump(root);
      } catch (error) {
        logError("herdr-vscode-changes", `${doing} failed`, String(error?.message ?? error));
        this.note = `${doing} failed: ${error.message}`;
      } finally {
        this.busy = false;
        this.refresh(cx);
      }
    });
  },

  stashPush(command, cx) {
    const args = ["stash", "push"];
    if (command.staged) {
      args.push("--staged");
    } else if (command.untracked) {
      args.push("--include-untracked");
    }
    if (command.value) {
      args.push("-m", command.value);
    }
    this.runWrite(args, { doing: "Stash", done: "Stashed" }, cx);
  },

  createBranch(command, cx) {
    if (!command.value) {
      return;
    }
    const args = command.switch ? ["switch", "-c", command.value] : ["branch", command.value];
    this.runWrite(args, { doing: "New branch", done: command.switch ? `On ${command.value}` : `Created ${command.value}` }, cx);
  },

  gitAction(args, doing, done) {
    return { cmd: "git", args, cwd: this.root, on: this.on ?? null, doing, done, root: this.root };
  },

  // Sync pulls, then pushes, with git's own config (no --rebase / --ff-only flags), like VS Code.
  syncSpec(branch, upstream, ahead, afterCommit) {
    const steps = [];
    if (this.behind || !afterCommit) {
      steps.push({ cmd: "git", args: ["pull"] });
    }
    if (ahead) {
      steps.push({ cmd: "git", args: ["push"] });
    }
    return {
      title: `Sync ${branch} with ${upstream}?`,
      detail: syncDetail(this.behind, ahead, afterCommit),
      label: "Sync",
      danger: Boolean(ahead),
      action: { ...this.gitAction(steps[0].args, "Syncing", `Synced ${branch}`), steps },
    };
  },

  gitSpec(kind, { afterCommit = false } = {}) {
    const name = baseName(this.root);
    const branch = this.branch ?? "HEAD";
    const upstream = this.upstream ?? "its upstream";
    const ahead = this.ahead + (afterCommit ? 1 : 0);
    if (kind === "fetch") {
      return { title: `Fetch ${name}?`, detail: "Downloads new commits and branches from the remote. Nothing local changes.", label: "Fetch", action: this.gitAction(["fetch", "--prune"], "Fetching", `Fetched ${name}`) };
    }
    if (kind === "pull") {
      return { title: `Pull into ${branch}?`, detail: `From ${upstream}, as your git config says.`, label: "Pull", action: this.gitAction(["pull"], "Pulling", `Pulled ${name}`) };
    }
    if (kind === "push") {
      return { title: `Push ${branch}?`, detail: `${afterCommit ? "Your new commit and any others" : plural(ahead, "commit")} go to ${upstream}. Other people will see them.`, label: "Push", danger: true, action: this.gitAction(["push"], "Pushing", `Pushed ${branch}`) };
    }
    if (kind === "publish") {
      return { title: `Publish ${branch}?`, detail: "Pushes the branch to origin and tracks it there. Other people will see it.", label: "Publish", danger: true, action: this.gitAction(["push", "-u", "origin", branch], "Publishing", `Published ${branch}`) };
    }
    return this.syncSpec(branch, upstream, ahead, afterCommit);
  },

  // Fetch, pull, push, sync and publish run with the primary button's spinner until git ends.
  askGit(kind, options, cx) {
    if (!this.root || this.busy) {
      return;
    }
    const needsUpstream = (kind === "push" || kind === "sync") && !this.upstream;
    const resolvedKind = needsUpstream ? "publish" : kind;
    if (resolvedKind === "publish" && !this.branch) {
      this.note = "Detached HEAD: make a branch first.";
      return;
    }
    this.busy = true;
    this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await runAction(this.gitSpec(resolvedKind, options).action);
      } finally {
        this.busy = false;
        this.refresh(cx);
      }
    });
  },

  indexArgs(action, paths) {
    if (action === STAGE) {
      return ["--literal-pathspecs", "add", "--", ...paths];
    }
    if (this.head) {
      return ["--literal-pathspecs", "reset", "-q", "HEAD", "--", ...paths];
    }
    return ["--literal-pathspecs", "rm", "--cached", "-r", "-q", "--", ...paths];
  },

  async runIndex(action, files) {
    const paths = files.filter((file) => !file.conflict).map((file) => file.path);
    for (let i = 0; i < paths.length; i += INDEX_BATCH) {
      const result = await git(this.indexArgs(action, paths.slice(i, i + INDEX_BATCH)), { cwd: this.root, on: this.on });
      if (result.code !== 0) {
        throw commandFailure(result);
      }
    }
    return paths.length;
  },

  // Stage all leaves conflicts alone: staging one marks it resolved with its markers still in.
  index(action, files, cx) {
    if (!this.root || this.busy || !files?.some((file) => !file.conflict)) {
      return;
    }
    this.busy = true;
    this.note = null;
    cx.notify();
    const root = this.root;
    cx.spawn(async (cx) => {
      try {
        await this.runIndex(action, files);
        bump(root);
      } catch (error) {
        logError("herdr-vscode-changes", "stage/unstage failed", String(error?.message ?? error));
        this.note = `${action === STAGE ? "Stage" : "Unstage"} failed: ${error.message}`;
      } finally {
        this.busy = false;
        this.refresh(cx);
      }
    });
  },

  askDiscard(files) {
    const { restore, trash } = discardPlan(files);
    const count = restore.length + trash.length;
    if (!count || !this.root) {
      return;
    }
    const single = count === 1 ? baseName(restore[0] ?? trash[0]) : null;
    const steps = [];
    if (restore.length) {
      steps.push({ cmd: "git", args: ["--literal-pathspecs", "restore", "--worktree", "--", ...restore] });
    }
    if (trash.length) {
      steps.push({ cmd: "trash", args: trash });
    }
    askConfirm(MOD, {
      title: single ? `Discard changes in ${single}?` : `Discard ${count} changes?`,
      detail: discardDetail(restore, trash, single),
      label: "Discard",
      danger: true,
      action: { cmd: steps[0].cmd, args: steps[0].args, steps, cwd: this.root, on: this.on ?? null, doing: "Discarding", done: single ? `Discarded ${single}` : `Discarded ${count} changes`, root: this.root },
    });
  },

  loadAmendMessage(cx) {
    cx.spawn(async (cx) => {
      const result = await git(["log", "-1", "--format=%B"], { cwd: this.root, on: this.on });
      if (result.code === 0 && !this.message.value().trim()) {
        this.message.set_value(result.stdout.trimEnd());
        this.amendLoaded = result.stdout.trimEnd();
      }
      cx.notify();
    });
  },

  setAmend(on, cx) {
    this.amend = on;
    if (on && !this.message.value().trim() && this.head) {
      this.loadAmendMessage(cx);
    } else if (!on && this.amendLoaded && this.message.value() === this.amendLoaded) {
      this.message.set_value("");
      this.amendLoaded = null;
    }
    if (on) {
      this.amendHead = this.head;
    }
    cx.notify();
  },

  groups() {
    return {
      conflicts: this.files.filter((file) => file.conflict),
      staged: this.files.filter((file) => file.staged),
      unstaged: this.files.filter((file) => file.unstaged && !file.conflict),
    };
  },

  primary() {
    const groups = this.groups();
    return primaryAction({
      amend: this.amend, staged: groups.staged.length, unstaged: groups.unstaged.length, conflicts: groups.conflicts.length,
      ahead: this.ahead, behind: this.behind, upstream: this.upstream, branch: this.branch, head: this.head,
      message: this.message.value(), busy: this.busy || !this.root,
    });
  },

  commitMode(primary, kind) {
    if (this.amend) {
      return AMEND;
    }
    return kind ?? (primary.kind === COMMIT_ALL ? COMMIT_ALL : COMMIT);
  },

  // Returns true when the commit can go ahead; may set a note explaining why not.
  canCommit(mode, message, groups) {
    if (!this.root || this.busy || !message || groups.conflicts.length) {
      return false;
    }
    if (mode === COMMIT && !groups.staged.length) {
      this.note = "Nothing staged. Use Commit All, or stage files first.";
      return false;
    }
    if (mode === COMMIT_ALL && !groups.staged.length && !groups.unstaged.length) {
      return false;
    }
    return mode !== AMEND || Boolean(this.head);
  },

  async runCommit({ mode, message, root, expectedHead, unstaged }) {
    if (mode === AMEND) {
      const head = await git(["rev-parse", "--verify", "HEAD"], { cwd: root, on: this.on });
      if (head.stdout.trim() !== expectedHead) {
        throw new Error("the latest commit changed since you chose Amend; choose it again");
      }
    }
    if (mode === COMMIT_ALL) {
      await this.runIndex(STAGE, unstaged);
    }
    const result = await git([COMMIT, ...(mode === AMEND ? ["--amend"] : []), "-m", message], { cwd: root, on: this.on, timeout: WRITE_TIMEOUT_MS });
    if (result.code !== 0) {
      throw commandFailure(result);
    }
    toast("herdr-vscode-changes", { title: mode === AMEND ? "Amended" : "Committed", body: result.stdout.split("\n")[0], level: "success", timeout: SUCCESS_TIMEOUT_MS });
    if (this.message.value().trim() === message) {
      this.message.set_value("");
    }
    this.amend = false;
    this.amendLoaded = null;
    bump(root);
  },

  // then: null | "push" | "sync"; kind forces "commit" / "commitAll" from the ⌄ menu.
  commit(cx, then = null, kind = null) {
    const primary = this.primary();
    if (!kind && (primary.kind === "sync" || primary.kind === "publish")) {
      return primary.enabled && this.askGit(primary.kind, {}, cx);
    }
    const groups = this.groups();
    const mode = this.commitMode(primary, kind);
    const message = this.message.value().trim();
    if (!this.canCommit(mode, message, groups)) {
      return undefined;
    }
    const root = this.root;
    const expectedHead = this.amendHead;
    this.busy = true;
    this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      let committed = false;
      try {
        await this.runCommit({ mode, message, root, expectedHead, unstaged: groups.unstaged });
        committed = true;
      } catch (error) {
        logError("herdr-vscode-changes", "commit failed", String(error?.message ?? error));
        this.note = `${mode === AMEND ? "Amend" : "Commit"} failed: ${error.message}`;
      } finally {
        this.busy = false;
        this.refresh(cx);
      }
      if (committed && then && this.root === root) {
        this.askGit(then, { afterCommit: true }, cx);
      }
    });
    return undefined;
  },

  toggleGroup(id, cx) {
    if (!this.closed.delete(id)) {
      this.closed.add(id);
    }
    localStorage.setItem(CLOSED_KEY, JSON.stringify([...this.closed]));
    cx.notify();
  },

  // A group's "Open Changes": the diff of its first file (the viewer shows one diff per space).
  openAll(files, scope) {
    if (files[0]) {
      this.openDiff(files[0], scope);
    }
  },

  openDiff(file, scope) {
    showInViewer(MOD, { root: this.root, on: this.on ?? null, path: file.path, scope, untracked: file.untracked }, baseName(file.path));
  },

  openFile(path) {
    showInViewer(FILES_MOD, { root: this.root, on: this.on ?? null, rel: path }, baseName(path));
  },

  fileMenu(file, scope) {
    const isStaged = scope === STAGED;
    const deleted = isStaged ? file.x === "D" : file.y === "D";
    const indexItem = isStaged
      ? { id: UNSTAGE, icon: "minus", label: "Unstage Changes", cmd: { cmd: UNSTAGE, path: file.path } }
      : { id: STAGE, icon: "plus", label: "Stage Changes", cmd: { cmd: STAGE, path: file.path }, disabled: file.conflict };
    openScmMenu(this.uid, [
      { id: "diff", icon: "split", label: "Open Changes", cmd: { cmd: "openDiff", path: file.path, scope } },
      { id: "file", icon: "file-code", label: "Open File", cmd: { cmd: "openFile", path: file.path }, disabled: deleted },
      { sep: true, id: "s1" },
      indexItem,
      { id: "discard", icon: "discard", label: "Discard Changes…", color: theme().ansi1, cmd: { cmd: "discard", path: file.path }, disabled: isStaged || file.conflict },
      { sep: true, id: "s2" },
      { id: "reveal", icon: "folder", label: "Reveal in Finder", cmd: { cmd: "reveal", path: file.path }, disabled: deleted },
      { id: "copy", icon: "copy", label: "Copy Path", copy: `${this.root}/${file.path}` },
      { id: "copyrel", icon: "copy", label: "Copy Relative Path", copy: file.path },
    ]);
  },

  pullSub(upstream) {
    if (this.behind) {
      return `↓${this.behind}`;
    }
    return upstream ? "" : "no upstream";
  },

  moreMenu() {
    const colors = theme();
    const upstream = this.upstream;
    openScmMenu(this.uid, [
      { header: "Remote", id: "h1" },
      { id: "pull", icon: "arrow-down", color: colors.ansi4, label: "Pull", sub: this.pullSub(upstream), subColor: colors.ansi4, cmd: { cmd: "pull" }, disabled: !upstream },
      { id: "push", icon: "arrow-up", color: colors.ansi6, label: upstream ? "Push" : "Publish Branch", sub: this.ahead ? `↑${this.ahead}` : "", subColor: colors.ansi6, cmd: { cmd: upstream ? "push" : "publish" }, disabled: !this.branch },
      { id: "sync", icon: "sync", color: colors.accent, label: "Sync…", sub: "pull, then push", cmd: { cmd: "sync" }, disabled: !upstream },
      { id: "fetch", icon: "cloud", color: colors.muted, label: "Fetch…", cmd: { cmd: "fetch" } },
      { header: "Stash", id: "h2" },
      { id: "stash", icon: "archive", color: colors.ansi5, label: "Stash Changes…", cmd: { cmd: "stashAsk" }, disabled: !this.files.length },
      { id: "stash-staged", icon: "archive", color: colors.ansi5, label: "Stash Staged…", cmd: { cmd: "stashAsk", staged: true }, disabled: !this.groups().staged.length },
      { header: "Branch", id: "h3" },
      { id: "checkout", icon: "branch", color: colors.ansi2, label: "Checkout to…", sub: this.branch ?? "", cmd: { cmd: "checkout" } },
      { id: "branch", icon: "branch-plus", color: colors.ansi2, label: "New Branch…", cmd: { cmd: "branchAsk" } },
      { id: "graph", icon: "pipeline", color: colors.accent, label: "Open Commit Graph", cmd: { cmd: "graph" } },
      { sep: true, id: "s1" },
      { id: VIEW_FLAT, icon: "list", label: "View as List", checked: this.view === VIEW_FLAT, cmd: { cmd: VIEW_COMMAND, value: VIEW_FLAT } },
      { id: VIEW_TREE, icon: "list-tree", label: "View as Tree", checked: this.view === VIEW_TREE, cmd: { cmd: VIEW_COMMAND, value: VIEW_TREE } },
    ]);
  },

  commitMenu() {
    const colors = theme();
    const groups = this.groups();
    const noMessage = !this.message.value().trim();
    const all = !groups.staged.length;
    const kind = all ? COMMIT_ALL : COMMIT;
    openScmMenu(this.uid, [
      { id: "c", icon: "commit-check", color: colors.accent, label: all ? "Commit All" : "Commit", sub: all ? `${groups.unstaged.length}` : `${groups.staged.length} staged`, cmd: { cmd: COMMIT, kind }, disabled: noMessage || this.amend },
      { id: "cp", icon: "arrow-up", color: colors.ansi6, label: all ? "Commit All & Push" : "Commit & Push", cmd: { cmd: COMMIT, kind, then: "push" }, disabled: noMessage || this.amend || !this.branch },
      { id: "cs", icon: "sync", color: colors.ansi4, label: all ? "Commit All & Sync" : "Commit & Sync", cmd: { cmd: COMMIT, kind, then: "sync" }, disabled: noMessage || this.amend || !this.upstream },
      { sep: true, id: "s1" },
      { id: AMEND, icon: "pencil", color: colors.ansi3, label: "Amend Last Commit", checked: this.amend, tip: "Rewrite the latest commit. Careful if it's already pushed.", cmd: { cmd: AMEND }, disabled: !this.head },
    ], COMMIT_MENU_WIDTH);
  },

  hoverable(el, key) {
    return el.on_hover((on, cx) => {
      if (on) {
        this.hot = key;
      } else if (this.hot === key) {
        this.hot = null;
      }
      cx.notify();
    });
  },

  pill(text, color) {
    return div().flex_none().h(16).min_w(18).px(5).flex().items_center().justify_center().rounded(8)
      .bg(tint(color, "26")).text_size(TEXT.tiny).font_medium().text_color(color).child(String(text));
  },

  // VS Code's count badge: grey, rounded, right-aligned.
  countBadge(colors, count) {
    const badge = BADGE[tone(colors)];
    return div().flex_none().h(18).min_w(18).px(6).flex().items_center().justify_center().rounded(9)
      .bg(badge.bg).text_size(TEXT.caption).text_color(badge.fg).child(String(count));
  },

  fileTooltip(file, stat) {
    const conflict = file.conflict ? ` · ${file.conflictKind}` : "";
    const counts = stat && !stat.binary ? ` · +${stat.add} −${stat.del}` : "";
    return `${file.path}${conflict}${counts}\nClick: changes · double-click: file · right-click: more`;
  },

  fileRowActions(file, scope, key, deleted) {
    const isStaged = scope === STAGED;
    const button = (id, icon, label, onClick) => IconButton({ id: `${id}-${key}`, icon, label, size: 20, disabled: this.busy, onClick });
    const actions = [];
    if (!deleted) {
      actions.push(button("of", "file-code", "Open File", () => this.openFile(file.path)));
    }
    if (!isStaged && !file.conflict) {
      actions.push(button("dc", "discard", "Discard Changes…", () => this.askDiscard([file])));
    }
    if (!file.conflict) {
      actions.push(button("st", isStaged ? "minus" : "plus", isStaged ? "Unstage" : "Stage", (cx) => this.index(isStaged ? UNSTAGE : STAGE, [file], cx)));
    }
    return actions;
  },

  clickFile(event, file, scope, key, deleted, cx) {
    this.selected = key;
    if (event.click_count >= 2 && !deleted) {
      this.openFile(file.path);
    } else {
      this.openDiff(file, scope);
    }
    cx.notify();
  },

  fileRow(colors, file, scope, depth = 0) {
    const stat = scope === STAGED ? this.stats[0][file.path] : this.stats[1][file.path];
    const letter = file.conflict ? "C" : scope === STAGED ? stagedLetter(file) : unstagedLetter(file);
    const color = decorationColor(colors, letter, file.conflict);
    const slash = file.path.lastIndexOf("/");
    const name = file.path.slice(slash + 1);
    const dir = this.view === VIEW_FLAT && slash > 0 ? file.path.slice(0, slash) : "";
    const key = `${scope}:${file.path}`;
    const selected = this.selected === key;
    const hot = this.hot === key;
    const deleted = letter === "D";
    const row = h_flex().id(`c-${key}`).h(ROW_HEIGHT).flex_none().pr(12).gap(6).items_center()
      .bg(selected ? colors.selected : hot ? colors.hover : TRANSPARENT).cursor_pointer().text_size(TEXT.body)
      .tooltip(this.fileTooltip(file, stat))
      .on_click((event, cx) => this.clickFile(event, file, scope, key, deleted, cx))
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        this.selected = key;
        this.fileMenu(file, scope);
        cx.notify();
      })
      .child(twistieSlot(null))
      .child(FileIcon(this.icons, file.path, { size: 16 }))
      .child(div().flex_shrink(1).min_w(30).truncate().text_color(color).when(deleted, (el) => el.line_through()).child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(TEXT.small).text_color(colors.dim).child(file.conflict ? file.conflictKind : dir));
    if (hot) {
      row.children(this.fileRowActions(file, scope, key, deleted));
    }
    row.child(div().w(12).flex_none().text_right().text_size(TEXT.small).text_color(color).child(letter));
    return this.hoverable(withTreeIndent(row, colors, { depth: depth + 1, height: ROW_HEIGHT, firstLevel: 1, hovered: this.treeHovered }), key);
  },

  // Like VS Code, a folder's hover actions act on every changed file under it.
  folderRowActions(files, scope, id) {
    const isStaged = scope === STAGED;
    const ready = files.filter((file) => !file.conflict);
    const button = (key, icon, label, onClick) => IconButton({ id: `${key}-${id}`, icon, label, size: 20, disabled: this.busy || !ready.length, onClick });
    const actions = [];
    if (!isStaged) {
      actions.push(button("dd", "discard", "Discard Changes…", () => this.askDiscard(ready)));
    }
    actions.push(button("ds", isStaged ? "minus" : "plus", isStaged ? "Unstage" : "Stage", (cx) => this.index(isStaged ? UNSTAGE : STAGE, ready, cx)));
    return actions;
  },

  folderRow(colors, id, label, depth, open, files, scope) {
    const key = `dir:${id}`;
    const row = h_flex().id(`d-${id}`).h(ROW_HEIGHT).flex_none().pr(12).gap(2).items_center().cursor_pointer()
      .bg(this.hot === key ? colors.hover : TRANSPARENT)
      .text_size(TEXT.body).text_color(colors.foreground).on_click((_e, cx) => this.toggleGroup(id, cx))
      .child(twistieSlot(Icon(open ? "chevron-down" : "chevron-right", 14).text_color(colors.dim)))
      .child(FileIcon(this.icons, label.split("/").pop(), { dir: true, open, size: 16 }))
      .child(div().flex_1().min_w(0).truncate().child(label));
    if (this.hot === key) {
      row.children(this.folderRowActions(files, scope, id));
    }
    return this.hoverable(withTreeIndent(row, colors, { depth: depth + 1, height: ROW_HEIGHT, firstLevel: 1, hovered: this.treeHovered }), key);
  },

  walkTree(colors, node, scope, depth, prefix, out) {
    for (const [name, child] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      const folded = foldSingleChildren(name, child);
      const id = `${scope}:${prefix}${folded.label}`;
      const open = !this.closed.has(id);
      out.push(this.folderRow(colors, id, folded.label, depth, open, filesUnder(folded.node), scope));
      if (open) {
        this.walkTree(colors, folded.node, scope, depth + 1, `${prefix}${folded.label}/`, out);
      }
    }
    for (const file of node.files.sort((a, b) => a.path.localeCompare(b.path))) {
      out.push(this.fileRow(colors, file, scope, depth));
    }
  },

  treeRows(colors, files, scope) {
    const out = [];
    this.walkTree(colors, buildTree(files), scope, 0, "", out);
    return out;
  },

  // A VS Code resource group row: twistie, label, hover actions, count badge.
  groupHead(colors, id, label, count, _color, _icon, actions = []) {
    const open = !this.closed.has(id);
    const key = `g:${id}`;
    const row = h_flex().id(`g-${id}`).h(GROUP_HEIGHT).flex_none().pl(treePadding(0)).pr(12).gap(2).items_center().cursor_pointer()
      .bg(this.hot === key ? colors.hover : TRANSPARENT).on_click((_e, cx) => this.toggleGroup(id, cx))
      .child(twistieSlot(Icon(open ? "chevron-down" : "chevron-right", 14).text_color(colors.foreground)))
      .child(div().flex_1().min_w(0).truncate().text_size(TEXT.body).text_color(colors.foreground).child(label))
      .when(this.hot === key, (el) => el.gap(4).children(actions))
      .when(count !== null, (el) => el.child(this.countBadge(colors, count)));
    return this.hoverable(row, key);
  },

  group(colors, id, label, files, scope, color, icon, actions) {
    if (!files.length) {
      return [];
    }
    const open = !this.closed.has(id);
    const shown = files.slice(0, SHOWN_FILES_LIMIT);
    const out = [this.groupHead(colors, id, label, files.length, color, icon, actions)];
    if (!open) {
      return out;
    }
    out.push(...(this.view === VIEW_TREE ? this.treeRows(colors, shown, scope) : shown.map((file) => this.fileRow(colors, file, scope))));
    if (files.length > SHOWN_FILES_LIMIT) {
      out.push(Message(`Showing ${SHOWN_FILES_LIMIT} of ${files.length}.`));
    }
    return out;
  },

  // VS Code 1.9x's Graph section at the bottom of Source Control: the commit graph.
  graphGroup(colors) {
    const open = !this.closed.has(GRAPH_GROUP);
    const out = [this.groupHead(colors, GRAPH_GROUP, "Graph", null, null, null, [
      IconButton({ id: "gr-open", icon: "pipeline", label: "Open Commit Graph", size: 20, onClick: () => this.runCmd({ cmd: "graph" }) }),
    ])];
    if (open) {
      out.push(...this.sectionBody(colors, COMMITS_SECTION, this.data[COMMITS_SECTION]));
    }
    return out;
  },

  messageCard(colors) {
    const info = subjectInfo(this.message.value());
    const infoColor = info.level === "over" ? colors.ansi1 : info.level === "long" ? colors.ansi3 : colors.dim;
    return v_flex().id("c-card").flex_none().rounded(2).border_1().border_color(this.amend ? colors.ansi3 : colors.border).bg(colors.input ?? colors.background)
      .on_key_down((event, cx) => {
        // ⌘Enter, ⌥Enter and ⌃Enter commit; a plain Enter is a new line.
        const modifiers = event.modifiers ?? {};
        if (event.key !== "enter" || !(modifiers.platform || modifiers.alt || modifiers.control)) {
          return;
        }
        cx.stop_propagation();
        this.commit(cx);
      })
      .child(Textarea.new(this.message).id("c-msg").w_full().min_h(26).px(6).pt(4).text_size(TEXT.body))
      .when(this.amend || info.len > 0, (el) => el.child(h_flex().h(20).flex_none().px(6).gap(6).items_center()
        .when(this.amend, (el) => el.child(h_flex().h(16).px(6).gap(4).items_center().rounded(8).bg(tint(colors.ansi3, "26")).text_size(TEXT.tiny).text_color(colors.ansi3)
          .child(Icon("pencil", 9)).child("AMEND")))
        .child(div().flex_1())
        .when(info.len > 0, (el) => el.child(div().id("c-len").text_size(TEXT.tiny).text_color(infoColor).tooltip("Subject line length: 50 is tidy, 72 is the limit").child(`${info.len}`)))));
  },

  // VS Code's primary action button: full width, blue, with a split dropdown.
  commitButton(colors) {
    const primary = this.primary();
    const solid = primary.enabled;
    const accent = primary.kind === AMEND ? colors.ansi3 : colors.accent;
    const background = solid ? accent : tint(accent, DISABLED_BUTTON_ALPHA);
    const foreground = colors.accent_foreground ?? "#ffffff";
    const label = primary.kind === COMMIT_ALL ? "Commit" : primary.label;
    return h_flex().id("c-commit-row").h(26).flex_none().rounded(2).overflow_hidden().bg(background)
      .child(h_flex().id("c-commit").flex_1().h_full().gap(6).items_center().justify_center().text_size(TEXT.body).text_color(solid ? foreground : tint(foreground, "b0"))
        .tooltip(primary.tip)
        .when(solid, (el) => el.cursor_pointer().hover((style) => style.bg(tint(PRESSED_TINT, "14"))).on_click((_e, cx) => this.commit(cx)))
        .child(this.busy ? Icon("spinner", 14).spin(SPIN_MS) : Icon(primaryIcon(primary.kind), 14))
        .child(label)
        .when(primary.kind === "sync", (el) => el.child(div().child(`${primary.behind}↓ ${primary.ahead}↑`))))
      .child(div().w(1).h(16).flex_none().bg(tint(foreground, "40")))
      .child(div().id("c-commit-more").w(24).h_full().flex_none().flex().items_center().justify_center().cursor_pointer().text_color(foreground)
        .hover((style) => style.bg(tint(PRESSED_TINT, "14"))).tooltip("More Actions…")
        .on_click(() => this.commitMenu())
        .child(Icon("chevron-down", 14)));
  },

  dismissNote(cx) {
    this.note = null;
    cx.notify();
  },

  commitBox(colors) {
    return v_flex().flex_none().pl(20).pr(12).pt(2).pb(6).gap(6)
      .child(this.messageCard(colors))
      .child(this.commitButton(colors))
      .when(Boolean(this.note), (el) => el.child(h_flex().gap(6).items_start().px(8).py(6).rounded(6).bg(tint(colors.ansi1, "1a"))
        .child(Icon("alert", 12).text_color(colors.ansi1))
        .child(div().flex_1().min_w(0).text_size(TEXT.small).text_color(colors.ansi1).whitespace_normal().child(this.note))
        .child(IconButton({ id: "c-note-x", icon: "x", label: "Dismiss", size: 18, onClick: (cx) => this.dismissNote(cx) }))));
  },

  // VS Code's view title actions: Commit, Refresh, More. The repo picker shows only with more
  // than one repo (VS Code's Repositories section); the branch is in the message placeholder.
  panelHead() {
    const repos = workspace()?.roots?.length ?? 0;
    return h_flex().h(28).flex_none().pl(4).pr(8).gap(2).items_center()
      .when(repos > 1, (el) => el.child(RepoButton(this, MOD, this.root)))
      .child(div().flex_1())
      .child(IconButton({ id: "c-title-commit", icon: "check", label: `Commit${this.branch ? ` on "${this.branch}"` : ""} (⌘Enter)`, size: 22, disabled: !this.primary().enabled, onClick: (cx) => this.commit(cx) }))
      .child(IconButton({ id: "c-refresh", icon: "refresh", label: "Refresh", spinning: Boolean(this.loading || this.busy), size: 22, onClick: (cx) => this.refresh(cx) }))
      .child(IconButton({ id: "c-more", icon: "more", label: "More Actions… (View as Tree/List, Pull, Push, Checkout, Stash)", size: 22, onClick: () => this.moreMenu() }));
  },

  cleanTree(colors) {
    return h_flex().mx(10).my(4).px(10).py(8).gap(8).items_center().rounded(6).bg(tint(colors.ansi2, "14"))
      .child(Icon("check", 13).text_color(colors.ansi2)).child(div().text_size(TEXT.small).text_color(colors.muted).child("Working tree clean"));
  },

  renderPanel() {
    const colors = theme();
    const groups = this.groups();
    const panel = v_flex().id(MOD).size_full().min_w(0).min_h(0).overflow_hidden().bg(colors.background).text_color(colors.foreground).child(this.panelHead());
    if (!this.root) {
      return panel.child(Message(this.error ?? "Pick a repo in Workspace, or focus a terminal inside one."));
    }
    const body = v_flex().id("c-body").flex_1().min_h(0).overflow_y_scrollbar().pb(8).gap(1)
      .on_hover((hovered, cx) => {
        this.treeHovered = hovered;
        cx.notify();
      });
    if (this.part === HISTORY_PART) {
      return panel.child(body.children(this.renderSections(colors)));
    }
    body.child(this.commitBox(colors));
    body.children(this.group(colors, "conflicts", "Merge Changes", groups.conflicts, "conflict", colors.ansi1, "merge", [
      IconButton({ id: "ga-open-conflicts", icon: "files", label: "Open Changes", size: 20, onClick: () => this.openAll(groups.conflicts, "conflict") }),
    ]));
    body.children(this.group(colors, STAGED, "Staged Changes", groups.staged, STAGED, colors.ansi2, "check", [
      IconButton({ id: "ga-open-staged", icon: "files", label: "Open Changes", size: 20, onClick: () => this.openAll(groups.staged, STAGED) }),
      IconButton({ id: "ga-unstage", icon: "minus", label: "Unstage All Changes", size: 20, disabled: this.busy, onClick: (cx) => this.index(UNSTAGE, groups.staged, cx) }),
    ]));
    body.children(this.group(colors, "unstaged", "Changes", groups.unstaged, "unstaged", colors.ansi3, "pencil", [
      IconButton({ id: "ga-open", icon: "files", label: "Open Changes", size: 20, onClick: () => this.openAll(groups.unstaged, "unstaged") }),
      IconButton({ id: "ga-discard", icon: "discard", label: "Discard All Changes…", size: 20, disabled: this.busy, onClick: () => this.askDiscard(groups.unstaged) }),
      IconButton({ id: "ga-stage", icon: "plus", label: "Stage All Changes", size: 20, disabled: this.busy, onClick: (cx) => this.index(STAGE, groups.unstaged, cx) }),
    ]));
    if (!this.files.length && !this.loading) {
      body.child(this.cleanTree(colors));
    }
    body.children(this.graphGroup(colors));
    return panel.child(body);
  },
};
