// vx-changes: the Git Changes panel (panel.js) and its diff tab (diff.js).
//   panel  props {}                        stage / unstage / commit for the context repo
//   view   props { mode: "view", space }   the diff tab in the centre
import { View } from "gpui-kit";
import { TextareaState, InputState } from "gpui-base";
import { props, checking } from "herdr";
import { panelMethods } from "./panel.js";
import { diffMethods } from "./diff.js";
import { sectionMethods } from "./sections.js";
import { loadIcons } from "./icons.js";
import { RepoMenu } from "./repo-picker.js";

class VxChanges extends View {
  init(given, cx) {
    const p = props() ?? given ?? {};
    loadIcons(this, cx);
    if (p.repoMenu) return void (this.repoMenu = p.repoMenu);
    if (p.mode === "view") {
      this.mode = "view";
      if (!checking()) this.initDiff(p, cx);
      return;
    }
    this.message = TextareaState.new({ placeholder: "Commit message", rows: 3 });
    this.search = InputState.new({ placeholder: "Search commits" });
    this.initPanel(cx);
    this.initSections();
    if (checking()) return;
    cx.timer.every(400, (cx) => this.followPanel(cx));
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  render() {
    if (this.repoMenu) return RepoMenu(this);
    return this.mode === "view" ? this.renderDiff() : this.renderPanel();
  }
}

Object.assign(VxChanges.prototype, panelMethods, diffMethods, sectionMethods);
export default VxChanges;
