// GitLens-style sections under the working changes: Commits (expand one for its files),
// Branches, Remotes, Stashes, Tags, and Search & Compare. Each section loads when opened and
// reloads when the repo changes. Clicking a file opens its diff in the diff tab. The only
// actions that change anything (switch branch, apply stash) always ask first.
import { div } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { theme, setShared } from "herdr";
import { git, bump } from "./ws.js";
import { parseLog, LOG_FORMAT, timeAgo } from "./git-core.js";
import { TEXT, Icon, IconButton, Badge, FileIcon, Message, markColor, codeFont } from "./ui.js";
import { showInViewer } from "./tabs.js";
import { askConfirm } from "./actions.js";

const MOD = "vx-changes";
const PAGE = 50;
const SECTIONS = [
  ["commits", "Commits"], ["branches", "Branches"], ["remotes", "Remotes"],
  ["stashes", "Stashes"], ["tags", "Tags"], ["compare", "Search & Compare"],
];
const MODES = [["message", "Message"], ["author", "Author"], ["file", "File"], ["sha", "Commit"]];

// `git show --name-status` / `git diff --name-status` lines -> [{ status, path }].
const nameStatus = (out) => String(out ?? "").split("\n").filter(Boolean)
  .map((l) => l.split("\t")).filter((p) => p.length >= 2).map(([s, ...rest]) => ({ status: s[0], path: rest.at(-1) }));

