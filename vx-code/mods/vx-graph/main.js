// vx-graph: GitLens' Commit Graph as a centre tab. Lanes from graph-core.js, branch / tag /
// remote labels, author and age; click a commit for its details (message, files) on the right,
// and a file there for that commit's diff in the Changes diff tab. Reads only.
//   props { mode: "view", space }   follows shared("vx-graph.view")[space] = { root, on }
//   props { root }                  a tab opened directly for one repo
import { View, div } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar } from "gpui-base";
import { theme, props, checking } from "herdr";
import { git, changedAt, baseName, ctx, contextKey, repoTop } from "./ws.js";
import { RepoButton, RepoMenu } from "./repo-picker.js";
import { parseGraphLog, layoutGraph, refLabels, GRAPH_FORMAT } from "./graph-core.js";
import { timeAgo } from "./git-core.js";
import { TEXT, Icon, IconButton, Badge, FileIcon, Message, markColor, codeFont } from "./ui.js";
import { viewerValue, showInViewer } from "./tabs.js";
import { loadIcons } from "./icons.js";

const ROW = 26;
const LANE = 14;
const COUNT = 600;

class VxGraph extends View {
  init(given, cx) {
    const p = props() ?? given ?? {};
    if (p.repoMenu) {
      this.repoMenu = p.repoMenu;
      loadIcons(this, cx);
      return;
    }
    this.space = p.space ?? null;
    this.tops = new Map();
    this.fixed = p.root ? { root: p.root, on: p.on ?? null } : null;
    this.all = localStorage.getItem("all") !== "0";
    loadIcons(this, cx);
    if (checking()) return;
    cx.timer.every(500, (cx) => this.follow(cx));
  }

  // A tab opened for one repo (props.root) stays on it; otherwise the graph follows the repo
  // every vx panel shows (switch it from the header), falling back to what it was opened with.
  target() {
    return this.fixed ?? this.auto ?? viewerValue("vx-graph", this.space);
  }

  follow(cx) {
    if (!this.fixed) {
      const c = ctx();
      const ck = contextKey(c);
      if (ck !== this.ctxKey) {
        this.ctxKey = ck;
        cx.spawn(async (cx) => {
          const top = c.cwd ? await repoTop(this.tops, c.cwd, c.on) : null;
          if (this.ctxKey !== ck) return;
          if (top) {
            this.auto = { root: top, on: c.on ?? null };
            this.selected = null;
            this.follow(cx);
          }
        });
      }
    }
    const v = this.target();
    const key = v ? `${v.on ?? ""}|${v.root}|${this.all}` : null;
    if (key && (key !== this.key || changedAt() !== this.seenChange)) {
      this.key = key;
      this.seenChange = changedAt();
      this.load(v, cx);
    }
  }

  load(v, cx) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const r = await git(["log", ...(this.all ? ["--all"] : []), "--date-order", "-n", String(COUNT), GRAPH_FORMAT], { cwd: v.root, on: v.on });
        if (r.code !== 0) throw new Error(r.stderr.trim() || "git log failed");
        const commits = parseGraphLog(r.stdout);
        const { rows, width } = layoutGraph(commits);
        this.repo = v;
        this.commits = commits;
        this.rows = rows;
        this.width = Math.min(width, 16);
        this.error = null;
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  select(hash, cx) {
    const c = this.commits.find((x) => x.hash === hash);
    if (!c) return;
    this.selected = { commit: c, files: null, body: null };
    cx.notify();
    const v = this.repo;
    cx.spawn(async (cx) => {
      const [files, body] = await Promise.all([
        git(["show", "--format=", "--name-status", "--no-renames", "-m", "--first-parent", hash], { cwd: v.root, on: v.on }),
        git(["show", "-s", "--format=%B%x00%an <%ae>%x00%ci", hash], { cwd: v.root, on: v.on }),
      ]);
      if (this.selected?.commit.hash !== hash) return;
      const [msg, author, date] = body.stdout.split("\0");
      this.selected.files = files.stdout.split("\n").filter(Boolean).map((l) => l.split("\t")).filter((p) => p.length >= 2).map(([s, ...p]) => ({ status: s[0], path: p.at(-1) }));
      this.selected.body = { msg: msg.trim(), author, date: (date ?? "").trim() };
      cx.notify();
    });
  }

