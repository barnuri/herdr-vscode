import { ScrollHandle } from "gpui-base";
import { shared } from "herdr";
import { REVEAL_KEY } from "./links.js";
import { parentDirs } from "./links-core.js";

const entryKey = (root, rel) => `${root}\0${rel}`;

// A path link was opened (links.js, tools/hv): expand its folders in the Explorer, select the file
// and scroll it into view, like VS Code's "Reveal in Explorer".
export const revealMethods = {
  initReveal() {
    this.bodyScroll = ScrollHandle.new();
    this.revealSeen = shared(REVEAL_KEY)?.at ?? 0;
  },

  followReveal(cx) {
    const reveal = shared(REVEAL_KEY);
    if (!reveal || reveal.at === this.revealSeen) {
      return;
    }
    const root = (this.ws?.roots ?? []).filter((candidate) => reveal.abs.startsWith(`${candidate.path.replace(/\/$/, "")}/`))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (!root) {
      return;
    }
    this.revealSeen = reveal.at;
    const rel = reveal.abs.slice(root.path.replace(/\/$/, "").length + 1);
    const dirs = ["", ...parentDirs(rel)];
    dirs.forEach((dir) => this.open.add(entryKey(root.path, dir)));
    this.selected = entryKey(root.path, rel);
    this.revealKey = this.selected;
    cx.spawn(async (cx) => {
      for (const dir of dirs) {
        if (!this.entries.has(entryKey(root.path, dir))) {
          await this.loadDir(root.path, dir).catch(() => {});
        }
      }
      cx.notify();
    });
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
