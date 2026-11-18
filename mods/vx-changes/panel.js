// Source Control, VS Code's way: the commit box on top (⌘Enter commits, the ⌄ has Commit & Push / Sync / Amend), then Merge / Staged / Changes, then the
// GitLens sections (sections.js).
//
// Writes, and how they're guarded:
//   stage / unstage / commit      buttons (index and a new commit only)
//   discard                       asks; edited files go back to the index copy, new files to the Trash
//   push / pull / sync / publish  ask (actions.js), like the status bar's
//   stash / new branch            a dialog you fill in is the ask
import { div } from "gpui-kit";
import { v_flex, h_flex, Textarea } from "gpui-base";
import { theme, notify, shared, exec } from "herdr";
import { ctx, contextKey, git, repoTop, changedAt, bump, baseName } from "./ws.js";
import { parseStatus, parseNumstat } from "./git-core.js";
import { primaryAction, discardPlan, statBlocks, subjectInfo } from "./scm-core.js";
import { TEXT, Icon, IconButton, FileIcon, Message, markColor, tint, SPIN_MS } from "./ui.js";
import { showInViewer } from "./tabs.js";
import { RepoButton } from "./repo-picker.js";
import { askConfirm } from "./actions.js";
import { openScmMenu, openScmAsk } from "./scm-popups.js";