  laneColor(t, i) {
    const pal = [t.accent, t.ansi2, t.ansi5, t.ansi3, t.ansi6, t.ansi4, t.ansi1];
    return pal[i % pal.length];
  }

  // One row's lanes: vertical halves above/below the middle, the joint, and the dot.
  lanes(t, row) {
    const w = this.width * LANE;
    const mid = ROW / 2;
    const el = div().relative().w(w).h(ROW).flex_none();
    const x = (i) => i * LANE + LANE / 2;
    for (const i of row.top) if (i < this.width) el.child(div().absolute().left(x(i) - 1).top(0).w(2).h(mid).bg(this.laneColor(t, i)));
    for (const i of row.bottom) if (i < this.width) el.child(div().absolute().left(x(i) - 1).top(mid).w(2).h(mid).bg(this.laneColor(t, i)));
    const [a, b] = row.span;
    if (b > a) el.child(div().absolute().left(x(a)).top(mid - 1).w((Math.min(b, this.width - 1) - a) * LANE).h(2).bg(this.laneColor(t, b)));
    if (row.col < this.width) {
      const merge = row.forks.length > 0;
      el.child(div().absolute().left(x(row.col) - 5).top(mid - 5).size(10).rounded(5)
        .bg(merge ? t.background : this.laneColor(t, row.col)).border_2().border_color(this.laneColor(t, row.col)));
    }
    return el;
  }

  label(t, r) {
    const color = { head: t.accent, branch: t.ansi2, remote: t.ansi4, tag: t.ansi5 }[r.kind];
    return h_flex().flex_none().h(17).px(5).gap(3).items_center().rounded(4).border_1().border_color(color).text_size(TEXT.tiny).text_color(color)
      .child(Icon(r.kind === "tag" ? "check" : r.kind === "remote" ? "external" : "branch", 9)).child(div().max_w(150).truncate().child(r.name));
  }

  row(t, i) {
    const c = this.commits[i];
    const row = this.rows[i];
    const sel = this.selected?.commit.hash === c.hash;
    return h_flex().id(c.hash).h(ROW).w_full().pr(10).gap(8).items_center().bg(sel ? t.selected : "#00000000").text_size(TEXT.small)
      .child(div().pl(6).child(this.lanes(t, row)))
      .children(refLabels(c.refs).slice(0, 4).map((r) => this.label(t, r)))
      .child(div().flex_1().min_w(0).truncate().text_color(c.parents.length > 1 ? t.muted : t.foreground).child(c.subject))
      .child(div().flex_none().w(120).truncate().text_size(TEXT.caption).text_color(t.dim).child(c.author))
      .child(div().flex_none().w(40).text_right().text_size(TEXT.caption).text_color(t.dim).child(timeAgo(c.at * 1000)))
      .child(div().flex_none().w(64).font_family(codeFont()).text_size(TEXT.caption).text_color(t.dim).child(c.hash.slice(0, 8)));
  }

