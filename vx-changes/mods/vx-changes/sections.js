// GitLens-style sections under the working changes: Commits (graph lanes, authors, branch and
// tag labels, incoming / outgoing; expand one for its files), Branches, Remotes, Stashes, Tags,
// and Search & Compare. Each section loads when opened and reloads when the repo changes.
// Clicking a file opens its diff in the diff tab. What changes something asks first (switch,
// delete branch, apply / pop / drop stash); new branch and stash are dialogs (scm-popups.js).
import { div } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { theme, exec } from "herdr";
import { git, baseName } from "./ws.js";
import { parseLog, LOG_FORMAT, timeAgo, parseRemote, providerOf } from "./git-core.js";
import { GRAPH_FORMAT, parseGraphLog, refLabels, layoutGraph } from "./graph-core.js";
import { initials, commitUrl } from "./scm-core.js";
import { colorSlot } from "./colors-core.js";
import { TEXT, Icon, IconButton, FileIcon, Message, markColor, tint } from "./ui.js";
import { showInViewer } from "./tabs.js";
import { askConfirm } from "./actions.js";
import { openScmMenu } from "./scm-popups.js";

const MOD = "vx-changes";
const PAGE = 50;
const ROW = 24;
const LANE = 10;
const MAX_LANES = 4;
const SECTIONS = [
  ["commits", "Commits", "git-commit", "ansi4"], ["branches", "Branches", "branch", "ansi2"], ["remotes", "Remotes", "cloud", "ansi6"],
  ["stashes", "Stashes", "archive", "ansi5"], ["tags", "Tags", "tag", "ansi3"], ["compare", "Search & Compare", "compare", "accent"],
];
const MODES = [["message", "Message"], ["author", "Author"], ["file", "File"], ["sha", "Commit"]];

// `git show --name-status` / `git diff --name-status` lines -> [{ status, path }].
const nameStatus = (out) => String(out ?? "").split("\n").filter(Boolean)
  .map((l) => l.split("\t")).filter((p) => p.length >= 2).map(([s, ...rest]) => ({ status: s[0], path: rest.at(-1) }));

// Labels for one commit, the useful first: HEAD's branch, local branches, tags, remotes. A remote
// branch with the same name as a local one at the same commit folds into it (marked `synced`).
function tidyRefs(labels) {
  const locals = new Set(labels.filter((r) => r.kind === "head" || r.kind === "branch").map((r) => r.name));
  const out = [];
  for (const r of labels) {
    if (r.name === "HEAD") continue;
    if (r.kind === "remote" && locals.has(r.name.slice(r.name.indexOf("/") + 1))) {
      const local = out.find((x) => x.name === r.name.slice(r.name.indexOf("/") + 1));
      if (local) local.synced = true;
      else labels.find((x) => x.name === r.name.slice(r.name.indexOf("/") + 1)).synced = true;
      continue;
    }
    out.push(r);
  }
  const rank = { head: 0, branch: 1, tag: 2, remote: 3 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind]);
}

// An SSH alias (Host work-github in ~/.ssh/config) to the host it really connects to.
async function realHost(alias) {
  const r = await exec("ssh", ["-G", alias]).catch(() => null);
  return /^hostname\s+(\S+)/m.exec(r?.stdout ?? "")?.[1] ?? null;
}