const MOD = "vx-changes";
const LIMIT = 1000;
const ROW = 24;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const panelMethods = {
  initPanel(cx) {
    this.uid = `scm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    this.tops = new Map();
    this.files = [];
    this.stats = [{}, {}];
    try {
      this.closed = new Set(JSON.parse(localStorage.getItem("closed") ?? "[]"));
    } catch {
      this.closed = new Set();
    }
    this.view = localStorage.getItem("view") === "tree" ? "tree" : "flat";
    this.amend = false;
    this.ahead = 0;
    this.behind = 0;
    this.message.on("change", (_e, cx) => cx.notify());
  },

  followPanel(cx) {
    const c = ctx();
    const key = contextKey(c);
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
    // Commands from our popups and dialogs (scm-popups.js), addressed to this copy only.
    const cmd = shared("vx.changes.cmd");
    if (cmd?.owner === this.uid && cmd.id !== this.seenCmd) {
      this.seenCmd = cmd.id;
      this.runCmd(cmd, cx);
    }
  },

  refresh(cx) {
    if (this.loading) return;
    const c = ctx();
    const key = contextKey(c);
    if (!c.cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await repoTop(this.tops, c.cwd, c.on);
        if (contextKey(ctx()) !== key) return;
        if (!top) {
          this.root = null;
          this.error = "Not a git repository. Pick a repo in Workspace.";
          return;
        }
        const g = (args) => git(args, { cwd: top, on: c.on });
        const [st, staged, unstaged, head] = await Promise.all([
          g(["status", "--porcelain=v1", "-z", "-b", "--no-renames", "--untracked-files=all"]),
          g(["diff", "--cached", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv"]),
          g(["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv"]),
          g(["rev-parse", "--verify", "-q", "HEAD"]),
        ]);
        if (contextKey(ctx()) !== key) return;
        if (st.code !== 0) throw new Error(st.stderr.trim() || "git status failed");
        const s = parseStatus(st.stdout);
        if (top !== this.root) this.amend = false;
        this.root = top;
        this.on = c.on;
        this.source = c.source;
        this.branch = s.detached ? null : s.branch;
        this.detached = s.detached;
        this.upstream = s.upstream;
        this.ahead = s.ahead;
        this.behind = s.behind;
        this.files = s.files;
        this.stats = [parseNumstat(staged.stdout), parseNumstat(unstaged.stdout)];
        this.head = head.code === 0 ? head.stdout.trim() : null;
        this.error = null;
        // Sections (commits, branches...) reload only when HEAD, the tree or the upstream moved.
        const sig = `${top}|${this.head}|${s.upstream}|${s.ahead}|${s.behind}|${st.stdout}`;
        if (sig !== this.sectionsSig) {
          this.sectionsSig = sig;
          this.refreshSections(cx);
        }
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  },

  // ── commands from popups ───────────────────────────────────────────────────────────────
  runCmd(c, cx) {
    const file = c.path ? this.files.find((f) => f.path === c.path) : null;
    switch (c.cmd) {
      case "commit": return this.commit(cx, c.then ?? null, c.kind ?? null);
      case "amend": return this.setAmend(!this.amend, cx);
      case "stageAll": return this.index("stage", this.groups().unstaged, cx);
      case "unstageAll": return this.index("unstage", this.groups().staged, cx);
      case "discardAll": return this.askDiscard(this.groups().unstaged);
      case "stage": return file && this.index("stage", [file], cx);
      case "unstage": return file && this.index("unstage", [file], cx);
      case "discard": return file && this.askDiscard([file]);
      case "openFile": return this.openFile(c.path);
      case "openDiff": return file && this.openDiff(file, c.scope);
      case "reveal": return exec("open", ["-R", `${this.root}/${c.path}`]).catch(() => {});
      case "view": this.view = c.value; localStorage.setItem("view", this.view); return cx.notify();
      case "fetch": case "pull": case "push": case "sync": case "publish": return this.askGit(c.cmd);
      case "stashAsk": return openScmAsk(this.uid, { kind: "stash", staged: Boolean(c.staged) });
      case "stashPush": return this.stashPush(c, cx);
      case "branchAsk": return openScmAsk(this.uid, { kind: "branch", from: this.branch ?? this.head?.slice(0, 8) });
      case "createBranch": return this.createBranch(c, cx);
      default: return this.runSectionCmd(c, cx);
    }
  },

  // A write that a dialog already confirmed: run it, tell how it went, reread everything.
  runWrite(args, { doing, done }, cx) {
    const root = this.root;
    if (!root || this.busy) return;
    this.busy = true;
    this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await git(args, { cwd: root, on: this.on, timeout: 120000 });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        notify({ title: done, body: (r.stdout || r.stderr).trim().split("\n").pop() || undefined, level: "success", timeout: 3000 });
        bump(root);
      } catch (e) {
        this.note = `${doing} failed: ${e.message}`;
      } finally {
        this.busy = false;
        this.refresh(cx);
      }
    });
  },

  stashPush(c, cx) {
    const args = ["stash", "push"];
    if (c.staged) args.push("--staged");
    else if (c.untracked) args.push("--include-untracked");
    if (c.value) args.push("-m", c.value);
    this.runWrite(args, { doing: "Stash", done: "Stashed" }, cx);
  },

  createBranch(c, cx) {
    if (!c.value) return;
    this.runWrite(c.switch ? ["switch", "-c", c.value] : ["branch", c.value], { doing: "New branch", done: c.switch ? `On ${c.value}` : `Created ${c.value}` }, cx);
  },

  // ── remote: fetch, pull, push, sync, publish (they all ask) ────────────────────────────
  gitSpec(kind, { afterCommit = false } = {}) {
    const name = baseName(this.root);
    const b = this.branch ?? "HEAD";
    const up = this.upstream ?? "its upstream";
    const ahead = this.ahead + (afterCommit ? 1 : 0);
    const action = (args, doing, done) => ({ cmd: "git", args, cwd: this.root, on: this.on ?? null, doing, done, root: this.root });
    if (kind === "fetch") return { title: `Fetch ${name}?`, detail: "Downloads new commits and branches from the remote. Nothing local changes.", label: "Fetch", action: action(["fetch", "--prune"], "Fetching", `Fetched ${name}`) };
    if (kind === "pull") return { title: `Pull into ${b}?`, detail: `Fast-forward only from ${up}. Stops instead of merging if your branch has diverged.`, label: "Pull", action: action(["pull", "--ff-only"], "Pulling", `Pulled ${name}`) };
    if (kind === "push") return { title: `Push ${b}?`, detail: `${afterCommit ? "Your new commit and any others" : plural(ahead, "commit")} go to ${up}. Other people will see them.`, label: "Push", danger: true, action: action(["push"], "Pushing", `Pushed ${b}`) };
    if (kind === "publish") return { title: `Publish ${b}?`, detail: "Pushes the branch to origin and tracks it there. Other people will see it.", label: "Publish", danger: true, action: action(["push", "-u", "origin", b], "Publishing", `Published ${b}`) };
    // sync: pull (rebasing unpushed commits on top), then push
    const steps = [];
    if (this.behind || !afterCommit) steps.push({ cmd: "git", args: ahead ? ["pull", "--rebase"] : ["pull", "--ff-only"] });
    if (ahead) steps.push({ cmd: "git", args: ["push"] });
    return {
      title: `Sync ${b} with ${up}?`,
      detail: `${this.behind ? `Pulls ${plural(this.behind, "commit")}${ahead ? ", replaying your unpushed commits on top" : ""}` : "Pulls anything new"}${ahead ? `, then pushes ${afterCommit ? "your commits" : plural(ahead, "commit")}. Other people will see them.` : "."}`,
      label: "Sync", danger: Boolean(ahead),
      action: { ...action(steps[0].args, "Syncing", `Synced ${b}`), steps },
    };
  },

  askGit(kind, opts) {
    if (!this.root) return;
    if ((kind === "push" || kind === "sync") && !this.upstream) kind = "publish";
    if (kind === "publish" && !this.branch) return void (this.note = "Detached HEAD: make a branch first.");
    askConfirm(MOD, this.gitSpec(kind, opts));
  },

  // ── index ──────────────────────────────────────────────────────────────────────────────
  indexArgs(action, paths) {
    if (action === "stage") return ["--literal-pathspecs", "add", "--", ...paths];
    if (this.head) return ["--literal-pathspecs", "reset", "-q", "HEAD", "--", ...paths];
    return ["--literal-pathspecs", "rm", "--cached", "-r", "-q", "--", ...paths];
  },

  async runIndex(action, files) {
    const paths = files.filter((f) => !f.conflict).map((f) => f.path);
    for (let i = 0; i < paths.length; i += 200) {
      const r = await git(this.indexArgs(action, paths.slice(i, i + 200)), { cwd: this.root, on: this.on });
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
    }
    return paths.length;
  },

  // Stage all leaves conflicts alone: staging one marks it resolved with its markers still in.
  index(action, files, cx) {
    if (!this.root || this.busy || !files?.some((f) => !f.conflict)) return;
    this.busy = true;
    this.note = null;
    cx.notify();
    const root = this.root;
    cx.spawn(async (cx) => {
      try {
        await this.runIndex(action, files);
        bump(root);
      } catch (e) {
        this.note = `${action === "stage" ? "Stage" : "Unstage"} failed: ${e.message}`;
      } finally {
        this.busy = false;
        this.refresh(cx);
      }
    });
  },

  askDiscard(files) {
    const { restore, trash } = discardPlan(files);
    const n = restore.length + trash.length;
    if (!n || !this.root) return;
    const one = n === 1 ? baseName(restore[0] ?? trash[0]) : null;
    const steps = [];
    if (restore.length) steps.push({ cmd: "git", args: ["--literal-pathspecs", "restore", "--worktree", "--", ...restore] });
    if (trash.length) steps.push({ cmd: "trash", args: trash });
    askConfirm(MOD, {
      title: one ? `Discard changes in ${one}?` : `Discard ${n} changes?`,
      detail: [restore.length ? `${one ? "It goes" : `${plural(restore.length, "edited file")} go`} back to the last staged or committed version.` : "",
        trash.length ? `${one ? "This new file goes" : `${plural(trash.length, "new file")} go`} to the Trash.` : "",
        "Staged changes stay."].filter(Boolean).join(" "),
      label: "Discard", danger: true,
      action: { cmd: steps[0].cmd, args: steps[0].args, steps, cwd: this.root, on: this.on ?? null, doing: "Discarding", done: one ? `Discarded ${one}` : `Discarded ${n} changes`, root: this.root },
    });
  },

  // ── commit ─────────────────────────────────────────────────────────────────────────────
  setAmend(on, cx) {
    this.amend = on;
    if (on && !this.message.value().trim() && this.head) {
      cx.spawn(async (cx) => {
        const r = await git(["log", "-1", "--format=%B"], { cwd: this.root, on: this.on });
        if (r.code === 0 && !this.message.value().trim()) {
          this.message.set_value(r.stdout.trimEnd());
          this.amendLoaded = r.stdout.trimEnd();
        }
        cx.notify();
      });
    } else if (!on && this.amendLoaded && this.message.value() === this.amendLoaded) {
      this.message.set_value("");
      this.amendLoaded = null;
    }
    if (on) this.amendHead = this.head;
    cx.notify();
  },

  groups() {
    return {
      conflicts: this.files.filter((f) => f.conflict),
      staged: this.files.filter((f) => f.staged),
      unstaged: this.files.filter((f) => f.unstaged && !f.conflict),
    };
  },

  primary() {
    const g = this.groups();
    return primaryAction({
      amend: this.amend, staged: g.staged.length, unstaged: g.unstaged.length, conflicts: g.conflicts.length,
      ahead: this.ahead, behind: this.behind, upstream: this.upstream, branch: this.branch, head: this.head,
      message: this.message.value(), busy: this.busy || !this.root,
    });
  },

  // then: null | "push" | "sync"; kind forces "commit" / "commitAll" from the ⌄ menu.
  commit(cx, then = null, kind = null) {
    const pa = this.primary();
    if (!kind && (pa.kind === "sync" || pa.kind === "publish")) return pa.enabled && this.askGit(pa.kind);
    const g = this.groups();
    const mode = this.amend ? "amend" : kind ?? (pa.kind === "commitAll" ? "commitAll" : "commit");
    const msg = this.message.value().trim();
    if (!this.root || this.busy || !msg || g.conflicts.length) return;
    if (mode === "commit" && !g.staged.length) return void (this.note = "Nothing staged. Use Commit All, or stage files first.");
    if (mode === "commitAll" && !g.staged.length && !g.unstaged.length) return;
    if (mode === "amend" && !this.head) return;
    const root = this.root;
    const expected = this.amendHead;
    this.busy = true;
    this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      let ok = false;
      try {
        if (mode === "amend") {
          const h = await git(["rev-parse", "--verify", "HEAD"], { cwd: root, on: this.on });
          if (h.stdout.trim() !== expected) throw new Error("the latest commit changed since you chose Amend; choose it again");
        }
        if (mode === "commitAll") await this.runIndex("stage", g.unstaged);
        const r = await git(["commit", ...(mode === "amend" ? ["--amend"] : []), "-m", msg], { cwd: root, on: this.on, timeout: 120000 });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        notify({ title: mode === "amend" ? "Amended" : "Committed", body: r.stdout.split("\n")[0], level: "success", timeout: 3000 });
        if (this.message.value().trim() === msg) this.message.set_value("");
        this.amend = false;
        this.amendLoaded = null;
        ok = true;
        bump(root);
      } catch (e) {
        this.note = `${mode === "amend" ? "Amend" : "Commit"} failed: ${e.message}`;
      } finally {
        this.busy = false;
        this.refresh(cx);
      }
      if (ok && then && this.root === root) this.askGit(then, { afterCommit: true });
    });
  },

  // ── opening things ─────────────────────────────────────────────────────────────────────
  toggleGroup(id, cx) {
    if (!this.closed.delete(id)) this.closed.add(id);
    localStorage.setItem("closed", JSON.stringify([...this.closed]));
    cx.notify();
  },

  openDiff(f, scope) {
    showInViewer(MOD, { root: this.root, on: this.on ?? null, path: f.path, scope, untracked: f.untracked }, baseName(f.path));
  },

  openFile(path) {
    showInViewer("vx-files", { root: this.root, on: this.on ?? null, rel: path }, baseName(path));
  },

  fileMenu(f, scope) {
    const deleted = scope === "staged" ? f.x === "D" : f.y === "D";
    openScmMenu(this.uid, [
      { id: "diff", icon: "split", label: "Open Changes", cmd: { cmd: "openDiff", path: f.path, scope } },
      { id: "file", icon: "file-code", label: "Open File", cmd: { cmd: "openFile", path: f.path }, disabled: deleted },
      { sep: true, id: "s1" },
      scope === "staged"
        ? { id: "unstage", icon: "minus", label: "Unstage Changes", cmd: { cmd: "unstage", path: f.path } }
        : { id: "stage", icon: "plus", label: "Stage Changes", cmd: { cmd: "stage", path: f.path }, disabled: f.conflict },
      { id: "discard", icon: "discard", label: "Discard Changes…", color: theme().ansi1, cmd: { cmd: "discard", path: f.path }, disabled: scope === "staged" || f.conflict },
      { sep: true, id: "s2" },
      { id: "reveal", icon: "folder", label: "Reveal in Finder", cmd: { cmd: "reveal", path: f.path }, disabled: deleted },
      { id: "copy", icon: "copy", label: "Copy Path", copy: `${this.root}/${f.path}` },
      { id: "copyrel", icon: "copy", label: "Copy Relative Path", copy: f.path },
    ]);
  },

  moreMenu() {
    const t = theme();
    const up = this.upstream;
    openScmMenu(this.uid, [
      { header: "Remote", id: "h1" },
      { id: "pull", icon: "arrow-down", color: t.ansi4, label: "Pull…", sub: this.behind ? `↓${this.behind}` : up ? "" : "no upstream", subColor: t.ansi4, cmd: { cmd: "pull" }, disabled: !up },
      { id: "push", icon: "arrow-up", color: t.ansi6, label: up ? "Push…" : "Publish Branch…", sub: this.ahead ? `↑${this.ahead}` : "", subColor: t.ansi6, cmd: { cmd: up ? "push" : "publish" }, disabled: !this.branch },
      { id: "sync", icon: "sync", color: t.accent, label: "Sync…", sub: "pull, then push", cmd: { cmd: "sync" }, disabled: !up },
      { id: "fetch", icon: "cloud", color: t.muted, label: "Fetch…", cmd: { cmd: "fetch" } },
      { header: "Stash", id: "h2" },
      { id: "stash", icon: "archive", color: t.ansi5, label: "Stash Changes…", cmd: { cmd: "stashAsk" }, disabled: !this.files.length },
      { id: "stash-staged", icon: "archive", color: t.ansi5, label: "Stash Staged…", cmd: { cmd: "stashAsk", staged: true }, disabled: !this.groups().staged.length },
      { header: "Branch", id: "h3" },
      { id: "branch", icon: "branch-plus", color: t.ansi2, label: "New Branch…", cmd: { cmd: "branchAsk" } },
      { id: "graph", icon: "pipeline", color: t.accent, label: "Open Commit Graph", cmd: { cmd: "graph" } },
      { sep: true, id: "s1" },
      { id: "flat", icon: "list", label: "View as List", checked: this.view === "flat", cmd: { cmd: "view", value: "flat" } },
      { id: "tree", icon: "list-tree", label: "View as Tree", checked: this.view === "tree", cmd: { cmd: "view", value: "tree" } },
    ]);
  },

  commitMenu() {
    const t = theme();
    const g = this.groups();
    const noMsg = !this.message.value().trim();
    const all = !g.staged.length;
    openScmMenu(this.uid, [
      { id: "c", icon: "commit-check", color: t.accent, label: all ? "Commit All" : "Commit", sub: all ? `${g.unstaged.length}` : `${g.staged.length} staged`, cmd: { cmd: "commit", kind: all ? "commitAll" : "commit" }, disabled: noMsg || this.amend },
      { id: "cp", icon: "arrow-up", color: t.ansi6, label: all ? "Commit All & Push" : "Commit & Push", cmd: { cmd: "commit", kind: all ? "commitAll" : "commit", then: "push" }, disabled: noMsg || this.amend || !this.branch },
      { id: "cs", icon: "sync", color: t.ansi4, label: all ? "Commit All & Sync" : "Commit & Sync", cmd: { cmd: "commit", kind: all ? "commitAll" : "commit", then: "sync" }, disabled: noMsg || this.amend || !this.upstream },
      { sep: true, id: "s1" },
      { id: "amend", icon: "pencil", color: t.ansi3, label: "Amend Last Commit", checked: this.amend, tip: "Rewrite the latest commit. Careful if it's already pushed.", cmd: { cmd: "amend" }, disabled: !this.head },
    ], 250);
  },

  // ── drawing ────────────────────────────────────────────────────────────────────────────
  hoverable(el, key) {
    return el.on_hover((on, cx) => {
      if (on) this.hot = key;
      else if (this.hot === key) this.hot = null;
      cx.notify();
    });
  },

  pill(text, color) {
    return div().flex_none().h(16).min_w(18).px(5).flex().items_center().justify_center().rounded(8)
      .bg(tint(color, "26")).text_size(TEXT.tiny).font_medium().text_color(color).child(String(text));
  },

  blocks(t, st) {
    return h_flex().flex_none().gap(1).children(statBlocks(st.add, st.del).map((b) =>
      div().size(6).rounded(1).bg(b === "+" ? t.ansi2 : b === "-" ? t.ansi1 : tint(t.dim, "40"))));
  },

  fileRow(t, f, scope, depth = 0) {
    const st = scope === "staged" ? this.stats[0][f.path] : this.stats[1][f.path];
    const letter = scope === "staged" ? (f.x === "A" ? "A" : f.x === "D" ? "D" : "M") : f.untracked ? "U" : f.conflict ? "!" : f.y === "D" ? "D" : "M";
    const color = f.conflict ? t.ansi1 : markColor(letter === "U" ? "A" : letter, t);
    const slash = f.path.lastIndexOf("/");
    const name = f.path.slice(slash + 1);
    const dir = this.view === "flat" && slash > 0 ? f.path.slice(0, slash) : "";
    const key = `${scope}:${f.path}`;
    const sel = this.selected === key;
    const hot = this.hot === key;
    const deleted = letter === "D";
    const btn = (id, icon, label, onClick) => IconButton({ id: `${id}-${key}`, icon, label, size: 20, disabled: this.busy, onClick });
    const row = h_flex().id(`c-${key}`).h(ROW).flex_none().mx(4).pl(6 + depth * 12).pr(4).gap(6).items_center().rounded(5)
      .bg(sel ? t.selected : hot ? t.hover : "#00000000").cursor_pointer().text_size(TEXT.body)
      .tooltip(`${f.path}${f.conflict ? ` · ${f.conflictKind}` : ""}${st && !st.binary ? ` · +${st.add} −${st.del}` : ""}\nClick: changes · double-click: file · right-click: more`)
      .on_click((e, cx) => {
        this.selected = key;
        if (e.click_count >= 2 && !deleted) this.openFile(f.path);
        else this.openDiff(f, scope);
        cx.notify();
      })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.selected = key; this.fileMenu(f, scope); cx.notify(); })
      .child(div().w(2).h(14).flex_none().rounded(1).bg(sel ? t.accent : "#00000000"))
      .child(FileIcon(this.icons, f.path, { size: 15 }))
      .child(div().flex_shrink(1).min_w(40).max_w(200).truncate().text_color(color).when(deleted, (el) => el.line_through()).child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(TEXT.caption).text_color(t.dim).child(f.conflict ? f.conflictKind : dir));
    if (hot) {
      if (!deleted) row.child(btn("of", "file-code", "Open File", () => this.openFile(f.path)));
      if (scope !== "staged" && !f.conflict) row.child(btn("dc", "discard", "Discard Changes…", () => this.askDiscard([f])));
      if (!f.conflict) row.child(btn("st", scope === "staged" ? "minus" : "plus", scope === "staged" ? "Unstage" : "Stage", (cx) => this.index(scope === "staged" ? "unstage" : "stage", [f], cx)));
    } else if (st && !st.binary && !f.conflict && (st.add || st.del)) row.child(this.blocks(t, st));
    row.child(div().w(16).h(16).flex_none().flex().items_center().justify_center().rounded(4).bg(tint(color, "22"))
      .text_size(TEXT.tiny).font_semibold().text_color(color).child(letter));
    return this.hoverable(row, key);
  },

  // Tree view: folders as headings with their files under them, single-child folders folded.
  treeRows(t, files, scope) {
    const root = { dirs: new Map(), files: [] };
    for (const f of files) {
      const parts = f.path.split("/");
      parts.pop();
      let node = root;
      for (const p of parts) {
        if (!node.dirs.has(p)) node.dirs.set(p, { dirs: new Map(), files: [] });
        node = node.dirs.get(p);
      }
      node.files.push(f);
    }
    const out = [];
    const walk = (node, depth, prefix) => {
      for (const [name, child] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
        let label = name;
        let n = child;
        while (n.files.length === 0 && n.dirs.size === 1) {
          const [[k, v]] = [...n.dirs];
          label += `/${k}`;
          n = v;
        }
        const id = `${scope}:${prefix}${label}`;
        const open = !this.closed.has(id);
        out.push(h_flex().id(`d-${id}`).h(ROW).flex_none().mx(4).pl(12 + depth * 12).gap(5).items_center().rounded(5).cursor_pointer().hover((s) => s.bg(t.hover))
          .text_size(TEXT.small).text_color(t.muted).on_click((_e, cx) => this.toggleGroup(id, cx))
          .child(Icon(open ? "chevron-down" : "chevron-right", 11).text_color(t.dim))
          .child(FileIcon(this.icons, label.split("/").pop(), { dir: true, open, size: 15 }))
          .child(div().truncate().child(label)));
        if (open) walk(n, depth + 1, `${prefix}${label}/`);
      }
      for (const f of node.files.sort((a, b) => a.path.localeCompare(b.path))) out.push(this.fileRow(t, f, scope, depth));
    };
    walk(root, 0, "");
    return out;
  },

  groupHead(t, id, label, count, color, icon, actions = []) {
    const open = !this.closed.has(id);
    return h_flex().id(`g-${id}`).h(26).flex_none().mx(4).pl(6).pr(4).gap(6).items_center().rounded(5).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.toggleGroup(id, cx))
      .child(Icon(open ? "chevron-down" : "chevron-right", 11).text_color(t.dim))
      .child(Icon(icon, 13).text_color(color))
      .child(div().text_size(TEXT.caption).font_semibold().text_color(t.foreground).child(label))
      .child(this.pill(count, color))
      .child(div().flex_1())
      .children(actions);
  },

  group(t, id, label, files, scope, color, icon, actions) {
    if (!files.length) return [];
    const open = !this.closed.has(id);
    const shown = files.slice(0, LIMIT);
    const out = [this.groupHead(t, id, label, files.length, color, icon, actions)];
    if (!open) return out;
    out.push(...(this.view === "tree" ? this.treeRows(t, shown, scope) : shown.map((f) => this.fileRow(t, f, scope))));
    if (files.length > LIMIT) out.push(Message(`Showing ${LIMIT} of ${files.length}.`));
    return out;
  },

  // The branch strip, the message card and the Commit button.
  commitBox(t) {
    const pa = this.primary();
    const g = this.groups();
    const info = subjectInfo(this.message.value());
    const infoColor = info.level === "over" ? t.ansi1 : info.level === "long" ? t.ansi3 : t.dim;
    const bColor = this.detached ? t.ansi3 : t.ansi2;
    const branchChip = h_flex().id("c-branch").h(22).min_w(0).px(8).gap(5).items_center().rounded(11).cursor_pointer()
      .bg(tint(bColor, "1f")).text_size(TEXT.caption).text_color(bColor).hover((s) => s.bg(tint(bColor, "33")))
      .tooltip(`${this.branch ?? "detached HEAD"}${this.upstream ? ` → ${this.upstream}` : ""}\nClick: switch or create a branch`)
      .on_click(() => this.branchMenu())
      .child(Icon("branch", 11)).child(div().min_w(0).truncate().font_medium().child(this.branch ?? `detached ${this.head?.slice(0, 7) ?? ""}`))
      .child(Icon("chevron-down", 10));
    const syncChip = this.upstream
      ? h_flex().id("c-sync").h(22).flex_none().px(8).gap(6).items_center().rounded(11).cursor_pointer().bg(t.raised).text_size(TEXT.caption)
        .hover((s) => s.bg(t.hover)).tooltip(`↓${this.behind} to pull · ↑${this.ahead} to push with ${this.upstream}\nClick: sync…`)
        .on_click(() => this.askGit("sync"))
        .child(div().text_color(this.behind ? t.ansi4 : t.dim).child(`↓${this.behind}`))
        .child(div().text_color(this.ahead ? t.ansi6 : t.dim).child(`↑${this.ahead}`))
      : this.branch && this.head
        ? h_flex().id("c-publish").h(22).flex_none().px(8).gap(5).items_center().rounded(11).cursor_pointer().bg(t.raised).text_size(TEXT.caption).text_color(t.ansi6)
          .hover((s) => s.bg(t.hover)).tooltip("Not on the remote yet · click to publish…").on_click(() => this.askGit("publish"))
          .child(Icon("cloud-upload", 12)).child("Publish")
        : null;
    const card = v_flex().id("c-card").flex_none().rounded(8).border_1().border_color(this.amend ? t.ansi3 : t.border).bg(t.input ?? t.background)
      .on_key_down((e, cx) => {
        if (e.key === "enter" && e.modifiers?.platform) {
          cx.stop_propagation();
          this.commit(cx);
        }
      })
      .child(Textarea.new(this.message).id("c-msg").w_full().min_h(52).px(8).pt(6).text_size(TEXT.small))
      .child(h_flex().h(24).flex_none().px(6).gap(6).items_center()
        .when(this.amend, (el) => el.child(h_flex().h(16).px(6).gap(4).items_center().rounded(8).bg(tint(t.ansi3, "26")).text_size(TEXT.tiny).text_color(t.ansi3)
          .child(Icon("pencil", 9)).child("AMEND")))
        .child(div().flex_1())
        .when(info.len > 0, (el) => el.child(div().id("c-len").text_size(TEXT.tiny).text_color(infoColor).tooltip("Subject line length: 50 is tidy, 72 is the limit").child(`${info.len}`))));
    const solid = pa.enabled;
    const accent = pa.kind === "amend" ? t.ansi3 : t.accent;
    const fg = solid ? t.accent_foreground ?? t.background : t.dim;
    const icon = pa.kind === "sync" ? "sync" : pa.kind === "publish" ? "cloud-upload" : pa.kind === "amend" ? "pencil" : "commit-check";
    const count = pa.kind === "commit" && g.staged.length ? ` (${g.staged.length})` : pa.kind === "commitAll" ? ` (${g.unstaged.length})` : "";
    const button = h_flex().id("c-commit-row").h(30).flex_none().rounded(6).overflow_hidden()
      .bg(solid ? accent : t.raised).border_1().border_color(solid ? accent : t.border)
      .child(h_flex().id("c-commit").flex_1().h_full().gap(6).items_center().justify_center().text_size(TEXT.small).font_medium().text_color(fg)
        .tooltip(pa.tip)
        .when(solid, (el) => el.cursor_pointer().hover((s) => s.bg(tint("#ffffff", "14"))).on_click((_e, cx) => this.commit(cx)))
        .child(this.busy ? Icon("spinner", 13).spin(SPIN_MS) : Icon(icon, 13))
        .child(`${pa.label}${count}`)
        .when(pa.kind === "sync", (el) => el.child(div().text_size(TEXT.caption).child(`${pa.behind}↓ ${pa.ahead}↑`))))
      .child(div().w(1).h(18).flex_none().bg(solid ? tint(fg, "55") : t.border))
      .child(div().id("c-commit-more").w(28).h_full().flex_none().flex().items_center().justify_center().cursor_pointer().text_color(fg)
        .hover((s) => s.bg(tint("#ffffff", "14"))).tooltip("More commit actions")
        .on_click(() => this.commitMenu())
        .child(Icon("chevron-down", 12)));
    return v_flex().flex_none().px(10).pt(4).pb(10).gap(8)
      .child(h_flex().gap(6).items_center().child(branchChip).when(Boolean(syncChip), (el) => el.child(syncChip)))
      .child(card)
      .child(button)
      .when(Boolean(this.note), (el) => el.child(h_flex().gap(6).items_start().px(8).py(6).rounded(6).bg(tint(t.ansi1, "1a"))
        .child(Icon("alert", 12).text_color(t.ansi1))
        .child(div().flex_1().min_w(0).text_size(TEXT.small).text_color(t.ansi1).whitespace_normal().child(this.note))
        .child(IconButton({ id: "c-note-x", icon: "x", label: "Dismiss", size: 18, onClick: (cx) => { this.note = null; cx.notify(); } }))));
  },

  renderPanel() {
    const t = theme();
    const g = this.groups();
    const head = h_flex().h(34).flex_none().pl(6).pr(6).gap(2).items_center()
      .child(RepoButton(this, MOD, this.root))
      .child(div().flex_1())
      .child(IconButton({ id: "c-view", icon: this.view === "tree" ? "list" : "list-tree", label: this.view === "tree" ? "View as List" : "View as Tree", size: 22, onClick: (cx) => { this.view = this.view === "tree" ? "flat" : "tree"; localStorage.setItem("view", this.view); cx.notify(); } }))
      .child(IconButton({ id: "c-refresh", icon: "refresh", label: "Refresh", spinning: Boolean(this.loading || this.busy), size: 22, onClick: (cx) => this.refresh(cx) }))
      .child(IconButton({ id: "c-more", icon: "more", label: "More actions…", size: 22, onClick: () => this.moreMenu() }));
    const panel = v_flex().id(MOD).size_full().min_w(0).min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).child(head);
    if (!this.root) return panel.child(Message(this.error ?? "Pick a repo in Workspace, or focus a terminal inside one."));
    const body = v_flex().id("c-body").flex_1().min_h(0).overflow_y_scrollbar().pb(8).gap(1);
    body.child(this.commitBox(t));
    body.children(this.group(t, "conflicts", "Merge Changes", g.conflicts, "conflict", t.ansi1, "merge"));
    body.children(this.group(t, "staged", "Staged Changes", g.staged, "staged", t.ansi2, "check", [
      IconButton({ id: "ga-unstage", icon: "minus", label: "Unstage All", size: 20, disabled: this.busy, onClick: (cx) => this.index("unstage", g.staged, cx) }),
    ]));
    body.children(this.group(t, "unstaged", "Changes", g.unstaged, "unstaged", t.ansi3, "pencil", [
      IconButton({ id: "ga-discard", icon: "discard", label: "Discard All Changes…", size: 20, disabled: this.busy, onClick: () => this.askDiscard(g.unstaged) }),
      IconButton({ id: "ga-stage", icon: "plus", label: "Stage All Changes", size: 20, disabled: this.busy, onClick: (cx) => this.index("stage", g.unstaged, cx) }),
    ]));
    if (!this.files.length && !this.loading) body.child(h_flex().mx(10).my(4).px(10).py(8).gap(8).items_center().rounded(6).bg(tint(t.ansi2, "14"))
      .child(Icon("check", 13).text_color(t.ansi2)).child(div().text_size(TEXT.small).text_color(t.muted).child("Working tree clean")));
    body.children(this.renderSections(t));
    return panel.child(body);
  },
};