  details(t) {
    const s = this.selected;
    const c = s.commit;
    const pane = v_flex().id("details").w(340).flex_none().h_full().border_l(1).border_color(t.border).bg(t.chrome)
      .child(h_flex().h(30).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border)
        .child(Icon("git-commit", 13).text_color(t.accent))
        .child(div().flex_1().font_family(codeFont()).text_size(TEXT.small).child(c.hash.slice(0, 10)))
        .child(IconButton({ id: "copy", icon: "copy", label: "Copy hash", size: 20, onClick: (cx) => cx.write_to_clipboard(c.hash) }))
        .child(IconButton({ id: "close", icon: "x", label: "Close", size: 20, onClick: (cx) => { this.selected = null; cx.notify(); } })));
    const body = v_flex().id("details-body").flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(8);
    body.child(div().text_size(TEXT.body).whitespace_normal().text_color(t.foreground).child(s.body?.msg ?? c.subject));
    if (s.body) body.child(div().text_size(TEXT.caption).text_color(t.dim).child(`${s.body.author}\n${s.body.date}`));
    if (c.refs.length) body.child(h_flex().flex_wrap().gap(4).children(refLabels(c.refs).map((r) => this.label(t, r))));
    if (c.parents.length > 1) body.child(div().text_size(TEXT.caption).text_color(t.dim).child(`Merge of ${c.parents.map((p) => p.slice(0, 8)).join(" + ")} · files vs first parent`));
    if (!s.files) body.child(Message("Loading files…"));
    else {
      body.child(div().text_size(TEXT.caption).font_medium().text_color(t.muted).child(`${s.files.length} FILE${s.files.length === 1 ? "" : "S"}`));
      body.children(s.files.map((f) => {
        const color = markColor(f.status === "A" ? "A" : f.status === "D" ? "D" : "M", t);
        const slash = f.path.lastIndexOf("/");
        return h_flex().id(`gf-${f.path}`).h(24).flex_none().px(4).gap(6).items_center().rounded(5).cursor_pointer().hover((st) => st.bg(t.hover)).text_size(TEXT.small)
          .on_click(() => showInViewer("vx-changes", { root: this.repo.root, on: this.repo.on ?? null, path: f.path, scope: "commit", sha: c.hash, subject: c.subject }, f.path.slice(slash + 1)))
          .child(FileIcon(this.icons, f.path, { size: 13 }))
          .child(div().flex_none().max_w(170).truncate().text_color(color).child(f.path.slice(slash + 1)))
          .child(div().flex_1().min_w(0).truncate().text_size(TEXT.caption).text_color(t.dim).child(slash > 0 ? f.path.slice(0, slash) : ""))
          .child(div().w(10).text_size(TEXT.caption).text_color(color).child(f.status));
      }));
    }
    return pane.child(body);
  }

  render() {
    if (this.repoMenu) return RepoMenu(this);
    const t = theme();
    const v = this.target();
    const root = v_flex().id("vx-graph").size_full().min_w(0).min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground);
    root.child(h_flex().h(32).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border).text_size(TEXT.small)
      .child(Icon("pipeline", 14).text_color(t.accent))
      .child(this.fixed ? div().font_medium().child(baseName(v.root)) : RepoButton(this, "vx-graph", v?.root ?? null))
      .child(div().flex_1().text_color(t.dim).child(this.commits ? `${this.commits.length} commits${this.commits.length >= COUNT ? " (latest)" : ""}` : ""))
      .child(h_flex().id("scope").h(22).px(8).items_center().rounded(11).cursor_pointer().text_size(TEXT.caption)
        .text_color(t.accent).hover((s) => s.bg(t.hover)).tooltip("Show every branch, or only the current one")
        .on_click((_e, cx) => { this.all = !this.all; localStorage.setItem("all", this.all ? "1" : "0"); cx.notify(); })
        .child(this.all ? "all branches" : "current branch"))
      .child(IconButton({ id: "refresh", icon: "refresh", label: "Refresh", spinning: Boolean(this.loading), size: 22, onClick: (cx) => { this.key = null; this.follow(cx); } })));
    if (!v) return root.child(Message("Open the graph from the Commits section in Changes."));
    if (this.error) return root.child(Message(this.error, true));
    if (!this.rows) return root.child(Message("Loading…"));
    const listId = `graph-${this.key}`;
    const list = div().id("g-list").flex_1().min_w(0).h_full().relative()
      .child(v_virtual_list(listId, this.rows.length, ROW, (i) => this.commits[i].hash, (range) => {
        const out = [];
        for (let i = range.start; i < range.end; i++) out.push(this.row(t, i));
        return out;
      }).on_item_click((hash, cx) => this.select(hash, cx)).size_full())
      .child(Scrollbar.vertical(listId).viewport_from_layout().absolute().inset_0());
    return root.child(h_flex().flex_1().min_h(0).child(list).when(Boolean(this.selected), (el) => el.child(this.details(t))));
  }
}

export default VxGraph;
