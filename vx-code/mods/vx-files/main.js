// vx-files: the Files panel (tree.js) and its preview tab (preview.js). One class, three roles:
//   panel    props {}                         the tree of the context repo
//   view     props { mode: "view", space }    the preview tab in the centre
//   menu     props { menu }                   a right-click popup
//   timeline props { section: "timeline" }    the side bar's Timeline section (timeline.js)
import { View } from "gpui-kit";
import { InputState } from "gpui-base";
import { props, checking, nextCommand } from "herdr";
import { treeMethods } from "./tree.js";
import { previewMethods } from "./preview.js";
import { timelineMethods } from "./timeline.js";
import { loadIcons } from "./icons.js";

const FOLLOW_MS = 400;
const REFRESH_MS = 10000;

class VxFiles extends View {
  init(given, cx) {
    const p = props() ?? given ?? {};
    if (p.menu) {
      this.menu = p.menu;
      return;
    }
    loadIcons(this, cx);
    if (p.section === "timeline") {
      this.mode = "timeline";
      if (!checking()) this.initTimeline(p, cx);
      return;
    }
    if (p.mode === "view") {
      this.mode = "view";
      if (checking()) return;
      this.initPreview(p, cx);
      // Keys (layout:vx-code): vx-files.save (⌘S) and vx-files.edit reach the shown preview.
      cx.spawn(async (cx) => {
        for (;;) {
          const c = await nextCommand();
          if (c === "save") this.save(cx);
          if (c === "edit") (this.editor ? this.stopEdit(cx) : this.startEdit(cx));
          cx.notify();
        }
      });
      return;
    }
    this.filterState = InputState.new({ placeholder: "Filter files" });
    this.initTree(cx);
    if (checking()) return;
    cx.timer.every(FOLLOW_MS, (cx) => this.followTree(cx));
    cx.timer.every(REFRESH_MS, (cx) => this.reload(cx));
  }

  render() {
    if (this.menu) return this.renderMenu();
    if (this.mode === "view") return this.renderPreview();
    if (this.mode === "timeline") return this.renderTimeline();
    return this.renderTree();
  }
}

Object.assign(VxFiles.prototype, treeMethods, previewMethods, timelineMethods);
export default VxFiles;
