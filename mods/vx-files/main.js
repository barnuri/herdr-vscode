// vx-files: the Files panel (tree.js) and its preview tab (preview.js). One class, three roles:
//   panel    props {}                         the tree of the context repo
//   view     props { mode: "view", space }    the preview tab in the centre
//   menu     props { menu }                   a right-click popup
import { View } from "gpui-kit";
import { InputState } from "gpui-base";
import { props, checking } from "herdr";
import { treeMethods } from "./tree.js";
import { previewMethods } from "./preview.js";
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
    if (p.mode === "view") {
      this.mode = "view";
      if (!checking()) this.initPreview(p, cx);
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
    return this.renderTree();
  }
}

Object.assign(VxFiles.prototype, treeMethods, previewMethods);
export default VxFiles;
