import { View, div } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar } from "gpui-base";
import { theme, props, checking } from "herdr";
import { git, changedAt, baseName, ctx, contextKey, repoTop } from "./ws.js";
import { RepoButton, RepoMenu } from "./repo-picker.js";
import { parseGraphLog, layoutGraph, refLabels, GRAPH_FORMAT } from "./graph-core.js";
import { timeAgo } from "./git-core.js";
import { TEXT, Icon, IconButton, FileIcon, Message, markColor, codeFont } from "./ui.js";
import { viewerValue, showInViewer } from "./tabs.js";
import { loadIcons } from "./icons.js";

class VxGraph extends View {
  static MOD = "vx-graph";
  static ROW = 26;
  static LANE = 14;
  static COUNT = 600;
  static MAX_LANES = 16;
  static FOLLOW_MS = 500;
  static MAX_ROW_LABELS = 4;
  static DOT_SIZE = 10;
  static LINE_WIDTH = 2;
  static SHORT_SHA = 8;
  static DETAIL_SHA = 10;
  static MS_PER_SECOND = 1000;
  static TRANSPARENT = "#00000000";
  static KEY_ALL = "all";

  static laneColor(t, lane) {
    const palette = [t.accent, t.ansi2, t.ansi5, t.ansi3, t.ansi6, t.ansi4, t.ansi1];
    return palette[lane % palette.length];
  }

  static labelColor(t, kind) {
    return { head: t.accent, branch: t.ansi2, remote: t.ansi4, tag: t.ansi5 }[kind];
  }

  static labelIcon(kind) {
    if (kind === "tag") {
      return "check";
    }
    return kind === "remote" ? "external" : "branch";
  }

  static fileMark(status) {
    return status === "A" || status === "D" ? status : "M";
  }

  static laneX(lane) {
    return lane * VxGraph.LANE + VxGraph.LANE / 2;
  }

  static parseFiles(stdout) {
    return stdout.split("\n").filter(Boolean)
      .map((line) => line.split("\t"))
      .filter((parts) => parts.length >= 2)
      .map(([status, ...paths]) => ({ status: status[0], path: paths.at(-1) }));
  }

  init(given, cx) {
    const initProps = props() ?? given ?? {};
    if (initProps.repoMenu) {
      this.repoMenu = initProps.repoMenu;
      loadIcons(this, cx);
      return;
    }
    this.space = initProps.space ?? null;
    this.tops = new Map();
    this.fixed = initProps.root ? { root: initProps.root, on: initProps.on ?? null } : null;
    this.all = localStorage.getItem(VxGraph.KEY_ALL) !== "0";
    loadIcons(this, cx);
    if (checking()) {
      return;
    }
    cx.timer.every(VxGraph.FOLLOW_MS, (cx) => this.follow(cx));
  }

  // A tab opened for one repo (props.root) stays on it; otherwise the graph follows the repo
  // every vx panel shows (switch it from the header), falling back to what it was opened with.
  target() {
    return this.fixed ?? this.auto ?? viewerValue(VxGraph.MOD, this.space);
  }

  followContext(cx) {
    const context = ctx();
    const key = contextKey(context);
    if (key === this.ctxKey) {
      return;
    }
    this.ctxKey = key;
    cx.spawn(async (cx) => {
      const top = context.cwd ? await repoTop(this.tops, context.cwd, context.on) : null;
      if (this.ctxKey !== key || !top) {
        return;
      }
      this.auto = { root: top, on: context.on ?? null };
      this.selected = null;
      this.follow(cx);
    });
  }

  follow(cx) {
    if (!this.fixed) {
      this.followContext(cx);
    }
    const repo = this.target();
    const key = repo ? `${repo.on ?? ""}|${repo.root}|${this.all}` : null;
    if (key && (key !== this.key || changedAt() !== this.seenChange)) {
      this.key = key;
      this.seenChange = changedAt();
      this.load(repo, cx);
    }
  }

