import { View } from "gpui-kit";
import { InputState } from "gpui-base";
import { props, checking, nextCommand } from "herdr";
import { treeMethods } from "./tree.js";
import { previewMethods } from "./preview.js";
import { timelineMethods } from "./timeline.js";
import { loadIcons } from "./icons.js";

class VxFiles extends View {
  static FOLLOW_MS = 400;
  static REFRESH_MS = 10000;
  static MODE_VIEW = "view";
  static MODE_TIMELINE = "timeline";

  init(given, cx) {
    const initProps = props() ?? given ?? {};
    if (initProps.menu) {
      this.menu = initProps.menu;
      return;
    }
    loadIcons(this, cx);
    if (initProps.section === VxFiles.MODE_TIMELINE) {
      this.initTimelineMode(initProps, cx);
      return;
    }
    if (initProps.mode === VxFiles.MODE_VIEW) {
      this.initViewMode(initProps, cx);
      return;
    }
    this.initTreeMode(cx);
  }

  initTimelineMode(initProps, cx) {
    this.mode = VxFiles.MODE_TIMELINE;
    if (!checking()) {
      this.initTimeline(initProps, cx);
    }
  }

  initViewMode(initProps, cx) {
    this.mode = VxFiles.MODE_VIEW;
    if (checking()) {
      return;
    }
    this.initPreview(initProps, cx);
    cx.spawn(async (cx) => {
      for (;;) {
        this.handleCommand(await nextCommand(), cx);
        cx.notify();
      }
    });
  }

  handleCommand(command, cx) {
    if (command === "save") {
      this.save(cx);
    }
    if (command === "edit") {
      this.toggleEdit(cx);
    }
  }

  initTreeMode(cx) {
    this.filterState = InputState.new({ placeholder: "Filter files" });
    this.initTree(cx);
    if (checking()) {
      return;
    }
    cx.timer.every(VxFiles.FOLLOW_MS, (cx) => this.followTree(cx));
    cx.timer.every(VxFiles.REFRESH_MS, (cx) => this.reload(cx));
  }

  render() {
    if (this.menu) {
      return this.renderMenu();
    }
    if (this.mode === VxFiles.MODE_VIEW) {
      return this.renderPreview();
    }
    if (this.mode === VxFiles.MODE_TIMELINE) {
      return this.renderTimeline();
    }
    return this.renderTree();
  }
}

Object.assign(VxFiles.prototype, treeMethods, previewMethods, timelineMethods);
export default VxFiles;