export const sectionMethods = {
  initSections() {
    try {
      this.open = new Set(JSON.parse(localStorage.getItem("sections") ?? '["commits"]'));
    } catch {
      this.open = new Set(["commits"]);
    }
    this.data = {};
    this.expanded = new Map(); // "kind:id" -> files, while open
    this.commitCount = PAGE;
    this.searchMode = "message";
    this.search.on("change", (_e, cx) => cx.notify());
    this.search.on("submit", (_e, cx) => this.runSearch(cx));
  },

  // Called after the working changes refresh: reload every open section (Branches always, for
  // the branch switcher).
  refreshSections(cx) {
    if (!this.root) return;
    if (this.remoteFor !== this.root) this.loadRemote(cx);
    for (const id of new Set([...this.open, "branches"])) this.loadSection(id, cx);
  },

  // origin as { host, path } with SSH aliases resolved, for "Open on GitHub / GitLab".
  loadRemote(cx) {
    const root = this.root;
    this.remoteFor = root;
    this.remote = null;
    cx.spawn(async () => {
      const r = await git(["remote", "get-url", "origin"], { cwd: root, on: this.on }).catch(() => null);
      const remote = r?.code === 0 ? parseRemote(r.stdout.trim()) : null;
      if (remote && !providerOf(remote.host) && !this.on) remote.host = (await realHost(remote.host)) ?? remote.host;
      if (this.root === root) this.remote = remote;
    });
  },

  toggleSection(id, cx) {
    if (!this.open.delete(id)) {
      this.open.add(id);
      this.loadSection(id, cx);
    }
    localStorage.setItem("sections", JSON.stringify([...this.open]));
    cx.notify();
  },

  loadSection(id, cx) {
    const root = this.root;
    const on = this.on;
    if (!root) return;
    const g = (args) => git(args, { cwd: root, on });
    cx.spawn(async (cx) => {
      let value = null;
      try {
        if (id === "commits") {
          const up = this.upstream;
          const [r, out, inc] = await Promise.all([
            g(["log", "-n", String(this.commitCount), GRAPH_FORMAT]),
            up ? g(["rev-list", "@{upstream}..HEAD"]) : null,
            up && this.behind ? g(["log", "-n", "50", GRAPH_FORMAT, "HEAD..@{upstream}"]) : null,
          ]);
          const commits = r.code === 0 ? parseGraphLog(r.stdout) : [];
          const graph = layoutGraph(commits);
          value = {
            commits, rows: graph.rows, width: Math.max(1, Math.min(MAX_LANES, graph.width)),
            outgoing: new Set(out?.code === 0 ? out.stdout.split("\n").filter(Boolean) : []),
            incoming: inc?.code === 0 ? parseGraphLog(inc.stdout) : [],
            more: commits.length >= this.commitCount,
          };
        } else if (id === "branches") {
          const r = await g(["for-each-ref", "refs/heads", "--sort=-committerdate", "--format=%(refname:short)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:unix)%00%(HEAD)%00%(subject)"]);
          value = r.stdout.split("\n").filter(Boolean).map((l) => {
            const [name, upstream, track, at, head, subject] = l.split("\0");
            return {
              name, upstream, at: Number(at), current: head === "*", subject, gone: track === "gone",
              ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0), behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
            };
          });
        } else if (id === "remotes") {
          const r = await g(["for-each-ref", "refs/remotes", "--sort=-committerdate", "--format=%(refname:short)%00%(committerdate:unix)%00%(subject)"]);
          value = r.stdout.split("\n").filter(Boolean).map((l) => {
            const [name, at, subject] = l.split("\0");
            return { name, at: Number(at), subject };
          }).filter((b) => !b.name.endsWith("/HEAD") && b.name.includes("/"));
        } else if (id === "stashes") {
          const r = await g(["stash", "list", "--format=%gd%x00%s%x00%ct"]);
          value = r.stdout.split("\n").filter(Boolean).map((l) => {
            const [ref, subject, at] = l.split("\0");
            return { ref, subject, at: Number(at) };
          });
        } else if (id === "tags") {
          const r = await g(["for-each-ref", "refs/tags", "--sort=-creatordate", "--count=60", "--format=%(refname:short)%00%(creatordate:unix)%00%(subject)"]);
          value = r.stdout.split("\n").filter(Boolean).map((l) => {
            const [name, at, subject] = l.split("\0");
            return { name, at: Number(at), subject };
          });
        } else if (id === "compare") {
          value = await this.loadCompare(g);
        }
      } catch (e) {
        value = { error: String(e?.message ?? e) };
      }
      if (this.root !== root) return;
      this.data[id] = value;
      cx.notify();
    });
  },

  // The branch this one came from: its upstream's remote default branch (origin/HEAD), else
  // origin/staging or origin/main. When on that branch itself, compare with its upstream.
  async loadCompare(g) {
    let base = this.compareBase;
    if (!base) {
      const head = await g(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
      base = head.code === 0 ? head.stdout.trim() : null;
      for (const b of ["origin/staging", "origin/main", "origin/master"]) {
        if (base) break;
        if ((await g(["rev-parse", "--verify", "-q", b])).code === 0) base = b;
      }
      if (base && base.replace(/^origin\//, "") === this.branch && this.upstream) base = this.upstream;
    }
    if (!base) return { error: "No base branch to compare with (no origin/HEAD)." };
    const [log, files] = await Promise.all([
      g(["log", "-n", "200", LOG_FORMAT, `${base}..HEAD`]),
      g(["diff", "--name-status", "--no-renames", `${base}...HEAD`]),
    ]);
    const behind = await g(["rev-list", "--count", `HEAD..${base}`]);
    return {
      base,
      commits: log.code === 0 ? parseLog(log.stdout) : [],
      files: files.code === 0 ? nameStatus(files.stdout) : [],
      behind: Number(behind.stdout.trim()) || 0,
      error: log.code !== 0 ? log.stderr.trim() : null,
    };
  },

  setCompareBase(base, cx) {
    this.compareBase = base;
    this.open.add("compare");
    localStorage.setItem("sections", JSON.stringify([...this.open]));
    this.loadSection("compare", cx);
  },

  runSearch(cx) {
    const q = this.search.value().trim();
    if (!q || !this.root) return;
    const args = { message: ["--grep", q, "-i"], author: ["--author", q, "-i"], file: ["--", `:(glob,icase)**/*${q}*`], sha: [q, "-n", "1"] }[this.searchMode];
    const root = this.root;
    this.searching = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await git(["log", "-n", "100", "--all", LOG_FORMAT, ...args], { cwd: root, on: this.on }).catch(() => null);
      this.searching = false;
      if (this.root !== root) return;
      this.results = { q, mode: this.searchMode, commits: r?.code === 0 ? parseLog(r.stdout) : [], error: r?.code === 0 ? null : (r?.stderr ?? "").trim() };
      cx.notify();
    });
  },

  // A commit's (or stash's) changed files, loaded when expanded.
  toggleExpand(kind, id, cx) {
    const key = `${kind}:${id}`;
    if (this.expanded.has(key)) {
      this.expanded.delete(key);
      return cx.notify();
    }
    this.expanded.set(key, null);
    cx.notify();
    const root = this.root;
    cx.spawn(async (cx) => {
      const args = kind === "stash" ? ["stash", "show", "--name-status", "--no-renames", id] : ["show", "--format=", "--name-status", "--no-renames", "-m", "--first-parent", id];
      const r = await git(args, { cwd: root, on: this.on }).catch(() => null);
      if (this.root !== root || !this.expanded.has(key)) return;
      this.expanded.set(key, r?.code === 0 ? nameStatus(r.stdout) : []);
      cx.notify();
    });
  },

  // ── actions (they ask first) ───────────────────────────────────────────────────────────
  confirmGit(spec, args) {
    askConfirm(MOD, { ...spec, action: { cmd: "git", args, cwd: this.root, on: this.on ?? null, doing: spec.doing, done: spec.done, root: this.root } });
  },

  switchBranch(name) {
    this.confirmGit({ title: `Switch to ${name}?`, detail: "Uncommitted changes come along if they don't clash; otherwise git refuses and nothing changes.", label: "Switch", doing: "Switching", done: `On ${name}` }, ["switch", name]);
  },

  // A remote branch: a local branch tracking it.
  checkoutRemote(name) {
    const local = name.slice(name.indexOf("/") + 1);
    this.confirmGit({ title: `Check out ${local}?`, detail: `Makes a local ${local} that tracks ${name} and switches to it.`, label: "Check Out", doing: "Checking out", done: `On ${local}` }, ["switch", "--track", name]);
  },

  deleteBranch(b) {
    this.confirmGit({ title: `Delete branch ${b.name}?`, detail: "Only if it's merged: git refuses to delete unmerged work. The remote branch stays.", label: "Delete", danger: true, doing: "Deleting", done: `Deleted ${b.name}` }, ["branch", "-d", b.name]);
  },

  stashAction(s, kind) {
    const spec = {
      apply: { title: `Apply ${s.ref}?`, detail: `${s.subject}. The stash stays in the list; conflicts are left in the files for you to resolve.`, label: "Apply", doing: "Applying", done: `Applied ${s.ref}` },
      pop: { title: `Pop ${s.ref}?`, detail: `${s.subject}. Applies it and removes it from the list (kept if it conflicts).`, label: "Pop", doing: "Popping", done: `Popped ${s.ref}` },
      drop: { title: `Drop ${s.ref}?`, detail: `${s.subject}. Deletes the stash without applying it.`, label: "Drop", danger: true, doing: "Dropping", done: `Dropped ${s.ref}` },
    }[kind];
    this.confirmGit(spec, ["stash", kind, s.ref]);
  },

  openGraph() {
    showInViewer("vx-graph", { root: this.root, on: this.on ?? null }, `Graph · ${baseName(this.root)}`);
  },

  runSectionCmd(c, cx) {
    if (c.cmd === "graph") return this.openGraph();
    if (c.cmd === "compareWith") return this.setCompareBase(c.ref, cx);
    if (c.cmd === "switchBranch") return this.switchBranch(c.name);
    if (c.cmd === "stash") return this.stashAction({ ref: c.ref, subject: c.subject }, c.kind);
    if (c.cmd === "expand") return this.toggleExpand(c.kind, c.ref, cx);
  },

  commitActions(c, kind) {
    const t = theme();
    if (kind === "stash") {
      return openScmMenu(this.uid, [
        { id: "apply", icon: "download", color: t.ansi2, label: "Apply Stash…", cmd: { cmd: "stash", kind: "apply", ref: c.ref, subject: c.subject } },
        { id: "pop", icon: "arrow-up", color: t.ansi4, label: "Pop Stash…", cmd: { cmd: "stash", kind: "pop", ref: c.ref, subject: c.subject } },
        { id: "drop", icon: "trash", color: t.ansi1, label: "Drop Stash…", cmd: { cmd: "stash", kind: "drop", ref: c.ref, subject: c.subject } },
        { sep: true, id: "s1" },
        { id: "copy", icon: "copy", label: "Copy Message", copy: c.subject },
      ]);
    }
    const sha = c.hash;
    const url = commitUrl(this.remote, sha);
    const where = /github/i.test(this.remote?.host ?? "") ? "GitHub" : "GitLab";
    openScmMenu(this.uid, [
      { id: "files", icon: "files", label: this.expanded.has(`commit:${sha}`) ? "Hide Files" : "Show Files", cmd: { cmd: "expand", kind: "commit", ref: sha } },
      { id: "cmp", icon: "compare", color: t.accent, label: "Compare HEAD with This", cmd: { cmd: "compareWith", ref: sha } },
      { id: "graph", icon: "pipeline", label: "Open Commit Graph", cmd: { cmd: "graph" } },
      ...(url ? [{ id: "web", icon: "globe", color: t.ansi4, label: `Open on ${where}`, url }] : []),
      { sep: true, id: "s1" },
      { id: "sha", icon: "copy", label: "Copy SHA", sub: sha.slice(0, 8), copy: sha },
      { id: "msg", icon: "copy", label: "Copy Message", copy: c.subject },
      ...(url ? [{ id: "link", icon: "copy", label: "Copy Link", copy: url }] : []),
    ]);
  },

  // The branch chip's menu: new branch, then the most recent branches to switch to.
  branchMenu() {
    const t = theme();
    const list = Array.isArray(this.data.branches) ? this.data.branches : [];
    const items = [{ id: "new", icon: "branch-plus", color: t.ansi2, label: "New Branch…", cmd: { cmd: "branchAsk" } }];
    if (list.length > 1) items.push({ header: "Switch to", id: "h1" });
    for (const b of list.filter((x) => !x.current).slice(0, 12))
      items.push({ id: `b-${b.name}`, icon: "branch", color: t.ansi2, label: b.name, sub: timeAgo(b.at * 1000), cmd: { cmd: "switchBranch", name: b.name } });
    items.push({ sep: true, id: "s1" }, { id: "graph", icon: "pipeline", color: t.accent, label: "Open Commit Graph", cmd: { cmd: "graph" } });
    openScmMenu(this.uid, items, 290);
  },

  // ── drawing ────────────────────────────────────────────────────────────────────────────
  laneColor(t, i) {
    const pal = [t.accent, t.ansi2, t.ansi5, t.ansi3, t.ansi6, t.ansi4, t.ansi1];
    return pal[i % pal.length];
  },

  // One commit's slice of the graph: lines above / below the dot, the joint, the dot (hollow for
  // merges and for commits not pushed yet).
  lanes(t, row, width, outgoing) {
    const el = div().relative().w(width * LANE + 4).h(ROW).flex_none();
    const mid = ROW / 2;
    const x = (i) => i * LANE + LANE / 2 + 2;
    for (const i of row.top) if (i < width) el.child(div().absolute().left(x(i) - 1).top(0).w(2).h(mid).bg(this.laneColor(t, i)));
    for (const i of row.bottom) if (i < width) el.child(div().absolute().left(x(i) - 1).top(mid).w(2).h(mid).bg(this.laneColor(t, i)));
    const [a, b] = row.span;
    if (b > a && a < width) el.child(div().absolute().left(x(a)).top(mid - 1).w((Math.min(b, width - 1) - a) * LANE).h(2).bg(this.laneColor(t, Math.min(b, width - 1))));
    const col = Math.min(row.col, width - 1);
    const c = this.laneColor(t, col);
    el.child(div().absolute().left(x(col) - 4).top(mid - 4).size(8).rounded(4).bg(row.forks.length || outgoing ? t.background : c).border_2().border_color(outgoing ? t.ansi6 : c));
    return el;
  },

  avatar(t, name, size = 16) {
    const color = t[colorSlot(name)] ?? t.accent;
    return div().size(size).flex_none().rounded(size / 2).flex().items_center().justify_center().bg(tint(color, "33"))
      .text_size(Math.round(size * 0.5)).font_semibold().text_color(color).child(initials(name));
  },

  refPill(t, r) {
    const color = { head: t.accent, branch: t.ansi2, remote: t.ansi4, tag: t.ansi5 }[r.kind];
    return h_flex().flex_shrink(1).min_w(56).h(16).max_w(120).px(5).gap(3).items_center().rounded(8).overflow_hidden().bg(tint(color, "26")).text_size(TEXT.tiny).text_color(color)
      .child(Icon(r.kind === "tag" ? "tag" : r.kind === "remote" ? "cloud" : "branch", 9)).child(div().min_w(0).truncate().child(r.name))
      .when(Boolean(r.synced), (el) => el.child(Icon("cloud", 9)));
  },

  fileLine(t, f, depth, open) {
    const letter = f.status === "A" ? "A" : f.status === "D" ? "D" : "M";
    const color = markColor(letter, t);
    const slash = f.path.lastIndexOf("/");
    return h_flex().id(`sf-${depth}-${open.scope}-${open.sha ?? open.ref ?? open.base}-${f.path}`).h(ROW).flex_none().mx(4).pl(10 + depth * 12).pr(6).gap(6).items_center().rounded(5)
      .cursor_pointer().hover((s) => s.bg(t.hover)).text_size(TEXT.small).tooltip(f.path)
      .on_click(() => showInViewer(MOD, { root: this.root, on: this.on ?? null, path: f.path, ...open }, f.path.slice(slash + 1)))
      .child(FileIcon(this.icons, f.path, { size: 14 }))
      .child(div().flex_shrink(1).min_w(40).max_w(190).truncate().text_color(color).when(letter === "D", (el) => el.line_through()).child(f.path.slice(slash + 1)))
      .child(div().flex_1().min_w(0).truncate().text_size(TEXT.caption).text_color(t.dim).child(slash > 0 ? f.path.slice(0, slash) : ""))
      .child(div().w(16).h(16).flex_none().flex().items_center().justify_center().rounded(4).bg(tint(color, "22")).text_size(TEXT.tiny).font_semibold().text_color(color).child(f.status));
  },

  // A commit or stash row; `graph` = { row, width, outgoing } in the Commits section.
  commitLine(t, c, depth = 0, kind = "commit", graph = null) {
    const id = kind === "stash" ? c.ref : c.hash;
    const key = `${kind}:${id}`;
    const open = this.expanded.has(key);
    const files = this.expanded.get(key);
    const hot = this.hot === key;
    const out = graph?.outgoing;
    const refs = c.refs ? tidyRefs(refLabels(c.refs)) : [];
    const row = h_flex().id(`cm-${key}-${depth}`).h(ROW).flex_none().mx(4).pl(graph ? 2 : 8 + depth * 12).pr(4).gap(6).items_center().rounded(5)
      .cursor_pointer().bg(hot ? t.hover : open ? tint(t.accent, "14") : "#00000000").text_size(TEXT.small)
      .tooltip(kind === "stash" ? `${c.ref} · ${c.subject}\nClick: files · right-click: apply, pop, drop` : `${c.hash.slice(0, 8)} · ${c.author} · ${new Date(c.at * 1000).toISOString().slice(0, 16).replace("T", " ")}${out ? " · not pushed yet" : ""}\n${c.subject}\nClick: files · right-click: more`)
      .on_click((_e, cx) => this.toggleExpand(kind, id, cx))
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.commitActions(c, kind); })
      .when(Boolean(graph), (el) => el.child(this.lanes(t, graph.row, graph.width, out)))
      .when(!graph, (el) => el.child(Icon(open ? "chevron-down" : "chevron-right", 11).text_color(t.dim)))
      .when(kind === "stash", (el) => el.child(Icon("archive", 13).text_color(t.ansi5)))
      .when(kind !== "stash", (el) => el.child(this.avatar(t, c.author)))
      .when(refs.length > 0, (el) => el.child(this.refPill(t, refs[0])))
      .when(refs.length > 1, (el) => el.child(this.pill(`+${refs.length - 1}`, t.dim)))
      .child(div().flex_1().min_w(refs.length ? 90 : 0).truncate().text_color(c.parents?.length > 1 ? t.muted : t.foreground).child(c.subject));
    if (hot && kind === "stash") {
      row.child(IconButton({ id: `sa-${id}`, icon: "download", label: "Apply…", size: 20, onClick: () => this.stashAction(c, "apply") }))
        .child(IconButton({ id: `sp-${id}`, icon: "arrow-up", label: "Pop…", size: 20, onClick: () => this.stashAction(c, "pop") }))
        .child(IconButton({ id: `sd-${id}`, icon: "trash", label: "Drop…", size: 20, onClick: () => this.stashAction(c, "drop") }));
    } else if (hot) {
      row.child(IconButton({ id: `cp-${id}-${depth}`, icon: "copy", label: `Copy SHA ${c.hash.slice(0, 8)}`, size: 20, onClick: (cx) => cx.write_to_clipboard(c.hash) }))
        .child(IconButton({ id: `cc-${id}-${depth}`, icon: "compare", label: "Compare HEAD with this", size: 20, onClick: (cx) => this.setCompareBase(c.hash, cx) }));
    } else {
      if (out) row.child(div().flex_none().text_size(TEXT.caption).text_color(t.ansi6).child("↑"));
      row.child(div().flex_none().text_size(TEXT.caption).text_color(t.dim).child(timeAgo(c.at * 1000)));
    }
    const lines = [this.hoverable(row, key)];
    if (open) {
      const pad = graph ? graph.width * LANE + 30 : 40 + depth * 12;
      if (!files) lines.push(div().pl(pad).h(22).text_size(TEXT.caption).text_color(t.dim).child("Loading…"));
      else if (!files.length) lines.push(div().pl(pad).h(22).text_size(TEXT.caption).text_color(t.dim).child("No file changes."));
      else lines.push(...files.map((f) => this.fileLine(t, f, depth + 2, kind === "stash" ? { scope: "stash", ref: c.ref, subject: c.subject } : { scope: "commit", sha: c.hash, subject: c.subject })));
    }
    return lines;
  },

  sectionHead(t, id, label, icon, color, count, actions = []) {
    const open = this.open.has(id);
    return h_flex().id(`sec-${id}`).h(28).flex_none().mt(4).mx(4).pl(6).pr(4).gap(6).items_center().rounded(5).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.toggleSection(id, cx))
      .child(Icon(open ? "chevron-down" : "chevron-right", 11).text_color(t.dim))
      .child(div().size(20).flex_none().rounded(5).flex().items_center().justify_center().bg(tint(color, "22")).child(Icon(icon, 12).text_color(color)))
      .child(div().text_size(TEXT.caption).font_semibold().text_color(t.foreground).child(label))
      .when(count !== undefined && count !== null, (el) => el.child(this.pill(count, color)))
      .child(div().flex_1())
      .children(actions);
  },

  refRow(t, id, { icon, iconColor, name, nameColor, sub, at, right = [], onClick, tip }) {
    const hot = this.hot === id;
    return this.hoverable(h_flex().id(id).h(ROW).flex_none().mx(4).pl(24).pr(4).gap(6).items_center().rounded(5).text_size(TEXT.small)
      .bg(hot ? t.hover : "#00000000")
      .when(Boolean(onClick), (el) => el.cursor_pointer().on_click((_e, cx) => onClick(cx)))
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .child(Icon(icon, 13).text_color(iconColor ?? t.dim))
      .child(div().flex_shrink(1).min_w(40).max_w(170).truncate().text_color(nameColor ?? t.foreground).child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(TEXT.caption).text_color(t.dim).child(sub ?? ""))
      .when(hot, (el) => el.children(right))
      .when(!hot && Boolean(at), (el) => el.child(div().flex_none().text_size(TEXT.caption).text_color(t.dim).child(timeAgo(at * 1000)))), id);
  },

  renderSections(t) {
    const out = [];
    for (const [id, label, icon, colorKey] of SECTIONS) {
      const color = t[colorKey] ?? t.accent;
      const d = this.data[id];
      const count = id === "commits" ? d?.commits?.length : Array.isArray(d) ? d.length : id === "compare" && d?.commits ? d.commits.length : null;
      const actions = {
        commits: [IconButton({ id: "graph", icon: "pipeline", label: "Open Commit Graph", size: 20, onClick: () => this.openGraph() })],
        branches: [IconButton({ id: "br-new", icon: "plus", label: "New Branch…", size: 20, onClick: (cx) => this.runCmd({ cmd: "branchAsk" }, cx) })],
        stashes: [IconButton({ id: "st-new", icon: "plus", label: "Stash Changes…", size: 20, disabled: !this.files.length, onClick: (cx) => this.runCmd({ cmd: "stashAsk" }, cx) })],
      }[id] ?? [];
      out.push(this.sectionHead(t, id, label, icon, color, count, actions));
      if (!this.open.has(id)) continue;
      if (d === undefined) {
        out.push(Message("Loading…"));
        continue;
      }
      if (d?.error && id !== "compare") {
        out.push(Message(d.error, true));
        continue;
      }
      if (id === "commits") out.push(...this.renderCommits(t, d));
      else if (id === "branches") {
        for (const b of d) {
          const bits = [b.behind ? `↓${b.behind}` : "", b.ahead ? `↑${b.ahead}` : ""].filter(Boolean).join(" ");
          out.push(this.refRow(t, `br-${b.name}`, {
            icon: b.current ? "check" : "branch", iconColor: b.current ? t.accent : t.ansi2, name: b.name, nameColor: b.current ? t.accent : null, at: b.at,
            sub: b.gone ? "upstream gone" : `${bits}${bits ? " " : ""}${b.upstream ? `→ ${b.upstream}` : "local only"}`,
            tip: `${b.name}${b.current ? " (current)" : " · click to switch"}\n${b.subject}`,
            onClick: b.current ? null : () => this.switchBranch(b.name),
            right: [
              IconButton({ id: `cmp-${b.name}`, icon: "compare", label: `Compare HEAD with ${b.name}`, size: 20, onClick: (cx) => this.setCompareBase(b.name, cx) }),
              ...(b.current ? [] : [IconButton({ id: `del-${b.name}`, icon: "trash", label: "Delete branch…", size: 20, onClick: () => this.deleteBranch(b) })]),
            ],
          }));
        }
      } else if (id === "remotes") {
        const byRemote = new Map();
        for (const b of d) {
          const r = b.name.split("/")[0];
          if (!byRemote.has(r)) byRemote.set(r, []);
          byRemote.get(r).push(b);
        }
        for (const [remote, list] of byRemote) {
          out.push(h_flex().h(22).mx(4).pl(24).items_center().gap(6).text_size(TEXT.caption).text_color(t.muted)
            .child(Icon("cloud", 12).text_color(t.ansi6)).child(div().font_medium().child(remote)).child(this.pill(list.length, t.ansi6)));
          for (const b of list.slice(0, 80))
            out.push(this.refRow(t, `rm-${b.name}`, { icon: "branch", iconColor: t.ansi4, name: b.name.slice(remote.length + 1), sub: b.subject, at: b.at,
              right: [
                IconButton({ id: `rcmp-${b.name}`, icon: "compare", label: `Compare HEAD with ${b.name}`, size: 20, onClick: (cx) => this.setCompareBase(b.name, cx) }),
                IconButton({ id: `rco-${b.name}`, icon: "download", label: "Check out as a local branch…", size: 20, onClick: () => this.checkoutRemote(b.name) }),
              ] }));
        }
      } else if (id === "stashes") {
        if (!d.length) out.push(Message("No stashes. ⋯ › Stash Changes puts your work aside."));
        for (const s of d) out.push(...this.commitLine(t, s, 0, "stash"));
      } else if (id === "tags") {
        if (!d.length) out.push(Message("No tags."));
        for (const tg of d) out.push(this.refRow(t, `tag-${tg.name}`, { icon: "tag", iconColor: t.ansi3, name: tg.name, sub: tg.subject, at: tg.at,
          right: [IconButton({ id: `tcmp-${tg.name}`, icon: "compare", label: `Compare HEAD with ${tg.name}`, size: 20, onClick: (cx) => this.setCompareBase(tg.name, cx) })] }));
      } else if (id === "compare") {
        out.push(...this.renderCompare(t, d));
      }
    }
    return out;
  },

  renderCommits(t, d) {
    const out = [];
    if (d.incoming.length) {
      const key = "incoming";
      const open = !this.closed.has(key);
      out.push(h_flex().id("inc").h(ROW).flex_none().mx(4).pl(8).pr(6).gap(6).items_center().rounded(5).cursor_pointer()
        .bg(tint(t.ansi4, "14")).hover((s) => s.bg(tint(t.ansi4, "26"))).text_size(TEXT.small).on_click((_e, cx) => this.toggleGroup(key, cx))
        .child(Icon(open ? "chevron-down" : "chevron-right", 11).text_color(t.dim))
        .child(Icon("arrow-down", 12).text_color(t.ansi4))
        .child(div().flex_1().min_w(0).truncate().text_color(t.ansi4).font_medium().child(`Incoming from ${this.upstream}`))
        .child(this.pill(d.incoming.length, t.ansi4)));
      if (open) for (const c of d.incoming) out.push(...this.commitLine(t, c, 1));
    }
    d.commits.forEach((c, i) => out.push(...this.commitLine(t, c, 0, "commit", { row: d.rows[i], width: d.width, outgoing: d.outgoing.has(c.hash) })));
    if (d.more)
      out.push(h_flex().id("more").h(ROW).mx(4).pl(24).items_center().gap(6).rounded(5).text_size(TEXT.caption).text_color(t.accent).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.commitCount += PAGE; this.loadSection("commits", cx); }).child(Icon("chevron-down", 11)).child("Load more"));
    return out;
  },

  renderCompare(t, d) {
    const out = [];
    // Search: message / author / file / commit, across all branches.
    out.push(v_flex().flex_none().px(10).py(6).gap(6)
      .child(h_flex().gap(4).children(MODES.map(([id, label]) =>
        h_flex().id(`sm-${id}`).h(22).px(8).items_center().rounded(11).text_size(TEXT.caption).cursor_pointer()
          .bg(this.searchMode === id ? tint(t.accent, "33") : t.raised).text_color(this.searchMode === id ? t.foreground : t.dim)
          .hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { this.searchMode = id; cx.notify(); }).child(label))))
      .child(h_flex().h(28).px(8).gap(6).items_center().rounded(7).border_1().border_color(t.border).bg(t.input ?? t.background)
        .child(Icon("search", 12).text_color(t.dim))
        .child(Input.new(this.search).flex_1().h(26).text_size(TEXT.small))
        .child(IconButton({ id: "search-go", icon: this.searching ? "spinner" : "chevron-right", spinning: this.searching, label: "Search (Enter)", size: 20, onClick: (cx) => this.runSearch(cx) }))));
    if (this.results) {
      out.push(h_flex().h(22).px(12).items_center().text_size(TEXT.caption).text_color(t.muted)
        .child(`${this.results.commits.length} commit${this.results.commits.length === 1 ? "" : "s"} for ${this.results.mode} “${this.results.q}”`));
      if (this.results.error) out.push(Message(this.results.error, true));
      for (const c of this.results.commits.slice(0, 100)) out.push(...this.commitLine(t, c, 1));
    }
    // Compare: what this branch has that its base doesn't.
    if (d?.error) out.push(Message(d.error, true));
    else if (d) {
      const base = /^[0-9a-f]{40}$/.test(d.base) ? d.base.slice(0, 8) : d.base;
      out.push(h_flex().h(28).mx(10).my(2).px(10).gap(6).items_center().rounded(6).bg(tint(t.accent, "14")).text_size(TEXT.caption)
        .child(Icon("compare", 12).text_color(t.accent))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(`${this.branch ?? "HEAD"}  ⟷  ${base}`))
        .child(div().text_color(t.ansi6).child(`↑${d.commits.length}`))
        .child(div().text_color(t.ansi4).child(`↓${d.behind}`)));
      if (!d.commits.length && !d.files.length) out.push(Message(`Nothing on ${this.branch ?? "HEAD"} that ${base} doesn't have.`));
      for (const c of d.commits.slice(0, 50)) out.push(...this.commitLine(t, c, 1));
      if (d.files.length) {
        out.push(h_flex().h(22).px(22).items_center().text_size(TEXT.caption).text_color(t.muted).child(`${d.files.length} file${d.files.length === 1 ? "" : "s"} changed`));
        for (const f of d.files.slice(0, 300)) out.push(this.fileLine(t, f, 1, { scope: "compare", base: d.base, head: "HEAD" }));
      }
    }
    return out;
  },
};
