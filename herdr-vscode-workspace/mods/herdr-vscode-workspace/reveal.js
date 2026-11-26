import { ScrollHandle } from "gpui-base";
import { shared, spaces } from "herdr";
import { REVEAL_KEY } from "./links.js";
import { parentDirs } from "./links-core.js";
import { describeTab } from "./kinds.js";

const entryKey = (root, rel) => `${root}\0${rel}`;

// The file the active tab shows (a preview or a kept file tab), as an absolute path, or null.
function activeFilePath() {
  const space = spaces().find((candidate) => candidate.active);
  const tab = space?.tabs?.find((candidate) => candidate.active);
  if (!tab) {
    return null;
  }
  const description = describeTab(tab, space.id);
  const value = description.kind === "preview" ? description.value : null;
  return value?.root && value.rel && !value.on ? `${value.root.replace(/\/$/, "")}/${value.rel}` : null;
}

// A path link was opened (links.js, tools/hv), or the active tab shows another file: expand its
// folders in the Explorer, select the file and scroll it into view, like VS Code's "Reveal in Explorer".
export const revealMethods = {
  initReveal() {
    this.bodyScroll = ScrollHandle.new();
    this.revealSeen = shared(REVEAL_KEY)?.at ?? 0;
    this.activeFileSeen = null;
  },

  followReveal(cx) {
    const reveal = shared(REVEAL_KEY);
    if (reveal && reveal.at !== this.revealSeen && this.revealPath(reveal.abs, cx)) {
      this.revealSeen = reveal.at;
    }
    this.followActiveFile(cx);
  },

  // `force` (the Refresh button): reveal the active file even when it did not change.
  followActiveFile(cx, force = false) {
    const abs = activeFilePath();
    if (!abs || (abs === this.activeFileSeen && !force)) {
      return;
    }
    if (this.revealPath(abs, cx)) {
      this.activeFileSeen = abs;
    }
  },

  // False when no workspace folder holds `abs`.
  revealPath(abs, cx) {
    const root = (this.ws?.roots ?? []).filter((candidate) => abs.startsWith(`${candidate.path.replace(/\/$/, "")}/`))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (!root) {
      return false;
    }
    const rel = abs.slice(root.path.replace(/\/$/, "").length + 1);
    const dirs = ["", ...parentDirs(rel)];
    dirs.forEach((dir) => this.open.add(entryKey(root.path, dir)));
    this.selected = entryKey(root.path, rel);
    this.selection = new Set([this.selected]);
    this.anchor = this.selected;
    this.revealKey = this.selected;
    cx.spawn(async (cx) => {
      for (const dir of dirs) {
        if (!this.entries.has(entryKey(root.path, dir))) {
          await this.loadDir(root.path, dir).catch(() => {});
        }
      }
      cx.notify();
    });
    return true;
  },

  // From pushRootTree: the row about to be pushed at `index` shows `key`.
  noteRevealRow(key, index) {
    if (key === this.revealKey) {
      this.revealIndex = index;
    }
  },

  // After the body's rows are in: scroll the revealed one into view (`before`: children above them).
  scrollToReveal(before) {
    if (this.revealIndex === undefined || this.revealIndex === null) {
      return;
    }
    this.bodyScroll.scroll_to_item(before + this.revealIndex);
    this.revealIndex = null;
    this.revealKey = null;
  },
};