export const sectionMethods = {
  initSections() {
    this.open = new Set(JSON.parse(localStorage.getItem("sections") ?? '["commits"]'));
    this.data = {};
    this.expanded = new Map(); // "kind:id" -> files, while open
    this.commitCount = PAGE;
    this.searchMode = "message";
    this.search.on("change", (_e, cx) => cx.notify());
    this.search.on("submit", (_e, cx) => this.runSearch(cx));
  },

  // Called after the working changes refresh: reload every open section.
  refreshSections(cx) {
    if (!this.root) return;
    for (const id of this.open) this.loadSection(id, cx);
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
          const r = await g(["log", "-n", String(this.commitCount), LOG_FORMAT]);
          value = r.code === 0 ? parseLog(r.stdout) : [];
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

  // ── actions that ask first ─────────────────────────────────────────────────────────────
  switchBranch(b) {
    askConfirm(MOD, {
      title: `Switch to ${b.name}?`,
      detail: "Uncommitted changes come along if they don't clash; otherwise git refuses and nothing changes.",
      label: "Switch",
      action: { cmd: "git", args: ["switch", b.name], cwd: this.root, on: this.on, doing: "Switching", done: `On ${b.name}`, root: this.root },
    });
  },

  applyStash(s) {
    askConfirm(MOD, {
      title: `Apply ${s.ref}?`,
      detail: `${s.subject}. The stash stays in the list; conflicts are left in the files for you to resolve.`,
      label: "Apply",
      action: { cmd: "git", args: ["stash", "apply", s.ref], cwd: this.root, on: this.on, doing: "Applying", done: `Applied ${s.ref}`, root: this.root },
    });
  },

  openGraph() {
    showInViewer("vx-graph", { root: this.root, on: this.on ?? null }, `Graph · ${this.root.split("/").pop()}`);
  },

  // ── drawing ────────────────────────────────────────────────────────────────────────────
  fileLine(t, f, depth, open) {
    const color = markColor(f.status === "A" ? "A" : f.status === "D" ? "D" : "M", t);
    const slash = f.path.lastIndexOf("/");
    return h_flex().id(`sf-${depth}-${open.scope}-${open.sha ?? open.ref ?? open.base}-${f.path}`).h(24).flex_none().mx(4).pl(10 + depth * 14).pr(8).gap(6).items_center().rounded(5)
      .cursor_pointer().hover((s) => s.bg(t.hover)).text_size(TEXT.small)
      .on_click(() => showInViewer(MOD, { root: this.root, on: this.on ?? null, path: f.path, ...open }, f.path.slice(slash + 1)))
      .child(FileIcon(this.icons, f.path, { size: 13 }))
      .child(div().flex_none().max_w(200).truncate().text_color(color).child(f.path.slice(slash + 1)))
      .child(div().flex_1().min_w(0).truncate().text_size(TEXT.caption).text_color(t.dim).child(slash > 0 ? f.path.slice(0, slash) : ""))
      .child(div().w(10).flex_none().text_size(TEXT.caption).text_color(color).child(f.status));
  },

  commitLine(t, c, depth = 0, kind = "commit") {
    const id = kind === "stash" ? c.ref : c.hash;
    const key = `${kind}:${id}`;
    const open = this.expanded.has(key);
    const files = this.expanded.get(key);
    const row = h_flex().id(`cm-${key}`).h(26).flex_none().mx(4).pl(8 + depth * 14).pr(6).gap(6).items_center().rounded(5)
      .cursor_pointer().hover((s) => s.bg(t.hover)).text_size(TEXT.small)
      .tooltip(kind === "stash" ? c.subject : `${c.short} · ${c.author} · ${new Date(c.at * 1000).toISOString().slice(0, 16).replace("T", " ")}\n${c.subject}`)
      .on_click((_e, cx) => this.toggleExpand(kind, id, cx))
      .child(Icon(open ? "chevron-down" : "chevron-right", 11).text_color(t.dim))
      .child(Icon(kind === "stash" ? "archive" : "git-commit", 12).text_color(kind === "stash" ? t.ansi5 : t.dim))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(c.subject))
      .when(kind !== "stash", (el) => el.child(div().flex_none().max_w(80).truncate().text_size(TEXT.caption).text_color(t.dim).child(c.author)))
      .child(div().flex_none().text_size(TEXT.caption).text_color(t.dim).child(timeAgo(c.at * 1000)))
      .when(kind === "stash", (el) => el.child(IconButton({ id: `apply-${id}`, icon: "download", label: "Apply…", size: 20, onClick: () => this.applyStash(c) })));
    const out = [row];
    if (open) {
      if (!files) out.push(div().pl(40 + depth * 14).h(22).text_size(TEXT.caption).text_color(t.dim).child("Loading…"));
      else if (!files.length) out.push(div().pl(40 + depth * 14).h(22).text_size(TEXT.caption).text_color(t.dim).child("No file changes."));
      else out.push(...files.map((f) => this.fileLine(t, f, depth + 2, kind === "stash" ? { scope: "stash", ref: c.ref, subject: c.subject } : { scope: "commit", sha: c.hash, subject: c.subject })));
    }
    return out;
  },

  sectionHead(t, id, label, count, right) {
    const open = this.open.has(id);
    return h_flex().id(`sec-${id}`).h(28).flex_none().px(10).gap(6).items_center().cursor_pointer().border_t(1).border_color(t.border)
      .on_click((_e, cx) => this.toggleSection(id, cx))
      .child(Icon(open ? "chevron-down" : "chevron-right", 11).text_color(t.dim))
      .child(div().text_size(TEXT.caption).font_medium().text_color(t.muted).child(label.toUpperCase()))
      .when(count !== undefined && count !== null, (el) => el.child(Badge(count)))
      .child(div().flex_1())
      .when(Boolean(right), (el) => el.child(right));
  },

  refRow(t, id, { icon, name, sub, at, color, right, onClick, tip }) {
    return h_flex().id(id).h(26).flex_none().mx(4).pl(22).pr(6).gap(6).items_center().rounded(5).text_size(TEXT.small)
      .when(Boolean(onClick), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)))
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .child(Icon(icon, 12).text_color(color ?? t.dim))
      .child(div().flex_none().max_w(200).truncate().text_color(color ?? t.foreground).child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(TEXT.caption).text_color(t.dim).child(sub ?? ""))
      .when(Boolean(at), (el) => el.child(div().flex_none().text_size(TEXT.caption).text_color(t.dim).child(timeAgo(at * 1000))))
      .children(right ?? []);
  },

  renderSections(t) {
    const out = [];
    for (const [id, label] of SECTIONS) {
      const d = this.data[id];
      const count = Array.isArray(d) ? d.length : id === "compare" && d?.commits ? d.commits.length : null;
      const right = id === "commits"
        ? IconButton({ id: "graph", icon: "pipeline", label: "Open Commit Graph", size: 20, onClick: () => this.openGraph() })
        : null;
      out.push(this.sectionHead(t, id, label, count, right));
      if (!this.open.has(id)) continue;
      if (d === undefined) {
        out.push(Message("Loading…"));
        continue;
      }
      if (d?.error && id !== "compare") {
        out.push(Message(d.error, true));
        continue;
      }
      if (id === "commits") {
        for (const c of d) out.push(...this.commitLine(t, c));
        if (d.length >= this.commitCount)
          out.push(h_flex().id("more").h(24).px(22).items_center().text_size(TEXT.caption).text_color(t.accent).cursor_pointer()
            .on_click((_e, cx) => { this.commitCount += PAGE; this.loadSection("commits", cx); }).child("Load more…"));
      } else if (id === "branches") {
        for (const b of d) {
          out.push(this.refRow(t, `br-${b.name}`, {
            icon: "branch", name: b.name, color: b.current ? t.accent : null, at: b.at,
            sub: b.gone ? "upstream gone" : [b.ahead ? `↑${b.ahead}` : "", b.behind ? `↓${b.behind}` : "", b.upstream ? `→ ${b.upstream}` : "local only"].filter(Boolean).join(" "),
            tip: `${b.name}${b.current ? " (current)" : ""}\n${b.subject}`,
            right: b.current ? [Badge("current", t.accent)] : [
              IconButton({ id: `cmp-${b.name}`, icon: "split", label: `Compare HEAD with ${b.name}`, size: 20, onClick: (cx) => this.setCompareBase(b.name, cx) }),
              IconButton({ id: `sw-${b.name}`, icon: "check", label: "Switch to this branch…", size: 20, onClick: () => this.switchBranch(b) }),
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
          out.push(h_flex().h(22).px(22).items_center().gap(6).text_size(TEXT.caption).text_color(t.muted).child(Icon("external", 11)).child(`${remote} · ${list.length}`));
          for (const b of list.slice(0, 80))
            out.push(this.refRow(t, `rm-${b.name}`, { icon: "branch", name: b.name.slice(remote.length + 1), sub: b.subject, at: b.at,
              right: [IconButton({ id: `rcmp-${b.name}`, icon: "split", label: `Compare HEAD with ${b.name}`, size: 20, onClick: (cx) => this.setCompareBase(b.name, cx) })] }));
        }
      } else if (id === "stashes") {
        if (!d.length) out.push(Message("No stashes."));
        for (const s of d) out.push(...this.commitLine(t, s, 0, "stash"));
      } else if (id === "tags") {
        if (!d.length) out.push(Message("No tags."));
        for (const tg of d) out.push(this.refRow(t, `tag-${tg.name}`, { icon: "check", name: tg.name, sub: tg.subject, at: tg.at, color: t.ansi5,
          right: [IconButton({ id: `tcmp-${tg.name}`, icon: "split", label: `Compare HEAD with ${tg.name}`, size: 20, onClick: (cx) => this.setCompareBase(tg.name, cx) })] }));
      } else if (id === "compare") {
        out.push(...this.renderCompare(t, d));
      }
    }
    return out;
  },

  renderCompare(t, d) {
    const out = [];
    // Search: message / author / file / commit, across all branches.
    out.push(v_flex().flex_none().px(10).py(6).gap(6)
      .child(h_flex().gap(4).children(MODES.map(([id, label]) =>
        h_flex().id(`sm-${id}`).h(20).px(7).items_center().rounded(10).text_size(TEXT.caption).cursor_pointer()
          .bg(this.searchMode === id ? t.selected : "#00000000").text_color(this.searchMode === id ? t.foreground : t.dim)
          .on_click((_e, cx) => { this.searchMode = id; cx.notify(); }).child(label))))
      .child(h_flex().h(26).px(8).gap(6).items_center().rounded(6).border_1().border_color(t.border).bg(t.input ?? t.background)
        .child(Icon("search", 12).text_color(t.dim))
        .child(Input.new(this.search).flex_1().h(24).text_size(TEXT.small))
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
      out.push(h_flex().h(26).px(12).gap(6).items_center().text_size(TEXT.caption).text_color(t.muted)
        .child(Icon("split", 11))
        .child(div().flex_1().min_w(0).truncate().child(`${this.branch ?? "HEAD"} vs ${d.base}`))
        .child(div().text_color(t.ansi6).child(`↑${d.commits.length}`))
        .child(div().text_color(t.ansi4).child(`↓${d.behind}`)));
      if (!d.commits.length && !d.files.length) out.push(Message(`Nothing on ${this.branch ?? "HEAD"} that ${d.base} doesn't have.`));
      for (const c of d.commits.slice(0, 50)) out.push(...this.commitLine(t, c, 1));
      if (d.files.length) {
        out.push(h_flex().h(22).px(22).items_center().text_size(TEXT.caption).text_color(t.muted).child(`${d.files.length} file${d.files.length === 1 ? "" : "s"} changed`));
        for (const f of d.files.slice(0, 300)) out.push(this.fileLine(t, f, 1, { scope: "compare", base: d.base, head: "HEAD" }));
      }
    }
    return out;
  },
};
