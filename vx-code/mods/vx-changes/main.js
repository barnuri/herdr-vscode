// vx-changes: Source Control (panel.js + sections.js) and its diff tab (diff.js).
//   panel  props {}                        commit box, changes, repositories, GitLens sections
//   view   props { mode: "view", space }   the diff tab in the centre
//   popups props { scmMenu | scmAsk | confirm | repoMenu }   menus and dialogs (scm-popups.js)
import { View } from "gpui-kit";
import { TextareaState, InputState } from "gpui-base";
import { props, checking } from "herdr";
import { panelMethods } from "./panel.js";
import { diffMethods } from "./diff.js";
import { sectionMethods } from "./sections.js";
import { scmPopupMethods } from "./scm-popups.js";
import { confirmMethods } from "./actions.js";
import { loadIcons } from "./icons.js";
import { RepoMenu } from "./repo-picker.js";
import { ConfirmView } from "./ui.js";

class VxChanges extends View {
  init(given, cx) {
    const p = props() ?? given ?? {};
    loadIcons(this, cx);
    if (p.repoMenu) return void (this.repoMenu = p.repoMenu);
    if (p.confirm) {
      this.confirmSpec = p.confirm;
      this.confirmOverlay = p.overlay;
      this.confirmFocus = cx.focus_handle();
      this.confirmFocus.focus();
      return;
    }
    if (p.scmMenu || p.scmAsk) return void this.initScmPopup(p, cx);
    if (p.mode === "view") {
      this.mode = "view";
      if (!checking()) this.initDiff(p, cx);
      return;
    }
    this.message = TextareaState.new({ placeholder: "Message (⌘Enter to commit)", rows: 3 });
    this.message.set_auto_grow(2, 10);
    this.search = InputState.new({ placeholder: "Search commits" });
    this.initPanel(cx);
    this.initSections();
    if (checking()) return;
    cx.timer.every(400, (cx) => this.followPanel(cx));
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  render() {
    if (this.repoMenu) return RepoMenu(this);
    if (this.confirmSpec) return ConfirmView(this);
    if (this.scmMenu) return this.renderScmMenu();
    if (this.scmAsk) return this.renderScmAsk();
    return this.mode === "view" ? this.renderDiff() : this.renderPanel();
  }
}

Object.assign(VxChanges.prototype, panelMethods, diffMethods, sectionMethods, scmPopupMethods, confirmMethods);
export default VxChanges;
