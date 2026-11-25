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
import { logError } from "./log.js";

const MOD = "herdr-vscode-changes";
const GRAPH_MOD = "herdr-vscode-graph";
const SECTIONS_KEY = "sections";
const COMMITS = "commits";
const BRANCHES = "branches";
const REMOTES = "remotes";
const STASHES = "stashes";
const TAGS = "tags";
const COMPARE = "compare";
const STASH_KIND = "stash";
const COMMIT_KIND = "commit";
const INCOMING_KEY = "incoming";
const PAGE = 50;
const INCOMING_LIMIT = 50;
const TAG_LIMIT = 60;
const COMPARE_LOG_LIMIT = 200;
const SEARCH_LIMIT = 100;
const BRANCH_MENU_LIMIT = 12;
const REMOTE_BRANCH_LIMIT = 80;
const SEARCH_RESULTS_SHOWN = 100;
const COMPARE_COMMITS_SHOWN = 50;
const COMPARE_FILES_SHOWN = 300;
const BRANCH_MENU_WIDTH = 290;
const ROW_HEIGHT = 24;
const INDENT = 12;
const LANE_WIDTH = 10;
const LANE_PADDING = 2;
const MAX_LANES = 4;
const DOT_SIZE = 8;
const AVATAR_SIZE = 16;
const AVATAR_TEXT_RATIO = 0.5;
const SHORT_SHA = 8;
const DATE_LENGTH = 16;
const MS_PER_SECOND = 1000;
const FULL_SHA = /^[0-9a-f]{40}$/;
const TRANSPARENT = "#00000000";
const BASE_CANDIDATES = ["origin/staging", "origin/main", "origin/master"];
const REF_RANK = { head: 0, branch: 1, tag: 2, remote: 3 };
const SECTIONS = [
  [COMMITS, "Commits", "git-commit", "ansi4"], [BRANCHES, "Branches", "branch", "ansi2"], [REMOTES, "Remotes", "cloud", "ansi6"],
  [STASHES, "Stashes", "archive", "ansi5"], [TAGS, "Tags", "tag", "ansi3"], [COMPARE, "Search & Compare", "compare", "accent"],
];
const MODES = [["message", "Message"], ["author", "Author"], ["file", "File"], ["sha", "Commit"]];
const BRANCH_FORMAT = "--format=%(refname:short)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:unix)%00%(HEAD)%00%(subject)";
const REF_FORMAT = "%(refname:short)%00%(committerdate:unix)%00%(subject)";
const TAG_FORMAT = "--format=%(refname:short)%00%(creatordate:unix)%00%(subject)";

const msFromSeconds = (seconds) => seconds * MS_PER_SECOND;

const nulRecords = (out) => out.split("\n").filter(Boolean).map((line) => line.split("\0"));

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

// `git show --name-status` / `git diff --name-status` lines -> [{ status, path }].
const nameStatus = (out) => String(out ?? "").split("\n").filter(Boolean)
  .map((line) => line.split("\t")).filter((parts) => parts.length >= 2).map(([status, ...rest]) => ({ status: status[0], path: rest.at(-1) }));

