import { View } from "gpui-kit";
import { TextareaState, InputState } from "gpui-base";
import { props, checking, nextCommand } from "herdr";
import { panelMethods } from "./panel.js";
import { diffMethods } from "./diff.js";
import { sectionMethods } from "./sections.js";
import { scmPopupMethods } from "./scm-popups.js";
import { confirmMethods } from "./actions.js";
import { loadIcons } from "./icons.js";
import { RepoMenu } from "./repo-picker.js";
import { ConfirmView } from "./ui.js";

class HerdrVscodeChanges extends View {
  static FOLLOW_MS = 400;
  static REFRESH_MS = 10000;
  static VIEW_MODE = "view";
  static MESSAGE_ROWS = 3;
  static MESSAGE_MIN_ROWS = 2;
  static MESSAGE_MAX_ROWS = 10;

  static HISTORY_PART = "history";
  static CHANGES_PART = "changes";

  static {
    Object.assign(this.prototype, panelMethods, diffMethods, sectionMethods, scmPopupMethods, confirmMethods);
  }

  static VIEW_COMMANDS = { viewAsTree: "tree", viewAsList: "flat" };

  init(given, cx) {
    const options = props() ?? given ?? {};
    loadIcons(this, cx);
    if (options.repoMenu) {
      this.repoMenu = options.repoMenu;
      return;
    }
    if (options.confirm) {
      this.initConfirm(options, cx);
      return;
    }
    if (options.scmMenu || options.scmAsk) {
      this.initScmPopup(options, cx);
      return;
    }
    if (options.mode === HerdrVscodeChanges.VIEW_MODE) {
      this.mode = HerdrVscodeChanges.VIEW_MODE;
      if (!checking()) {
        this.initDiff(options, cx);
      }
      return;
    }
    this.part = options.part === HerdrVscodeChanges.HISTORY_PART ? HerdrVscodeChanges.HISTORY_PART : HerdrVscodeChanges.CHANGES_PART;
    this.initPanelView(cx);
  }

  initConfirm(options, cx) {
    this.confirmSpec = options.confirm;
    this.confirmOverlay = options.overlay;
    this.confirmFocus = cx.focus_handle();
    this.confirmFocus.focus();
  }

  initPanelView(cx) {
    this.message = TextareaState.new({ placeholder: "Message (⌘Enter to commit)", rows: HerdrVscodeChanges.MESSAGE_ROWS });
    this.message.set_auto_grow(HerdrVscodeChanges.MESSAGE_MIN_ROWS, HerdrVscodeChanges.MESSAGE_MAX_ROWS);
    this.search = InputState.new({ placeholder: "Search commits" });
    this.initPanel(cx);
    this.initSections();
    if (checking()) {
      return;
    }
    cx.timer.every(HerdrVscodeChanges.FOLLOW_MS, (cx) => this.followPanel(cx));
    cx.timer.every(HerdrVscodeChanges.REFRESH_MS, (cx) => this.refresh(cx));
    // Key bindings and `herdr-app do herdr-vscode-changes.viewAsTree` (or .viewAsList).
    cx.spawn(async (cx) => {
      for (;;) {
        const view = HerdrVscodeChanges.VIEW_COMMANDS[await nextCommand()];
        if (view) {
          this.setView(view, cx);
        }
      }
    });
  }

  render() {
    if (this.repoMenu) {
      return RepoMenu(this);
    }
    if (this.confirmSpec) {
      return ConfirmView(this);
    }
    if (this.scmMenu) {
      return this.renderScmMenu();
    }
    if (this.scmAsk) {
      return this.renderScmAsk();
    }
    return this.mode === HerdrVscodeChanges.VIEW_MODE ? this.renderDiff() : this.renderPanel();
  }
}

export default HerdrVscodeChanges;
