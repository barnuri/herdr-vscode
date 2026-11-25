import { View } from "gpui-kit";
import { InputState } from "gpui-base";
import { props, checking, nextCommand, window } from "herdr";
import { PollPacer } from "./poll-core.js";
import { treeMethods } from "./tree.js";
import { previewMethods } from "./preview.js";
import { timelineMethods } from "./timeline.js";
import { loadIcons } from "./icons.js";
import { findMethods } from "./find.js";
import { untitledMethods } from "./untitled.js";
import { fileMenuMethods } from "./file-menu.js";
import SaveAsDialog from "./save-as-dialog.js";
import { whenSettings } from "./settings.js";

class HerdrVscodeFiles extends View {
  static FOLLOW_MS = 400;
  static REFRESH_MS = 10000;
  static REFRESH_MAX_MS = 60000;
  static MODE_VIEW = "view";
  static MODE_TIMELINE = "timeline";

  init(given, cx) {
    const initProps = props() ?? given ?? {};
    whenSettings(cx);
    if (initProps.fileMenu) {
      this.fileMenu = initProps.fileMenu;
      return;
    }
    if (initProps.menu) {
      this.menu = initProps.menu;
      return;
    }
    if (initProps.saveAs) {
      this.saveAs = new SaveAsDialog(initProps.saveAs, cx);
      return;
    }
    loadIcons(this, cx);
    if (initProps.section === HerdrVscodeFiles.MODE_TIMELINE) {
      this.initTimelineMode(initProps, cx);
      return;
    }
    if (initProps.mode === HerdrVscodeFiles.MODE_VIEW) {
      this.initViewMode(initProps, cx);
      return;
    }
    this.initTreeMode(cx);
  }

  initTimelineMode(initProps, cx) {
    this.mode = HerdrVscodeFiles.MODE_TIMELINE;
    if (!checking()) {
      this.initTimeline(initProps, cx);
    }
  }

  initViewMode(initProps, cx) {
    this.mode = HerdrVscodeFiles.MODE_VIEW;
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
    if (this.mode === HerdrVscodeFiles.MODE_VIEW && (command === "find" || command === "replace")) {
      this.openFind(cx, { replace: command === "replace" });
    }
  }

  initTreeMode(cx) {
    this.filterState = InputState.new({ placeholder: "Filter files" });
    this.initTree(cx);
    if (checking()) {
      return;
    }
    cx.timer.every(HerdrVscodeFiles.FOLLOW_MS, (cx) => this.followTree(cx));
    this.reloadPacer = new PollPacer({ baseMs: HerdrVscodeFiles.REFRESH_MS, maxMs: HerdrVscodeFiles.REFRESH_MAX_MS });
    this.scheduleReload(cx);
  }

  // One timer chain: the next reload waits for the last one and backs off while the tree and its git
  // marks are unchanged or git is slow. A hidden window reloads nothing.
  scheduleReload(cx) {
    cx.timer.after(this.reloadPacer.nextMs(), (cx) => {
      if (window()?.visible !== false) {
        this.reload(cx, true);
      }
      this.scheduleReload(cx);
    });
  }

  render() {
    if (this.saveAs) {
      return this.saveAs.render();
    }
    if (this.fileMenu) {
      return this.renderFileMenu();
    }
    if (this.menu) {
      return this.renderMenu();
    }
    if (this.mode === HerdrVscodeFiles.MODE_VIEW) {
      return this.renderPreview();
    }
    if (this.mode === HerdrVscodeFiles.MODE_TIMELINE) {
      return this.renderTimeline();
    }
    return this.renderTree();
  }
}

Object.assign(HerdrVscodeFiles.prototype, treeMethods, previewMethods, findMethods, timelineMethods, untitledMethods, fileMenuMethods);
export default HerdrVscodeFiles;
