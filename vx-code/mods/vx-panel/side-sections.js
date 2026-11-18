// Collapsible side-bar sections: collapsing resizes the layout block to its header
// (layout.resize), so the layout remembers it like any other click.
import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { layout, run } from "herdr";
import { findNode } from "./layout-core.js";
import { Icon } from "./ui.js";

export const SECTION_HEAD = 22;
const OPEN_PX = 220;
const OPEN_SLACK_PX = 2;
const CHEVRON_SIZE = 14;
const TITLE_TEXT_SIZE = 11;

const openSizeKey = (block) => `open:${block}`;

export function sectionOpen(block) {
  const node = findNode(layout(), block);
  return Boolean(node) && (node.size?.px ?? OPEN_PX) > SECTION_HEAD + OPEN_SLACK_PX;
}

function rememberOpenSize(block, px) {
  try {
    localStorage.setItem(openSizeKey(block), String(px));
  } catch {
    // Storage is optional: the section reopens at the default size.
  }
}

function rememberedOpenSize(block) {
  try {
    return Number(localStorage.getItem(openSizeKey(block))) || OPEN_PX;
  } catch {
    return OPEN_PX;
  }
}

export function toggleSection(block) {
  const node = findNode(layout(), block);
  if (!node) {
    return;
  }
  if (sectionOpen(block)) {
    rememberOpenSize(block, node.size?.px ?? OPEN_PX);
    run("layout.resize", { id: block, px: SECTION_HEAD });
    return;
  }
  run("layout.resize", { id: block, px: rememberedOpenSize(block) });
}

// The header row: chevron, TITLE, and (when open) controls on the right.
export function SectionHead(t, { block, title, open, right = [], count }) {
  const showCount = count !== undefined && count !== null && !open;
  return h_flex().id(`sec-${block}`).h(SECTION_HEAD).flex_none().pl(4).pr(6).gap(4).items_center().cursor_pointer()
    .border_t(1).border_color(t.border).text_size(TITLE_TEXT_SIZE).font_medium().text_color(t.foreground)
    .on_click((_event, cx) => {
      toggleSection(block);
      cx.notify();
    })
    .child(Icon(open ? "chevron-down" : "chevron-right", CHEVRON_SIZE).text_color(t.muted))
    .child(div().flex_1().min_w(0).truncate().child(title.toUpperCase()))
    .when(showCount, (el) => el.child(div().text_color(t.dim).child(String(count))))
    .when(open, (el) => el.children(right.filter(Boolean)));
}
