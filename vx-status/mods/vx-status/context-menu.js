// A right-click menu drawn by a popup copy of a mod (props().menu = { title, subtitle, items }).
// Items are plain data: { label, icon, danger?, act }; the mod's `fire(act, cx)` runs them.
// `later` (optional, async) may return one more item to insert at `laterAt` once it is known.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, closeOverlay, openOverlay } from "herdr";
import { TEXT, Icon } from "./ui.js";

class ContextMenu {
  static WIDTH = 240;
  static ROW_PX = 26;
  static HEAD_PX = 44;
  static PAD_PX = 8;
  static ICON_PX = 13;

  // `spare` rows are kept for items the popup adds later.
  static open(mod, menu, spare = 0) {
    const height = ContextMenu.HEAD_PX + (menu.items.length + spare) * ContextMenu.ROW_PX + ContextMenu.PAD_PX;
    openOverlay({ mod, kind: "popup", width: ContextMenu.WIDTH, height, props: { menu } });
  }

  constructor(menu, fire, cx, { later = null, laterAt = 0 } = {}) {
    this.menu = menu;
    this.fire = fire;
    this.selected = 0;
    this.focus = cx.focus_handle();
    this.focus.focus();
    if (later) {
      cx.spawn(async (cx) => {
        const item = await later(menu).catch(() => null);
        if (item) {
          this.menu = { ...this.menu, items: this.menu.items.toSpliced(laterAt, 0, item) };
          cx.notify();
        }
      });
    }
  }

  choose(index, cx) {
    const item = this.menu.items[index];
    closeOverlay(props()?.overlay);
    if (item) {
      this.fire(item.act, cx);
    }
  }

  onKey(event, cx) {
    const last = this.menu.items.length - 1;
    const moves = { down: 1, up: -1 };
    if (event.key in moves) {
      this.selected = Math.min(last, Math.max(0, this.selected + moves[event.key]));
      cx.stop_propagation();
      cx.notify();
      return;
    }
    if (event.key === "enter") {
      this.choose(this.selected, cx);
    }
    if (event.key === "escape") {
      closeOverlay(props()?.overlay);
    }
  }

  row(t, item, index) {
    const color = item.danger ? t.ansi1 : t.foreground;
    return h_flex().id(`menu-${index}`).h(ContextMenu.ROW_PX).px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .when(index === this.selected, (el) => el.bg(t.selected))
      .hover((style) => style.bg(t.hover))
      .on_click((_event, cx) => this.choose(index, cx))
      .child(Icon(item.icon, ContextMenu.ICON_PX).text_color(item.danger ? t.ansi1 : t.muted))
      .child(div().flex_1().truncate().text_size(TEXT.body).text_color(color).child(item.label));
  }

  render() {
    const t = theme();
    return v_flex().id("vx-context-menu").size_full().p(4).bg(t.popover ?? t.surface).text_color(t.foreground)
      .track_focus(this.focus)
      .on_key_down((event, cx) => this.onKey(event, cx))
      .child(v_flex().px(8).pt(4).pb(6)
        .child(div().truncate().text_size(TEXT.small).font_semibold().child(this.menu.title ?? ""))
        .when(Boolean(this.menu.subtitle), (el) => el.child(div().truncate().text_size(TEXT.caption).text_color(t.dim).child(this.menu.subtitle))))
      .children(this.menu.items.map((item, index) => this.row(t, item, index)));
  }
}

export default ContextMenu;
