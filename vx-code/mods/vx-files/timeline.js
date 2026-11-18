import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, spaces } from "herdr";
import { git, baseName } from "./ws.js";
import { parseLog, LOG_FORMAT, timeAgo } from "./git-core.js";
import { describeTab } from "./kinds.js";
import { showInViewer } from "./tabs.js";
import { SectionHead, sectionOpen } from "./side-sections.js";
import { TEXT, Icon, IconButton } from "./ui.js";

const FOLLOW_MS = 500;
const RELOAD_MS = 30000;
const MAX_COMMITS = 60;
const ROW_HEIGHT = 22;
const MS_PER_SECOND = 1000;
const FOLLOWED_KINDS = new Set(["preview", "diff"]);

function activeTabFile() {
  const space = spaces().find((candidate) => candidate.active);
  const tab = space?.tabs?.find((candidate) => candidate.active);
  if (!tab) {
    return null;
  }
  const described = describeTab(tab, space.id);
  const value = described.value;
  const rel = value?.rel ?? value?.path ?? null;
  if (!FOLLOWED_KINDS.has(described.kind) || !value?.root || !rel) {
    return null;
  }
  return { root: value.root, on: value.on ?? null, rel };
}

function hint(t, text) {
  return div().px(20).py(6).text_size(TEXT.small).text_color(t.dim).child(text);
}

export const timelineMethods = {
  initTimeline(initProps, cx) {
    this.section = initProps.block ?? "timeline";
    this.tlFile = null;
    this.tlItems = null;
    cx.timer.every(FOLLOW_MS, (cx) => this.followTimeline(cx));
    cx.timer.every(RELOAD_MS, (cx) => {
      if (this.tlFile) {
        this.loadTimeline(cx);
      }
    });
  },

  followTimeline(cx) {
    const file = activeTabFile();
    if (!file || JSON.stringify(file) === JSON.stringify(this.tlFile)) {
      return;
    }
    this.tlFile = file;
    this.tlItems = null;
    this.loadTimeline(cx);
    cx.notify();
  },

  loadTimeline(cx) {
    const file = this.tlFile;
    if (!file || this.tlBusy) {
      return;
    }
    this.tlBusy = true;
    cx.spawn(async (cx) => {
      try {
        const result = await git(["log", "-n", String(MAX_COMMITS), "--follow", LOG_FORMAT, "--", file.rel], { cwd: file.root, on: file.on }).catch(() => null);
        if (this.tlFile !== file) {
          return;
        }
        this.tlItems = result?.code === 0 ? parseLog(result.stdout) : [];
      } finally {
        this.tlBusy = false;
        cx.notify();
      }
    });
  },

  timelineRow(t, file, commit) {
    return h_flex().id(`tl-${commit.hash}`).h(ROW_HEIGHT).flex_none().pl(20).pr(8).gap(6).items_center().cursor_pointer()
      .hover((style) => style.bg(t.hover)).tooltip(`${commit.short} · ${commit.author}\n${commit.subject}`)
      .on_click(() => showInViewer("vx-changes", { root: file.root, on: file.on, path: file.rel, scope: "commit", sha: commit.hash, subject: commit.subject }, `${baseName(file.rel)} @ ${commit.short}`))
      .child(Icon("git-commit", 12).text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().text_size(TEXT.small).child(commit.subject))
      .child(div().flex_none().text_size(TEXT.caption).text_color(t.dim).child(`${commit.author.split(" ")[0]} · ${timeAgo(commit.at * MS_PER_SECOND)}`));
  },

  renderTimeline() {
    const t = theme();
    const open = sectionOpen(this.section);
    const file = this.tlFile;
    const refresh = file
      ? IconButton({ id: "tl-refresh", icon: "refresh", label: "Refresh", size: 18, spinning: this.tlBusy, onClick: (cx) => this.loadTimeline(cx) })
      : null;
    const root = v_flex().id("vx-timeline").size_full().bg(t.chrome).text_color(t.foreground).overflow_hidden()
      .child(SectionHead(t, { block: this.section, title: file ? `Timeline · ${baseName(file.rel)}` : "Timeline", open, right: [refresh] }));
    if (!open) {
      return root;
    }
    if (!file) {
      return root.child(hint(t, "Open a file to see its history."));
    }
    if (!this.tlItems) {
      return root.child(hint(t, "Loading…"));
    }
    if (!this.tlItems.length) {
      return root.child(hint(t, "No commits for this file (new or untracked)."));
    }
    return root.child(v_flex().id("tl-rows").flex_1().min_h(0).overflow_y_scrollbar()
      .children(this.tlItems.map((commit) => this.timelineRow(t, file, commit))));
  },
};
