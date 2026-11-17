// Timeline (props { section: "timeline", block }): the commits that touched the file in the
// active tab (a preview or a diff), like VS Code's Timeline. It keeps the last file while a
// terminal is active. A click opens that commit's change to the file in the diff tab.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, spaces } from "herdr";
import { git, baseName } from "./ws.js";
import { parseLog, LOG_FORMAT, timeAgo } from "./git-core.js";
import { describeTab } from "./kinds.js";
import { showInViewer } from "./tabs.js";
import { SectionHead, sectionOpen } from "./side-sections.js";
import { TEXT, Icon, IconButton } from "./ui.js";

export const timelineMethods = {
  initTimeline(p, cx) {
    this.section = p.block ?? "timeline";
    this.tlFile = null;
    this.tlItems = null;
    cx.timer.every(500, (cx) => this.followTimeline(cx));
    cx.timer.every(30000, (cx) => { if (this.tlFile) this.loadTimeline(cx); });
  },

  followTimeline(cx) {
    const space = spaces().find((s) => s.active);
    const tab = space?.tabs?.find((t) => t.active);
    if (!tab) return;
    const d = describeTab(tab, space.id);
    const v = d.value;
    const rel = v?.rel ?? v?.path ?? null;
    if ((d.kind !== "preview" && d.kind !== "diff") || !v?.root || !rel) return;
    const file = { root: v.root, on: v.on ?? null, rel };
    if (JSON.stringify(file) === JSON.stringify(this.tlFile)) return;
    this.tlFile = file;
    this.tlItems = null;
    this.loadTimeline(cx);
    cx.notify();
  },

  loadTimeline(cx) {
    const f = this.tlFile;
    if (!f || this.tlBusy) return;
    this.tlBusy = true;
    cx.spawn(async (cx) => {
      try {
        const r = await git(["log", "-n", "60", "--follow", LOG_FORMAT, "--", f.rel], { cwd: f.root, on: f.on }).catch(() => null);
        if (this.tlFile !== f) return;
        this.tlItems = r?.code === 0 ? parseLog(r.stdout) : [];
      } finally {
        this.tlBusy = false;
        cx.notify();
      }
    });
  },

  renderTimeline() {
    const t = theme();
    const open = sectionOpen(this.section);
    const f = this.tlFile;
    const root = v_flex().id("vx-timeline").size_full().bg(t.chrome).text_color(t.foreground).overflow_hidden()
      .child(SectionHead(t, { block: this.section, title: f ? `Timeline · ${baseName(f.rel)}` : "Timeline", open,
        right: [f ? IconButton({ id: "tl-refresh", icon: "refresh", label: "Refresh", size: 18, spinning: this.tlBusy, onClick: (cx) => this.loadTimeline(cx) }) : null] }));
    if (!open) return root;
    if (!f) return root.child(div().px(20).py(6).text_size(TEXT.small).text_color(t.dim).child("Open a file to see its history."));
    if (!this.tlItems) return root.child(div().px(20).py(6).text_size(TEXT.small).text_color(t.dim).child("Loading…"));
    if (!this.tlItems.length) return root.child(div().px(20).py(6).text_size(TEXT.small).text_color(t.dim).child("No commits for this file (new or untracked)."));
    return root.child(v_flex().id("tl-rows").flex_1().min_h(0).overflow_y_scrollbar()
      .children(this.tlItems.map((c) => h_flex().id(`tl-${c.hash}`).h(22).flex_none().pl(20).pr(8).gap(6).items_center().cursor_pointer()
        .hover((s) => s.bg(t.hover)).tooltip(`${c.short} · ${c.author}\n${c.subject}`)
        .on_click(() => showInViewer("vx-changes", { root: f.root, on: f.on, path: f.rel, scope: "commit", sha: c.hash, subject: c.subject }, `${baseName(f.rel)} @ ${c.short}`))
        .child(Icon("git-commit", 12).text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().text_size(TEXT.small).child(c.subject))
        .child(div().flex_none().text_size(TEXT.caption).text_color(t.dim).child(`${c.author.split(" ")[0]} · ${timeAgo(c.at * 1000)}`)))));
  },
};
