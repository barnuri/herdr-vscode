import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, run } from "herdr";
import { TEXT } from "./ui.js";

// The placeholder vx-tabs opens when the last tab closes, so the space stays open (VS Code's empty editor).
class VxEmpty extends View {
  static SHORTCUTS = [
    { id: "goto", label: "Quick Open", keys: "⌘ P", action: "vx-titlebar.goto" },
    { id: "newterm", label: "New Terminal", keys: "⌃ `", action: "vx-activity.newterm" },
    { id: "untitled", label: "New Untitled File", keys: "Double-click tab bar", action: "vx-tabs.untitled" },
    { id: "projects", label: "Open Project", keys: "Projects view", action: "vx-activity.projects" },
  ];
  static LABEL_WIDTH = 170;

  render() {
    const t = theme();
    return v_flex().id("vx-empty").size_full().items_center().justify_center().gap(10).bg(t.background)
      .children(VxEmpty.SHORTCUTS.map((shortcut) => h_flex().id(`empty-${shortcut.id}`).gap(16).px(12).py(4).rounded(6)
        .cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => run(shortcut.action))
        .child(div().w(VxEmpty.LABEL_WIDTH).text_right().text_size(TEXT.body).text_color(t.muted).child(shortcut.label))
        .child(div().text_size(TEXT.body).text_color(t.dim).child(shortcut.keys))));
  }
}

export default VxEmpty;