  load(repo, cx) {
    if (this.loading) {
      return;
    }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const scope = this.all ? ["--all"] : [];
        const result = await git(["log", ...scope, "--date-order", "-n", String(VxGraph.COUNT), GRAPH_FORMAT], { cwd: repo.root, on: repo.on });
        if (result.code !== 0) {
          throw new Error(result.stderr.trim() || "git log failed");
        }
        const commits = parseGraphLog(result.stdout);
        const { rows, width } = layoutGraph(commits);
        this.repo = repo;
        this.commits = commits;
        this.rows = rows;
        this.width = Math.min(width, VxGraph.MAX_LANES);
        this.error = null;
      } catch (error) {
        this.error = String(error?.message ?? error);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  select(hash, cx) {
    const commit = this.commits.find((candidate) => candidate.hash === hash);
    if (!commit) {
      return;
    }
    this.selected = { commit, files: null, body: null };
    cx.notify();
    const repo = this.repo;
    cx.spawn(async (cx) => {
      const [files, body] = await Promise.all([
        git(["show", "--format=", "--name-status", "--no-renames", "-m", "--first-parent", hash], { cwd: repo.root, on: repo.on }),
        git(["show", "-s", "--format=%B%x00%an <%ae>%x00%ci", hash], { cwd: repo.root, on: repo.on }),
      ]);
      if (this.selected?.commit.hash !== hash) {
        return;
      }
      const [message, author, date] = body.stdout.split("\0");
      this.selected.files = VxGraph.parseFiles(files.stdout);
      this.selected.body = { msg: message.trim(), author, date: (date ?? "").trim() };
      cx.notify();
    });
  }

  // One row's lanes: vertical halves above/below the middle, the joint, and the dot.
  lanes(t, row) {
    const mid = VxGraph.ROW / 2;
    const half = VxGraph.LINE_WIDTH / 2;
    const el = div().relative().w(this.width * VxGraph.LANE).h(VxGraph.ROW).flex_none();
    const segment = (lane, top) => div().absolute().left(VxGraph.laneX(lane) - half).top(top).w(VxGraph.LINE_WIDTH).h(mid).bg(VxGraph.laneColor(t, lane));
    for (const lane of row.top.filter((index) => index < this.width)) {
      el.child(segment(lane, 0));
    }
    for (const lane of row.bottom.filter((index) => index < this.width)) {
      el.child(segment(lane, mid));
    }
    const [from, to] = row.span;
    if (to > from) {
      el.child(div().absolute().left(VxGraph.laneX(from)).top(mid - half).w((Math.min(to, this.width - 1) - from) * VxGraph.LANE).h(VxGraph.LINE_WIDTH).bg(VxGraph.laneColor(t, to)));
    }
    if (row.col < this.width) {
      el.child(this.commitDot(t, row, mid));
    }
    return el;
  }

  commitDot(t, row, mid) {
    const radius = VxGraph.DOT_SIZE / 2;
    const merge = row.forks.length > 0;
    const color = VxGraph.laneColor(t, row.col);
    return div().absolute().left(VxGraph.laneX(row.col) - radius).top(mid - radius).size(VxGraph.DOT_SIZE).rounded(radius)
      .bg(merge ? t.background : color).border_2().border_color(color);
  }

  label(t, ref) {
    const color = VxGraph.labelColor(t, ref.kind);
    return h_flex().flex_none().h(17).px(5).gap(3).items_center().rounded(4).border_1().border_color(color).text_size(TEXT.tiny).text_color(color)
      .child(Icon(VxGraph.labelIcon(ref.kind), 9)).child(div().max_w(150).truncate().child(ref.name));
  }

  row(t, i) {
    const commit = this.commits[i];
    const selected = this.selected?.commit.hash === commit.hash;
    return h_flex().id(commit.hash).h(VxGraph.ROW).w_full().pr(10).gap(8).items_center().bg(selected ? t.selected : VxGraph.TRANSPARENT).text_size(TEXT.small)
      .child(div().pl(6).child(this.lanes(t, this.rows[i])))
      .children(refLabels(commit.refs).slice(0, VxGraph.MAX_ROW_LABELS).map((ref) => this.label(t, ref)))
      .child(div().flex_1().min_w(0).truncate().text_color(commit.parents.length > 1 ? t.muted : t.foreground).child(commit.subject))
      .child(div().flex_none().w(120).truncate().text_size(TEXT.caption).text_color(t.dim).child(commit.author))
      .child(div().flex_none().w(40).text_right().text_size(TEXT.caption).text_color(t.dim).child(timeAgo(commit.at * VxGraph.MS_PER_SECOND)))
      .child(div().flex_none().w(64).font_family(codeFont()).text_size(TEXT.caption).text_color(t.dim).child(commit.hash.slice(0, VxGraph.SHORT_SHA)));
  }

  fileRow(t, commit, file) {
    const color = markColor(VxGraph.fileMark(file.status), t);
    const slash = file.path.lastIndexOf("/");
    const name = file.path.slice(slash + 1);
    const value = { root: this.repo.root, on: this.repo.on ?? null, path: file.path, scope: "commit", sha: commit.hash, subject: commit.subject };
    return h_flex().id(`gf-${file.path}`).h(24).flex_none().px(4).gap(6).items_center().rounded(5).cursor_pointer().hover((style) => style.bg(t.hover)).text_size(TEXT.small)
      .on_click(() => showInViewer("vx-changes", value, name))
      .child(FileIcon(this.icons, file.path, { size: 13 }))
      .child(div().flex_none().max_w(170).truncate().text_color(color).child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(TEXT.caption).text_color(t.dim).child(slash > 0 ? file.path.slice(0, slash) : ""))
      .child(div().w(10).text_size(TEXT.caption).text_color(color).child(file.status));
  }

  detailsHeader(t, commit) {
    return h_flex().h(30).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border)
      .child(Icon("git-commit", 13).text_color(t.accent))
      .child(div().flex_1().font_family(codeFont()).text_size(TEXT.small).child(commit.hash.slice(0, VxGraph.DETAIL_SHA)))
      .child(IconButton({ id: "copy", icon: "copy", label: "Copy hash", size: 20, onClick: (cx) => cx.write_to_clipboard(commit.hash) }))
      .child(IconButton({
        id: "close", icon: "x", label: "Close", size: 20,
        onClick: (cx) => {
          this.selected = null;
          cx.notify();
        },
      }));
  }