function commitTree(files) {
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

const withoutRemote = (name) => name.slice(name.indexOf("/") + 1);

// HEAD's branch first, then local branches, tags, remotes. A remote branch named like a local
// one at the same commit folds into it (marked `synced`).
function tidyRefs(labels) {
  const locals = new Set(labels.filter((ref) => ref.kind === "head" || ref.kind === "branch").map((ref) => ref.name));
  const out = [];
  for (const ref of labels) {
    if (ref.name === "HEAD") {
      continue;
    }
    const localName = withoutRemote(ref.name);
    if (ref.kind !== "remote" || !locals.has(localName)) {
      out.push(ref);
      continue;
    }
    const local = out.find((candidate) => candidate.name === localName) ?? labels.find((candidate) => candidate.name === localName);
    local.synced = true;
  }
  return out.sort((a, b) => REF_RANK[a.kind] - REF_RANK[b.kind]);
}

// Resolves an SSH alias (Host work-github in ~/.ssh/config) to the host it connects to.
async function realHost(alias) {
  const result = await exec("ssh", ["-G", alias]).catch(() => null);
  return /^hostname\s+(\S+)/m.exec(result?.stdout ?? "")?.[1] ?? null;
}

function trackCount(track, word) {
  return Number(new RegExp(`${word} (\\d+)`).exec(track)?.[1] ?? 0);
}

async function loadBranches(runGit) {
  const result = await runGit(["for-each-ref", "refs/heads", "--sort=-committerdate", BRANCH_FORMAT]);
  return nulRecords(result.stdout).map(([name, upstream, track, at, head, subject]) => ({
    name, upstream, at: Number(at), current: head === "*", subject, gone: track === "gone",
    ahead: trackCount(track, "ahead"), behind: trackCount(track, "behind"),
  }));
}

async function loadRemotes(runGit) {
  const result = await runGit(["for-each-ref", "refs/remotes", "--sort=-committerdate", `--format=${REF_FORMAT}`]);
  return nulRecords(result.stdout).map(([name, at, subject]) => ({ name, at: Number(at), subject }))
    .filter((branch) => !branch.name.endsWith("/HEAD") && branch.name.includes("/"));
}

async function loadStashes(runGit) {
  const result = await runGit(["stash", "list", "--format=%gd%x00%s%x00%ct"]);
  return nulRecords(result.stdout).map(([ref, subject, at]) => ({ ref, subject, at: Number(at) }));
}

async function loadTags(runGit) {
  const result = await runGit(["for-each-ref", "refs/tags", "--sort=-creatordate", `--count=${TAG_LIMIT}`, TAG_FORMAT]);
  return nulRecords(result.stdout).map(([name, at, subject]) => ({ name, at: Number(at), subject }));
}

function branchSub(branch) {
  if (branch.gone) {
    return "upstream gone";
  }
  const bits = [branch.behind ? `↓${branch.behind}` : "", branch.ahead ? `↑${branch.ahead}` : ""].filter(Boolean).join(" ");
  return `${bits}${bits ? " " : ""}${branch.upstream ? `→ ${branch.upstream}` : "local only"}`;
}

function sectionCount(id, data) {
  if (id === COMMITS) {
    return data?.commits?.length;
  }
  if (Array.isArray(data)) {
    return data.length;
  }
  return id === COMPARE && data?.commits ? data.commits.length : null;
}

function refIcon(kind) {
  if (kind === "tag") {
    return "tag";
  }
  return kind === "remote" ? "cloud" : "branch";
}

function groupByRemote(branches) {
  const byRemote = new Map();
  for (const branch of branches) {
    const remote = branch.name.split("/")[0];
    if (!byRemote.has(remote)) {
      byRemote.set(remote, []);
    }
    byRemote.get(remote).push(branch);
  }
  return byRemote;
}

export const sectionMethods = {
  initSections() {
    try {
      this.open = new Set(JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? `["${COMMITS}"]`));
    } catch {
      this.open = new Set([COMMITS]);
    }
    this.data = {};
    this.expanded = new Map();
    this.commitCount = PAGE;
    this.searchMode = "message";
    this.search.on("change", (_e, cx) => cx.notify());
    this.search.on("submit", (_e, cx) => this.runSearch(cx));
  },

  // Branches always reload: the branch switcher reads them.
  refreshSections(cx) {
    if (!this.root) {
      return;
    }
    if (this.remoteFor !== this.root) {
      this.loadRemote(cx);
    }
    const ids = new Set([...this.open, BRANCHES]);
    // Source Control's Graph section shows the commits too.
    if (this.part !== "history" && !this.closed?.has("graph")) {
      ids.add(COMMITS);
    }
    for (const id of ids) {
      this.loadSection(id, cx);
    }
  },

  // origin as { host, path } with SSH aliases resolved, for "Open on GitHub / GitLab".
  loadRemote(cx) {
    const root = this.root;
    this.remoteFor = root;
    this.remote = null;
    cx.spawn(async () => {
      const result = await git(["remote", "get-url", "origin"], { cwd: root, on: this.on }).catch(() => null);
      const remote = result?.code === 0 ? parseRemote(result.stdout.trim()) : null;
      if (remote && !providerOf(remote.host) && !this.on) {
        remote.host = (await realHost(remote.host)) ?? remote.host;
      }
      if (this.root === root) {
        this.remote = remote;
      }
    });
  },

  saveOpenSections() {
    localStorage.setItem(SECTIONS_KEY, JSON.stringify([...this.open]));
  },

  toggleSection(id, cx) {
    if (!this.open.delete(id)) {
      this.open.add(id);
      this.loadSection(id, cx);
    }
    this.saveOpenSections();
    cx.notify();
  },

  async loadCommits(runGit) {
    const upstream = this.upstream;
    const [log, outgoing, incoming] = await Promise.all([
      runGit(["log", "-n", String(this.commitCount), GRAPH_FORMAT]),
      upstream ? runGit(["rev-list", "@{upstream}..HEAD"]) : null,
      upstream && this.behind ? runGit(["log", "-n", String(INCOMING_LIMIT), GRAPH_FORMAT, "HEAD..@{upstream}"]) : null,
    ]);
    const commits = log.code === 0 ? parseGraphLog(log.stdout) : [];
    const graph = layoutGraph(commits);
    return {
      commits,
      rows: graph.rows,
      width: Math.max(1, Math.min(MAX_LANES, graph.width)),
      outgoing: new Set(outgoing?.code === 0 ? outgoing.stdout.split("\n").filter(Boolean) : []),
      incoming: incoming?.code === 0 ? parseGraphLog(incoming.stdout) : [],
      more: commits.length >= this.commitCount,
    };
  },

  sectionLoader(id) {
    const loaders = {
      [COMMITS]: (runGit) => this.loadCommits(runGit),
      [BRANCHES]: loadBranches,
      [REMOTES]: loadRemotes,
      [STASHES]: loadStashes,
      [TAGS]: loadTags,
      [COMPARE]: (runGit) => this.loadCompare(runGit),
    };
    return loaders[id] ?? null;
  },

  loadSection(id, cx) {
    const root = this.root;
    const on = this.on;
    if (!root) {
      return;
    }
    const runGit = (args) => git(args, { cwd: root, on });
    const loader = this.sectionLoader(id);
    cx.spawn(async (cx) => {
      let value = null;
      try {
        value = loader ? await loader(runGit) : null;
      } catch (error) {
        logError("herdr-vscode-changes", "section load failed", String(error?.message ?? error));
        value = { error: String(error?.message ?? error) };
      }
      if (this.root !== root) {
        return;
      }
      this.data[id] = value;
      cx.notify();
    });
  },

  // The upstream's remote default branch (origin/HEAD), else origin/staging or origin/main.
  // On that branch itself, the base is its upstream.
  async findCompareBase(runGit) {
    const head = await runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    let base = head.code === 0 ? head.stdout.trim() : null;
    for (const candidate of BASE_CANDIDATES) {
      if (base) {
        break;
      }
      if ((await runGit(["rev-parse", "--verify", "-q", candidate])).code === 0) {
        base = candidate;
      }
    }
    if (base && base.replace(/^origin\//, "") === this.branch && this.upstream) {
      return this.upstream;
    }
    return base;
  },

  async loadCompare(runGit) {
    const base = this.compareBase || (await this.findCompareBase(runGit));
    if (!base) {
      return { error: "No base branch to compare with (no origin/HEAD)." };
    }
    const [log, files] = await Promise.all([
      runGit(["log", "-n", String(COMPARE_LOG_LIMIT), LOG_FORMAT, `${base}..HEAD`]),
      runGit(["diff", "--name-status", "--no-renames", `${base}...HEAD`]),
    ]);
    const behind = await runGit(["rev-list", "--count", `HEAD..${base}`]);
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
    this.open.add(COMPARE);
    this.saveOpenSections();
    this.loadSection(COMPARE, cx);
  },

  runSearch(cx) {
    const query = this.search.value().trim();
    if (!query || !this.root) {
      return;
    }
    const args = { message: ["--grep", query, "-i"], author: ["--author", query, "-i"], file: ["--", `:(glob,icase)**/*${query}*`], sha: [query, "-n", "1"] }[this.searchMode];
    const root = this.root;
    this.searching = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const result = await git(["log", "-n", String(SEARCH_LIMIT), "--all", LOG_FORMAT, ...args], { cwd: root, on: this.on }).catch(() => null);
      this.searching = false;
      if (this.root !== root) {
        return;
      }
      const ok = result?.code === 0;
      this.results = { q: query, mode: this.searchMode, commits: ok ? parseLog(result.stdout) : [], error: ok ? null : (result?.stderr ?? "").trim() };
      cx.notify();
    });
  },

  // A commit's (or stash's) changed files, loaded when expanded.
  toggleExpand(kind, id, cx) {
    const key = `${kind}:${id}`;
    if (this.expanded.has(key)) {
      this.expanded.delete(key);
      cx.notify();
      return;
    }
    this.expanded.set(key, null);
    cx.notify();
    const root = this.root;
    cx.spawn(async (cx) => {
      const args = kind === STASH_KIND ? ["stash", "show", "--name-status", "--no-renames", id] : ["show", "--format=", "--name-status", "--no-renames", "-m", "--first-parent", id];
      const result = await git(args, { cwd: root, on: this.on }).catch(() => null);
      if (this.root !== root || !this.expanded.has(key)) {
        return;
      }
      this.expanded.set(key, result?.code === 0 ? nameStatus(result.stdout) : []);
      cx.notify();
    });
  },

  confirmGit(spec, args) {
    askConfirm(MOD, { ...spec, action: { cmd: "git", args, cwd: this.root, on: this.on ?? null, doing: spec.doing, done: spec.done, root: this.root } });
  },

  switchBranch(name) {
    this.confirmGit({ title: `Switch to ${name}?`, detail: "Uncommitted changes come along if they don't clash; otherwise git refuses and nothing changes.", label: "Switch", doing: "Switching", done: `On ${name}` }, ["switch", name]);
  },

  checkoutRemote(name) {
    const local = withoutRemote(name);
    this.confirmGit({ title: `Check out ${local}?`, detail: `Makes a local ${local} that tracks ${name} and switches to it.`, label: "Check Out", doing: "Checking out", done: `On ${local}` }, ["switch", "--track", name]);
  },

  deleteBranch(branch) {
    this.confirmGit({ title: `Delete branch ${branch.name}?`, detail: "Only if it's merged: git refuses to delete unmerged work. The remote branch stays.", label: "Delete", danger: true, doing: "Deleting", done: `Deleted ${branch.name}` }, ["branch", "-d", branch.name]);
  },

  stashAction(stash, kind) {
    const spec = {
      apply: { title: `Apply ${stash.ref}?`, detail: `${stash.subject}. The stash stays in the list; conflicts are left in the files for you to resolve.`, label: "Apply", doing: "Applying", done: `Applied ${stash.ref}` },
      pop: { title: `Pop ${stash.ref}?`, detail: `${stash.subject}. Applies it and removes it from the list (kept if it conflicts).`, label: "Pop", doing: "Popping", done: `Popped ${stash.ref}` },
      drop: { title: `Drop ${stash.ref}?`, detail: `${stash.subject}. Deletes the stash without applying it.`, label: "Drop", danger: true, doing: "Dropping", done: `Dropped ${stash.ref}` },
    }[kind];
    this.confirmGit(spec, ["stash", kind, stash.ref]);
  },

  openGraph() {
    showInViewer(GRAPH_MOD, { root: this.root, on: this.on ?? null }, `Graph · ${baseName(this.root)}`);
  },

  runSectionCmd(command, cx) {
    switch (command.cmd) {
      case "graph": return this.openGraph();
      case "compareWith": return this.setCompareBase(command.ref, cx);
      case "switchBranch": return this.switchBranch(command.name);
      case "stash": return this.stashAction({ ref: command.ref, subject: command.subject }, command.kind);
      case "expand": return this.toggleExpand(command.kind, command.ref, cx);
      default: return undefined;
    }
  },

  stashMenu(colors, stash) {
    const stashCmd = (kind) => ({ cmd: "stash", kind, ref: stash.ref, subject: stash.subject });
    openScmMenu(this.uid, [
      { id: "apply", icon: "download", color: colors.ansi2, label: "Apply Stash…", cmd: stashCmd("apply") },
      { id: "pop", icon: "arrow-up", color: colors.ansi4, label: "Pop Stash…", cmd: stashCmd("pop") },
      { id: "drop", icon: "trash", color: colors.ansi1, label: "Drop Stash…", cmd: stashCmd("drop") },
      { sep: true, id: "s1" },
      { id: "copy", icon: "copy", label: "Copy Message", copy: stash.subject },
    ]);
  },

  commitActions(commit, kind) {
    const colors = theme();
    if (kind === STASH_KIND) {
      this.stashMenu(colors, commit);
      return;
    }
    const sha = commit.hash;
    const url = commitUrl(this.remote, sha);
    const where = /github/i.test(this.remote?.host ?? "") ? "GitHub" : "GitLab";
    openScmMenu(this.uid, [
      { id: "files", icon: "files", label: this.expanded.has(`${COMMIT_KIND}:${sha}`) ? "Hide Files" : "Show Files", cmd: { cmd: "expand", kind: COMMIT_KIND, ref: sha } },
      { id: "cmp", icon: "compare", color: colors.accent, label: "Compare HEAD with This", cmd: { cmd: "compareWith", ref: sha } },
      { id: "graph", icon: "pipeline", label: "Open Commit Graph", cmd: { cmd: "graph" } },
      ...(url ? [{ id: "web", icon: "globe", color: colors.ansi4, label: `Open on ${where}`, url }] : []),
      { sep: true, id: "s1" },
      { id: "sha", icon: "copy", label: "Copy SHA", sub: sha.slice(0, SHORT_SHA), copy: sha },
      { id: "msg", icon: "copy", label: "Copy Message", copy: commit.subject },
      ...(url ? [{ id: "link", icon: "copy", label: "Copy Link", copy: url }] : []),
    ]);
  },

  // The branch chip's menu: new branch, then the most recent branches to switch to.
  branchMenu() {
    const colors = theme();
    const list = Array.isArray(this.data.branches) ? this.data.branches : [];
    const items = [{ id: "new", icon: "branch-plus", color: colors.ansi2, label: "New Branch…", cmd: { cmd: "branchAsk" } }];
    if (list.length > 1) {
      items.push({ header: "Switch to", id: "h1" });
    }
    for (const branch of list.filter((candidate) => !candidate.current).slice(0, BRANCH_MENU_LIMIT)) {
      items.push({ id: `b-${branch.name}`, icon: "branch", color: colors.ansi2, label: branch.name, sub: timeAgo(msFromSeconds(branch.at)), cmd: { cmd: "switchBranch", name: branch.name } });
    }
    items.push({ sep: true, id: "s1" }, { id: "graph", icon: "pipeline", color: colors.accent, label: "Open Commit Graph", cmd: { cmd: "graph" } });
    openScmMenu(this.uid, items, BRANCH_MENU_WIDTH);
  },

  laneColor(colors, index) {
    const palette = [colors.accent, colors.ansi2, colors.ansi5, colors.ansi3, colors.ansi6, colors.ansi4, colors.ansi1];
    return palette[index % palette.length];
  },

  // One commit's slice of the graph: lines above and below the dot, the joint, and the dot
  // (hollow for merges and for commits not pushed yet).
  lanes(colors, row, width, outgoing) {
    const el = div().relative().w(width * LANE_WIDTH + LANE_PADDING * 2).h(ROW_HEIGHT).flex_none();
    const mid = ROW_HEIGHT / 2;
    const laneX = (lane) => lane * LANE_WIDTH + LANE_WIDTH / 2 + LANE_PADDING;
    const segment = (lane, top) => div().absolute().left(laneX(lane) - 1).top(top).w(2).h(mid).bg(this.laneColor(colors, lane));
    for (const lane of row.top.filter((lane) => lane < width)) {
      el.child(segment(lane, 0));
    }
    for (const lane of row.bottom.filter((lane) => lane < width)) {
      el.child(segment(lane, mid));
    }
    const [spanStart, spanEnd] = row.span;
    if (spanEnd > spanStart && spanStart < width) {
      const end = Math.min(spanEnd, width - 1);
      el.child(div().absolute().left(laneX(spanStart)).top(mid - 1).w((end - spanStart) * LANE_WIDTH).h(2).bg(this.laneColor(colors, end)));
    }
    const column = Math.min(row.col, width - 1);
    const color = this.laneColor(colors, column);
    const hollow = row.forks.length || outgoing;
    el.child(div().absolute().left(laneX(column) - DOT_SIZE / 2).top(mid - DOT_SIZE / 2).size(DOT_SIZE).rounded(DOT_SIZE / 2)
      .bg(hollow ? colors.background : color).border_2().border_color(outgoing ? colors.ansi6 : color));
    return el;
  },

  avatar(colors, name, size = AVATAR_SIZE) {
    const color = colors[colorSlot(name)] ?? colors.accent;
    return div().size(size).flex_none().rounded(size / 2).flex().items_center().justify_center().bg(tint(color, "33"))
      .text_size(Math.round(size * AVATAR_TEXT_RATIO)).font_semibold().text_color(color).child(initials(name));
  },

  refPill(colors, ref) {
    const color = { head: colors.accent, branch: colors.ansi2, remote: colors.ansi4, tag: colors.ansi5 }[ref.kind];
    return h_flex().flex_shrink(1).min_w(56).h(16).max_w(120).px(5).gap(3).items_center().rounded(8).overflow_hidden().bg(tint(color, "26")).text_size(TEXT.tiny).text_color(color)
      .child(Icon(refIcon(ref.kind), 9)).child(div().min_w(0).truncate().child(ref.name))
      .when(Boolean(ref.synced), (el) => el.child(Icon("cloud", 9)));
  },

  fileLine(colors, file, depth, open, tree = false) {
    const letter = file.status === "A" || file.status === "D" ? file.status : "M";
    const color = markColor(letter, colors);
    const slash = file.path.lastIndexOf("/");
    const name = file.path.slice(slash + 1);
    return h_flex().id(`sf-${depth}-${open.scope}-${open.sha ?? open.ref ?? open.base}-${file.path}`).h(ROW_HEIGHT).flex_none().mx(4).pl(10 + depth * INDENT).pr(6).gap(6).items_center().rounded(5)
      .cursor_pointer().hover((style) => style.bg(colors.hover)).text_size(TEXT.small).tooltip(file.path)
      .on_click(() => showInViewer(MOD, { root: this.root, on: this.on ?? null, path: file.path, ...open }, name))
      .child(FileIcon(this.icons, file.path, { size: 14 }))
      .child(div().flex_shrink(1).min_w(40).max_w(190).truncate().text_color(color).when(letter === "D", (el) => el.line_through()).child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(TEXT.caption).text_color(colors.dim).child(slash > 0 && !tree ? file.path.slice(0, slash) : ""))
      .child(div().w(16).h(16).flex_none().flex().items_center().justify_center().rounded(4).bg(tint(color, "22")).text_size(TEXT.tiny).font_semibold().text_color(color).child(file.status));
  },

  commitTooltip(commit, kind, outgoing) {
    if (kind === STASH_KIND) {
      return `${commit.ref} · ${commit.subject}\nClick: files · right-click: apply, pop, drop`;
    }
    const date = new Date(msFromSeconds(commit.at)).toISOString().slice(0, DATE_LENGTH).replace("T", " ");
    return `${commit.hash.slice(0, SHORT_SHA)} · ${commit.author} · ${date}${outgoing ? " · not pushed yet" : ""}\n${commit.subject}\nClick: files · right-click: more`;
  },

  commitRowEnd(colors, commit, kind, id, depth, outgoing) {
    const hot = this.hot === `${kind}:${id}`;
    if (hot && kind === STASH_KIND) {
      return [
        IconButton({ id: `sa-${id}`, icon: "download", label: "Apply…", size: 20, onClick: () => this.stashAction(commit, "apply") }),
        IconButton({ id: `sp-${id}`, icon: "arrow-up", label: "Pop…", size: 20, onClick: () => this.stashAction(commit, "pop") }),
        IconButton({ id: `sd-${id}`, icon: "trash", label: "Drop…", size: 20, onClick: () => this.stashAction(commit, "drop") }),
      ];
    }
    if (hot) {
      return [
        IconButton({ id: `cp-${id}-${depth}`, icon: "copy", label: `Copy SHA ${commit.hash.slice(0, SHORT_SHA)}`, size: 20, onClick: (cx) => cx.write_to_clipboard(commit.hash) }),
        IconButton({ id: `cc-${id}-${depth}`, icon: "compare", label: "Compare HEAD with this", size: 20, onClick: (cx) => this.setCompareBase(commit.hash, cx) }),
      ];
    }
    const age = div().flex_none().text_size(TEXT.caption).text_color(colors.dim).child(timeAgo(msFromSeconds(commit.at)));
    return outgoing ? [div().flex_none().text_size(TEXT.caption).text_color(colors.ansi6).child("↑"), age] : [age];
  },

  commitBackground(colors, hot, open) {
    if (hot) {
      return colors.hover;
    }
    return open ? tint(colors.accent, "14") : TRANSPARENT;
  },

  expandedLines(colors, commit, kind, depth, graph, files) {
    const pad = graph ? graph.width * LANE_WIDTH + 30 : 40 + depth * INDENT;
    const note = (text) => div().pl(pad).h(22).text_size(TEXT.caption).text_color(colors.dim).child(text);
    if (!files) {
      return [note("Loading…")];
    }
    if (!files.length) {
      return [note("No file changes.")];
    }
    const open = kind === STASH_KIND ? { scope: STASH_KIND, ref: commit.ref, subject: commit.subject } : { scope: COMMIT_KIND, sha: commit.hash, subject: commit.subject };
    if (this.view !== "tree") {
      return files.map((file) => this.fileLine(colors, file, depth + 2, open));
    }
    const out = [];
    this.walkCommitTree(colors, commitTree(files), depth + 2, "", `${open.sha ?? open.ref}`, open, out);
    return out;
  },

  walkCommitTree(colors, node, depth, prefix, scopeId, open, out) {
    for (const [name, child] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      let label = name;
      let current = child;
      while (current.files.length === 0 && current.dirs.size === 1) {
        const [[childName, next]] = [...current.dirs];
        label += `/${childName}`;
        current = next;
      }
      const id = `cdir:${scopeId}:${prefix}${label}`;
      const isOpen = !this.closed.has(id);
      out.push(h_flex().id(id).h(ROW_HEIGHT).flex_none().mx(4).pl(10 + depth * INDENT).pr(6).gap(6).items_center().rounded(5)
        .cursor_pointer().hover((style) => style.bg(colors.hover)).text_size(TEXT.small).text_color(colors.foreground)
        .on_click((_e, cx) => this.toggleGroup(id, cx))
        .child(Icon(isOpen ? "chevron-down" : "chevron-right", 14).text_color(colors.dim))
        .child(FileIcon(this.icons, label.split("/").pop(), { dir: true, open: isOpen, size: 14 }))
        .child(div().flex_1().min_w(0).truncate().child(label)));
      if (isOpen) {
        this.walkCommitTree(colors, current, depth + 1, `${prefix}${label}/`, scopeId, open, out);
      }
    }
    for (const file of [...node.files].sort((a, b) => a.path.localeCompare(b.path))) {
      out.push(this.fileLine(colors, file, depth, open, true));
    }
  },

  // A commit or stash row; `graph` = { row, width, outgoing } in the Commits section.
  commitLine(colors, commit, depth = 0, kind = COMMIT_KIND, graph = null) {
    const id = kind === STASH_KIND ? commit.ref : commit.hash;
    const key = `${kind}:${id}`;
    const open = this.expanded.has(key);
    const outgoing = graph?.outgoing;
    const refs = commit.refs ? tidyRefs(refLabels(commit.refs)) : [];
    const row = h_flex().id(`cm-${key}-${depth}`).h(ROW_HEIGHT).flex_none().mx(4).pl(graph ? 2 : 8 + depth * INDENT).pr(4).gap(6).items_center().rounded(5)
      .cursor_pointer().bg(this.commitBackground(colors, this.hot === key, open)).text_size(TEXT.small)
      .tooltip(this.commitTooltip(commit, kind, outgoing))
      .on_click((_e, cx) => this.toggleExpand(kind, id, cx))
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        this.commitActions(commit, kind);
      })
      .when(Boolean(graph), (el) => el.child(this.lanes(colors, graph.row, graph.width, outgoing)))
      .when(!graph, (el) => el.child(Icon(open ? "chevron-down" : "chevron-right", 11).text_color(colors.dim)))
      .when(kind === STASH_KIND, (el) => el.child(Icon("archive", 13).text_color(colors.ansi5)))
      .when(kind !== STASH_KIND, (el) => el.child(this.avatar(colors, commit.author)))
      .when(refs.length > 0, (el) => el.child(this.refPill(colors, refs[0])))
      .when(refs.length > 1, (el) => el.child(this.pill(`+${refs.length - 1}`, colors.dim)))
      .child(div().flex_1().min_w(refs.length ? 90 : 0).truncate().text_color(commit.parents?.length > 1 ? colors.muted : colors.foreground).child(commit.subject))
      .children(this.commitRowEnd(colors, commit, kind, id, depth, outgoing));
    const lines = [this.hoverable(row, key)];
    if (open) {
      lines.push(...this.expandedLines(colors, commit, kind, depth, graph, this.expanded.get(key)));
    }
    return lines;
  },

  sectionHead(colors, id, label, icon, color, count, actions = []) {
    const open = this.open.has(id);
    return h_flex().id(`sec-${id}`).h(28).flex_none().mt(4).mx(4).pl(6).pr(4).gap(6).items_center().rounded(5).cursor_pointer()
      .hover((style) => style.bg(colors.hover)).on_click((_e, cx) => this.toggleSection(id, cx))
      .child(Icon(open ? "chevron-down" : "chevron-right", 11).text_color(colors.dim))
      .child(div().size(20).flex_none().rounded(5).flex().items_center().justify_center().bg(tint(color, "22")).child(Icon(icon, 12).text_color(color)))
      .child(div().text_size(TEXT.caption).font_semibold().text_color(colors.foreground).child(label))
      .when(count !== undefined && count !== null, (el) => el.child(this.pill(count, color)))
      .child(div().flex_1())
      .children(actions);
  },

  refRow(colors, id, { icon, iconColor, name, nameColor, sub, at, right = [], onClick, tip }) {
    const hot = this.hot === id;
    return this.hoverable(h_flex().id(id).h(ROW_HEIGHT).flex_none().mx(4).pl(24).pr(4).gap(6).items_center().rounded(5).text_size(TEXT.small)
      .bg(hot ? colors.hover : TRANSPARENT)
      .when(Boolean(onClick), (el) => el.cursor_pointer().on_click((_e, cx) => onClick(cx)))
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .child(Icon(icon, 13).text_color(iconColor ?? colors.dim))
      .child(div().flex_shrink(1).min_w(40).max_w(170).truncate().text_color(nameColor ?? colors.foreground).child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(TEXT.caption).text_color(colors.dim).child(sub ?? ""))
      .when(hot, (el) => el.children(right))
      .when(!hot && Boolean(at), (el) => el.child(div().flex_none().text_size(TEXT.caption).text_color(colors.dim).child(timeAgo(msFromSeconds(at))))), id);
  },

  compareButton(id, name) {
    return IconButton({ id, icon: "compare", label: `Compare HEAD with ${name}`, size: 20, onClick: (cx) => this.setCompareBase(name, cx) });
  },

  sectionActions(id) {
    if (id === COMMITS) {
      return [IconButton({ id: "graph", icon: "pipeline", label: "Open Commit Graph", size: 20, onClick: () => this.openGraph() })];
    }
    if (id === BRANCHES) {
      return [IconButton({ id: "br-new", icon: "plus", label: "New Branch…", size: 20, onClick: (cx) => this.runCmd({ cmd: "branchAsk" }, cx) })];
    }
    if (id === STASHES) {
      return [IconButton({ id: "st-new", icon: "plus", label: "Stash Changes…", size: 20, disabled: !this.files.length, onClick: (cx) => this.runCmd({ cmd: "stashAsk" }, cx) })];
    }
    return [];
  },

  renderBranches(colors, branches) {
    return branches.map((branch) => this.refRow(colors, `br-${branch.name}`, {
      icon: branch.current ? "check" : "branch",
      iconColor: branch.current ? colors.accent : colors.ansi2,
      name: branch.name,
      nameColor: branch.current ? colors.accent : null,
      at: branch.at,
      sub: branchSub(branch),
      tip: `${branch.name}${branch.current ? " (current)" : " · click to switch"}\n${branch.subject}`,
      onClick: branch.current ? null : () => this.switchBranch(branch.name),
      right: [
        this.compareButton(`cmp-${branch.name}`, branch.name),
        ...(branch.current ? [] : [IconButton({ id: `del-${branch.name}`, icon: "trash", label: "Delete branch…", size: 20, onClick: () => this.deleteBranch(branch) })]),
      ],
    }));
  },

  renderRemotes(colors, branches) {
    const out = [];
    for (const [remote, list] of groupByRemote(branches)) {
      out.push(h_flex().h(22).mx(4).pl(24).items_center().gap(6).text_size(TEXT.caption).text_color(colors.muted)
        .child(Icon("cloud", 12).text_color(colors.ansi6)).child(div().font_medium().child(remote)).child(this.pill(list.length, colors.ansi6)));
      for (const branch of list.slice(0, REMOTE_BRANCH_LIMIT)) {
        out.push(this.refRow(colors, `rm-${branch.name}`, {
          icon: "branch", iconColor: colors.ansi4, name: branch.name.slice(remote.length + 1), sub: branch.subject, at: branch.at,
          right: [
            this.compareButton(`rcmp-${branch.name}`, branch.name),
            IconButton({ id: `rco-${branch.name}`, icon: "download", label: "Check out as a local branch…", size: 20, onClick: () => this.checkoutRemote(branch.name) }),
          ],
        }));
      }
    }
    return out;
  },

  renderStashes(colors, stashes) {
    const out = stashes.length ? [] : [Message("No stashes. ⋯ › Stash Changes puts your work aside.")];
    for (const stash of stashes) {
      out.push(...this.commitLine(colors, stash, 0, STASH_KIND));
    }
    return out;
  },

  renderTags(colors, tags) {
    const out = tags.length ? [] : [Message("No tags.")];
    for (const tag of tags) {
      out.push(this.refRow(colors, `tag-${tag.name}`, { icon: "tag", iconColor: colors.ansi3, name: tag.name, sub: tag.subject, at: tag.at,
        right: [this.compareButton(`tcmp-${tag.name}`, tag.name)] }));
    }
    return out;
  },

  sectionBody(colors, id, data) {
    if (data === undefined) {
      return [Message("Loading…")];
    }
    if (data?.error && id !== COMPARE) {
      return [Message(data.error, true)];
    }
    const renderers = {
      [COMMITS]: () => this.renderCommits(colors, data),
      [BRANCHES]: () => this.renderBranches(colors, data),
      [REMOTES]: () => this.renderRemotes(colors, data),
      [STASHES]: () => this.renderStashes(colors, data),
      [TAGS]: () => this.renderTags(colors, data),
      [COMPARE]: () => this.renderCompare(colors, data),
    };
    return renderers[id]?.() ?? [];
  },

  renderSections(colors) {
    const out = [];
    for (const [id, label, icon, colorKey] of SECTIONS) {
      const color = colors[colorKey] ?? colors.accent;
      const data = this.data[id];
      out.push(this.sectionHead(colors, id, label, icon, color, sectionCount(id, data), this.sectionActions(id)));
      if (this.open.has(id)) {
        out.push(...this.sectionBody(colors, id, data));
      }
    }
    return out;
  },

  loadMoreCommits(cx) {
    this.commitCount += PAGE;
    this.loadSection(COMMITS, cx);
  },

  incomingRows(colors, incoming) {
    const open = !this.closed.has(INCOMING_KEY);
    const head = h_flex().id("inc").h(ROW_HEIGHT).flex_none().mx(4).pl(8).pr(6).gap(6).items_center().rounded(5).cursor_pointer()
      .bg(tint(colors.ansi4, "14")).hover((style) => style.bg(tint(colors.ansi4, "26"))).text_size(TEXT.small).on_click((_e, cx) => this.toggleGroup(INCOMING_KEY, cx))
      .child(Icon(open ? "chevron-down" : "chevron-right", 11).text_color(colors.dim))
      .child(Icon("arrow-down", 12).text_color(colors.ansi4))
      .child(div().flex_1().min_w(0).truncate().text_color(colors.ansi4).font_medium().child(`Incoming from ${this.upstream}`))
      .child(this.pill(incoming.length, colors.ansi4));
    const out = [head];
    if (open) {
      for (const commit of incoming) {
        out.push(...this.commitLine(colors, commit, 1));
      }
    }
    return out;
  },

  renderCommits(colors, data) {
    const out = data.incoming.length ? this.incomingRows(colors, data.incoming) : [];
    data.commits.forEach((commit, index) => {
      out.push(...this.commitLine(colors, commit, 0, COMMIT_KIND, { row: data.rows[index], width: data.width, outgoing: data.outgoing.has(commit.hash) }));
    });
    if (data.more) {
      out.push(h_flex().id("more").h(ROW_HEIGHT).mx(4).pl(24).items_center().gap(6).rounded(5).text_size(TEXT.caption).text_color(colors.accent).cursor_pointer().hover((style) => style.bg(colors.hover))
        .on_click((_e, cx) => this.loadMoreCommits(cx)).child(Icon("chevron-down", 11)).child("Load more"));
    }
    return out;
  },

  setSearchMode(mode, cx) {
    this.searchMode = mode;
    cx.notify();
  },

  searchBox(colors) {
    return v_flex().flex_none().px(10).py(6).gap(6)
      .child(h_flex().gap(4).children(MODES.map(([id, label]) =>
        h_flex().id(`sm-${id}`).h(22).px(8).items_center().rounded(11).text_size(TEXT.caption).cursor_pointer()
          .bg(this.searchMode === id ? tint(colors.accent, "33") : colors.raised).text_color(this.searchMode === id ? colors.foreground : colors.dim)
          .hover((style) => style.text_color(colors.foreground))
          .on_click((_e, cx) => this.setSearchMode(id, cx)).child(label))))
      .child(h_flex().h(28).px(8).gap(6).items_center().rounded(7).border_1().border_color(colors.border).bg(colors.input ?? colors.background)
        .child(Icon("search", 12).text_color(colors.dim))
        .child(Input.new(this.search).flex_1().h(26).text_size(TEXT.small))
        .child(IconButton({ id: "search-go", icon: this.searching ? "spinner" : "chevron-right", spinning: this.searching, label: "Search (Enter)", size: 20, onClick: (cx) => this.runSearch(cx) })));
  },

  searchResults(colors) {
    const { commits, mode, q: query, error } = this.results;
    const out = [h_flex().h(22).px(12).items_center().text_size(TEXT.caption).text_color(colors.muted)
      .child(`${plural(commits.length, "commit")} for ${mode} “${query}”`)];
    if (error) {
      out.push(Message(error, true));
    }
    for (const commit of commits.slice(0, SEARCH_RESULTS_SHOWN)) {
      out.push(...this.commitLine(colors, commit, 1));
    }
    return out;
  },

  // What this branch has that its base doesn't.
  compareRows(colors, data) {
    const base = FULL_SHA.test(data.base) ? data.base.slice(0, SHORT_SHA) : data.base;
    const branch = this.branch ?? "HEAD";
    const out = [h_flex().h(28).mx(10).my(2).px(10).gap(6).items_center().rounded(6).bg(tint(colors.accent, "14")).text_size(TEXT.caption)
      .child(Icon("compare", 12).text_color(colors.accent))
      .child(div().flex_1().min_w(0).truncate().text_color(colors.foreground).child(`${branch}  ⟷  ${base}`))
      .child(div().text_color(colors.ansi6).child(`↑${data.commits.length}`))
      .child(div().text_color(colors.ansi4).child(`↓${data.behind}`))];
    if (!data.commits.length && !data.files.length) {
      out.push(Message(`Nothing on ${branch} that ${base} doesn't have.`));
    }
    for (const commit of data.commits.slice(0, COMPARE_COMMITS_SHOWN)) {
      out.push(...this.commitLine(colors, commit, 1));
    }
    if (!data.files.length) {
      return out;
    }
    out.push(h_flex().h(22).px(22).items_center().text_size(TEXT.caption).text_color(colors.muted).child(`${plural(data.files.length, "file")} changed`));
    for (const file of data.files.slice(0, COMPARE_FILES_SHOWN)) {
      out.push(this.fileLine(colors, file, 1, { scope: COMPARE, base: data.base, head: "HEAD" }));
    }
    return out;
  },

  renderCompare(colors, data) {
    const out = [this.searchBox(colors)];
    if (this.results) {
      out.push(...this.searchResults(colors));
    }
    if (data?.error) {
      out.push(Message(data.error, true));
    } else if (data) {
      out.push(...this.compareRows(colors, data));
    }
    return out;
  },
};
