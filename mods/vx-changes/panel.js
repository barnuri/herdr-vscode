// The Changes panel: conflicts, staged and unstaged files of the context repo, stage / unstage,
// and a commit box with Amend. Stage and unstage touch only the index (`add`, `reset -q HEAD`,
// `rm --cached` before the first commit). Working files are never changed: no discard here.
import { div } from "gpui-kit";
import { v_flex, h_flex, Textarea } from "gpui-base";
import { theme, notify } from "herdr";
import { ctx, contextKey, git, repoTop, changedAt, bump, baseName } from "./ws.js";
import { parseStatus, parseNumstat, parseLog, LOG_FORMAT, timeAgo } from "./git-core.js";
import { TEXT, Icon, IconButton, Badge, Button, FileIcon, Message, SectionHead, markColor } from "./ui.js";
import { showInViewer } from "./tabs.js";
import { RepoButton } from "./repo-picker.js";

const MOD = "vx-changes";
const LIMIT = 1000;

export const panelMethods = {
  initPanel(cx) {
    this.tops = new Map();
    this.files = [];
    this.stats = [{}, {}];
    this.closed = new Set(JSON.parse(localStorage.getItem("closed") ?? "[]"));
    this.view = localStorage.getItem("view") === "tree" ? "tree" : "flat";
    this.amend = false;
    this.commits = [];
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
      this.refresh(cx);
    } else if (changedAt() !== this.seenChange) {
      this.seenChange = changedAt();
      this.refresh(cx);
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
        const [st, staged, unstaged, head, log] = await Promise.all([
          g(["status", "--porcelain=v1", "-z", "-b", "--no-renames", "--untracked-files=all"]),
          g(["diff", "--cached", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv"]),
          g(["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv"]),
          g(["rev-parse", "--verify", "-q", "HEAD"]),
          g(["log", "-n", "8", LOG_FORMAT]),
        ]);
        if (contextKey(ctx()) !== key) return;
        if (st.code !== 0) throw new Error(st.stderr.trim() || "git status failed");
        const s = parseStatus(st.stdout);
        this.root = top;
        this.on = c.on;
        this.source = c.source;
        this.branch = s.detached ? "detached" : s.branch;
        this.upstream = s.upstream;
        this.ahead = s.ahead;
        this.files = s.files;
        this.stats = [parseNumstat(staged.stdout), parseNumstat(unstaged.stdout)];
        this.head = head.code === 0 ? head.stdout.trim() : null;
        this.commits = log.code === 0 ? parseLog(log.stdout) : [];
        this.error = null;
        // Sections (history, branches...) reload only when HEAD or the tree moved.
        const sig = `${top}|${this.head}|${st.stdout}`;
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

  // ── index ──────────────────────────────────────────────────────────────────────────────
  indexArgs(action, paths) {
    if (action === "stage") return ["--literal-pathspecs", "add", "--", ...paths];
    if (this.head) return ["--literal-pathspecs", "reset", "-q", "HEAD", "--", ...paths];
    return ["--literal-pathspecs", "rm", "--cached", "-r", "-q", "--", ...paths];
  },

  // Stage all leaves conflicts alone: staging one marks it resolved with its markers still in.
  index(action, files, cx) {
    if (!this.root || this.busy || !files.length) return;
    const paths = files.filter((f) => !f.conflict).map((f) => f.path);
    if (!paths.length) return;
    this.busy = true;
    this.note = null;
    cx.notify();
    const root = this.root;
    cx.spawn(async (cx) => {
      try {
        for (let i = 0; i < paths.length; i += 200) {
          const r = await git(this.indexArgs(action, paths.slice(i, i + 200)), { cwd: root, on: this.on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        bump(root);
      } catch (e) {
        this.note = `${action === "stage" ? "Stage" : "Unstage"} failed: ${e.message}`;
      } finally {
        this.busy = false;
        this.refresh(cx);
      }
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
        this.amendHead = this.head;
        cx.notify();
      });
    } else if (!on && this.amendLoaded && this.message.value() === this.amendLoaded) {
      this.message.set_value("");
      this.amendLoaded = null;
    }
    if (on) this.amendHead = this.head;
    cx.notify();
  },

  canCommit() {
    const staged = this.files.filter((f) => f.staged).length;
    const conflicts = this.files.some((f) => f.conflict);
    return Boolean(this.root && !this.busy && !conflicts && this.message.value().trim() && (this.amend ? this.head : staged));
  },

  commit(cx) {
    if (!this.canCommit()) return;
    const root = this.root;
    const msg = this.message.value().trim();
    const amend = this.amend;
    const expected = this.amendHead;
    this.busy = true;
    this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (amend) {
          const h = await git(["rev-parse", "--verify", "HEAD"], { cwd: root, on: this.on });
          if (h.stdout.trim() !== expected) throw new Error("the latest commit changed since you chose Amend; choose it again");
        }
        const r = await git(["commit", ...(amend ? ["--amend"] : []), "-m", msg], { cwd: root, on: this.on, timeout: 120000 });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        notify({ title: amend ? "Amended" : "Committed", body: r.stdout.split("\n")[0], level: "success", timeout: 3000 });
        if (this.message.value().trim() === msg) this.message.set_value("");
        this.amend = false;
        this.amendLoaded = null;
        bump(root);
      } catch (e) {
        this.note = `${amend ? "Amend" : "Commit"} failed: ${e.message}`;
      } finally {
        this.busy = false;
        this.refresh(cx);
      }
    });
  },

  // ── drawing ────────────────────────────────────────────────────────────────────────────
  toggleGroup(id, cx) {
    if (!this.closed.delete(id)) this.closed.add(id);
    localStorage.setItem("closed", JSON.stringify([...this.closed]));
    cx.notify();
  },

  openDiff(f, scope) {
    showInViewer(MOD, { root: this.root, on: this.on ?? null, path: f.path, scope, untracked: f.untracked }, baseName(f.path));
  },

  fileRow(t, f, scope, depth = 0) {
    const st = scope === "staged" ? this.stats[0][f.path] : this.stats[1][f.path];
    const letter = scope === "staged" ? (f.x === "A" ? "A" : f.x === "D" ? "D" : "M") : f.untracked ? "A" : f.conflict ? "U" : f.y === "D" ? "D" : "M";
    const color = markColor(letter, t);
    const slash = f.path.lastIndexOf("/");
    const name = f.path.slice(slash + 1);
    const dir = this.view === "flat" && slash > 0 ? f.path.slice(0, slash) : "";
    const sel = this.selected === `${scope}:${f.path}`;
    return h_flex().id(`c-${scope}-${f.path}`).h(26).flex_none().mx(4).pl(8 + depth * 12).pr(6).gap(6).items_center().rounded(5)
      .bg(sel ? t.selected : "#00000000").when(!sel, (el) => el.hover((s) => s.bg(t.hover))).cursor_pointer().text_size(TEXT.body)
      .on_click((_e, cx) => { this.selected = `${scope}:${f.path}`; this.openDiff(f, scope); cx.notify(); })
      .child(FileIcon(this.icons, f.path, { size: 14 }))
      .child(div().flex_none().max_w(220).truncate().text_color(color).child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(TEXT.caption).text_color(t.dim).child(f.conflict ? f.conflictKind : dir))
      .when(Boolean(st) && !st.binary && !f.conflict, (el) => el
        .when(st.add > 0, (e2) => e2.child(div().text_size(TEXT.caption).text_color(t.ansi2).child(`+${st.add}`)))
        .when(st.del > 0, (e2) => e2.child(div().text_size(TEXT.caption).text_color(t.ansi1).child(`−${st.del}`))))
      .child(div().w(12).flex_none().text_size(TEXT.caption).text_color(color).child(letter))
      .when(!f.conflict, (el) => el.child(IconButton({
        id: `c-${scope}-btn-${f.path}`, icon: scope === "staged" ? "minus" : "plus", size: 20,
        label: scope === "staged" ? "Unstage" : "Stage", disabled: this.busy,
        onClick: (cx) => this.index(scope === "staged" ? "unstage" : "stage", [f], cx),
      })));
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
        out.push(h_flex().id(`d-${id}`).h(24).flex_none().mx(4).pl(8 + depth * 12).gap(5).items_center().rounded(5).cursor_pointer().hover((s) => s.bg(t.hover))
          .text_size(TEXT.small).text_color(t.muted).on_click((_e, cx) => this.toggleGroup(id, cx))
          .child(Icon(open ? "chevron-down" : "chevron-right", 11).text_color(t.dim))
          .child(FileIcon(this.icons, label.split("/").pop(), { dir: true, open, size: 14 }))
          .child(div().truncate().child(label)));
        if (open) walk(n, depth + 1, `${prefix}${label}/`);
      }
      for (const f of node.files.sort((a, b) => a.path.localeCompare(b.path))) out.push(this.fileRow(t, f, scope, depth));
    };
    walk(root, 0, "");
    return out;
  },

  group(t, id, label, files, scope, action) {
    if (!files.length) return null;
    const open = !this.closed.has(id);
    const shown = files.slice(0, LIMIT);
    return v_flex().flex_none()
      .child(h_flex().id(`g-${id}`).h(28).flex_none().px(10).gap(6).items_center().cursor_pointer().on_click((_e, cx) => this.toggleGroup(id, cx))
        .child(Icon(open ? "chevron-down" : "chevron-right", 11).text_color(t.dim))
        .child(div().text_size(TEXT.caption).font_medium().text_color(scope === "conflict" ? t.ansi1 : t.muted).child(label.toUpperCase()))
        .child(Badge(files.length))
        .child(div().flex_1())
        .when(Boolean(action), (el) => el.child(h_flex().id(`ga-${id}`).px(6).h(20).gap(4).items_center().rounded(4).text_size(TEXT.caption).text_color(t.dim)
          .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); action.run(cx); })
          .child(Icon(action.icon, 11)).child(action.label))))
      .when(open, (el) => el.children(this.view === "tree" ? this.treeRows(t, shown, scope) : shown.map((f) => this.fileRow(t, f, scope))))
      .when(open && files.length > LIMIT, (el) => el.child(Message(`Showing ${LIMIT} of ${files.length}.`)));
  },

  renderPanel() {
    const t = theme();
    const conflicts = this.files.filter((f) => f.conflict);
    const staged = this.files.filter((f) => f.staged);
    const unstaged = this.files.filter((f) => f.unstaged && !f.conflict);
    const head = h_flex().h(36).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border)
      .child(RepoButton(this, MOD, this.root))
      .child(h_flex().flex_1().min_w(0).gap(4).items_center().text_size(TEXT.caption).text_color(t.dim)
        .when(Boolean(this.branch), (el) => el.child(Icon("branch", 11)).child(div().truncate().child(this.branch))))
      .child(IconButton({ id: "c-view", icon: this.view === "tree" ? "layers" : "file", label: this.view === "tree" ? "Flat list" : "Tree", size: 22, onClick: (cx) => { this.view = this.view === "tree" ? "flat" : "tree"; localStorage.setItem("view", this.view); cx.notify(); } }))
      .child(IconButton({ id: "c-refresh", icon: "refresh", label: "Refresh", spinning: Boolean(this.loading || this.busy), size: 22, onClick: (cx) => this.refresh(cx) }));
    const body = v_flex().id("c-body").flex_1().min_h(0).overflow_y_scrollbar().py(4);
    if (this.error && !this.root) body.child(Message(this.error));
    else if (this.root) {
      if (!this.files.length) body.child(Message(this.loading ? "Loading…" : "Nothing to commit. Working tree clean."));
      body.children([
        this.group(t, "conflicts", "Conflicts", conflicts, "conflict", null),
        this.group(t, "staged", "Staged", staged, "staged", { icon: "minus", label: "Unstage all", run: (cx) => this.index("unstage", staged, cx) }),
        this.group(t, "unstaged", "Changes", unstaged, "unstaged", { icon: "plus", label: "Stage all", run: (cx) => this.index("stage", unstaged, cx) }),
      ].filter(Boolean));
      body.children(this.renderSections(t));
    } else body.child(Message("Pick a repo in Workspace, or focus a terminal inside one."));
    const box = v_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
      .when(Boolean(this.note), (el) => el.child(div().text_size(TEXT.small).text_color(t.ansi1).whitespace_normal().child(this.note)))
      .child(Textarea.new(this.message).id("c-msg").w_full().h(68).px(8).py(6).rounded(7).border_1().border_color(t.border).bg(t.input ?? t.background).text_size(TEXT.small))
      .when(this.amend, (el) => el.child(div().text_size(TEXT.caption).text_color(t.working ?? t.ansi3).child("Amend rewrites the latest commit. Careful if it's already pushed.")))
      .child(h_flex().gap(8).items_center()
        .child(h_flex().id("c-amend").gap(5).items_center().cursor_pointer().text_size(TEXT.small).text_color(this.amend ? t.foreground : t.dim)
          .on_click((_e, cx) => this.setAmend(!this.amend, cx))
          .child(div().size(13).rounded(3).border_1().border_color(this.amend ? t.accent : t.border).bg(this.amend ? t.accent : "#00000000")
            .when(this.amend, (e2) => e2.child(Icon("check", 11).text_color(t.accent_foreground ?? t.background))))
          .child("Amend"))
        .child(div().flex_1())
        .child(Button({ id: "c-commit", label: this.amend ? "Amend commit" : `Commit${staged.length ? ` ${staged.length}` : ""}`, primary: true, disabled: !this.canCommit(), onClick: (cx) => this.commit(cx) })));
    return v_flex().id(MOD).size_full().min_w(0).min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground)
      .child(head).child(body).when(Boolean(this.root), (el) => el.child(box));
  },
};