  details(t) {
    const selection = this.selected;
    const commit = selection.commit;
    const body = v_flex().id("details-body").flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(8);
    body.child(div().text_size(TEXT.body).whitespace_normal().text_color(t.foreground).child(selection.body?.msg ?? commit.subject));
    if (selection.body) {
      body.child(div().text_size(TEXT.caption).text_color(t.dim).child(`${selection.body.author}\n${selection.body.date}`));
    }
    if (commit.refs.length) {
      body.child(h_flex().flex_wrap().gap(4).children(refLabels(commit.refs).map((ref) => this.label(t, ref))));
    }
    if (commit.parents.length > 1) {
      const parents = commit.parents.map((parent) => parent.slice(0, VxGraph.SHORT_SHA)).join(" + ");
      body.child(div().text_size(TEXT.caption).text_color(t.dim).child(`Merge of ${parents} · files vs first parent`));
    }
    if (!selection.files) {
      body.child(Message("Loading files…"));
    } else {
      const count = selection.files.length;
      body.child(div().text_size(TEXT.caption).font_medium().text_color(t.muted).child(`${count} FILE${count === 1 ? "" : "S"}`));
      body.children(selection.files.map((file) => this.fileRow(t, commit, file)));
    }
    return v_flex().id("details").w(340).flex_none().h_full().border_l(1).border_color(t.border).bg(t.chrome)
      .child(this.detailsHeader(t, commit))
      .child(body);
  }

  commitCountText() {
    if (!this.commits) {
      return "";
    }
    return `${this.commits.length} commits${this.commits.length >= VxGraph.COUNT ? " (latest)" : ""}`;
  }

  toggleAll(cx) {
    this.all = !this.all;
    localStorage.setItem(VxGraph.KEY_ALL, this.all ? "1" : "0");
    cx.notify();
  }

  header(t, repo) {
    return h_flex().h(32).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border).text_size(TEXT.small)
      .child(Icon("pipeline", 14).text_color(t.accent))
      .child(this.fixed ? div().font_medium().child(baseName(repo.root)) : RepoButton(this, VxGraph.MOD, repo?.root ?? null))
      .child(div().flex_1().text_color(t.dim).child(this.commitCountText()))
      .child(h_flex().id("scope").h(22).px(8).items_center().rounded(11).cursor_pointer().text_size(TEXT.caption)
        .text_color(t.accent).hover((style) => style.bg(t.hover)).tooltip("Show every branch, or only the current one")
        .on_click((_event, cx) => this.toggleAll(cx))
        .child(this.all ? "all branches" : "current branch"))
      .child(IconButton({
        id: "refresh", icon: "refresh", label: "Refresh", spinning: Boolean(this.loading), size: 22,
        onClick: (cx) => {
          this.key = null;
          this.follow(cx);
        },
      }));
  }

  commitList(t) {
    const listId = `graph-${this.key}`;
    const renderRange = (range) => {
      const out = [];
      for (let i = range.start; i < range.end; i++) {
        out.push(this.row(t, i));
      }
      return out;
    };
    return div().id("g-list").flex_1().min_w(0).h_full().relative()
      .child(v_virtual_list(listId, this.rows.length, VxGraph.ROW, (i) => this.commits[i].hash, renderRange)
        .on_item_click((hash, cx) => this.select(hash, cx)).size_full())
      .child(Scrollbar.vertical(listId).viewport_from_layout().absolute().inset_0());
  }

  render() {
    if (this.repoMenu) {
      return RepoMenu(this);
    }
    const t = theme();
    const repo = this.target();
    const root = v_flex().id(VxGraph.MOD).size_full().min_w(0).min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground)
      .child(this.header(t, repo));
    if (!repo) {
      return root.child(Message("Open the graph from the Commits section in Changes."));
    }
    if (this.error) {
      return root.child(Message(this.error, true));
    }
    if (!this.rows) {
      return root.child(Message("Loading…"));
    }
    return root.child(h_flex().flex_1().min_h(0).child(this.commitList(t)).when(Boolean(this.selected), (el) => el.child(this.details(t))));
  }
}

export default VxGraph;
