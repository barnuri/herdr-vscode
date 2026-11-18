// The "repo ▾" switcher in the Changes, CI and Graph headers. Picking a repo makes it the active one
// for every herdr-vscode panel; the list is a popup copy of the same mod opened with props { repoMenu: { current } }.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, openOverlay, closeOverlay, props, shared } from "herdr";
import { workspace, setActive, baseName } from "./ws.js";
import { TEXT, Icon, FileIcon } from "./ui.js";

const ROW_HEIGHT = 30;
const MAX_VISIBLE_ROWS = 12;
const MENU_WIDTH = 280;
const MENU_CHROME_HEIGHT = 40;
const BUTTON_HEIGHT = 26;
const MENU_TITLE_HEIGHT = 22;
const REPO_ICON_SIZE = 15;
const CHEVRON_SIZE = 11;
const CHECK_SIZE = 12;
const CHECK_COLUMN_WIDTH = 14;
const BRANCH_MAX_WIDTH = 100;
const TRANSPARENT = "#00000000";

export function RepoButton(view, mod, current) {
  const t = theme();
  const roots = workspace()?.roots ?? [];
  const root = roots.find((candidate) => candidate.path === current);
  const label = root?.name ?? (current ? baseName(current) : "Pick a repo");
  return h_flex()
    .id(`${mod}-repo`).h(BUTTON_HEIGHT).min_w(0).px(6).gap(6).items_center().rounded(6).cursor_pointer()
    .hover((style) => style.bg(t.hover)).tooltip(current ? `${current}\nSwitch repo` : "Switch repo")
    .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
    .on_click(() => {
      if (!roots.length) {
        return;
      }
      const height = Math.min(MAX_VISIBLE_ROWS, roots.length) * ROW_HEIGHT + MENU_CHROME_HEIGHT;
      openOverlay({ mod, kind: "popup", width: MENU_WIDTH, height, props: { repoMenu: { current } } });
    })
    .child(FileIcon(view.icons, label, { dir: true, open: true, size: REPO_ICON_SIZE }))
    .child(div().min_w(0).truncate().font_medium().text_size(TEXT.body).text_color(t.foreground).child(label))
    .child(Icon("chevron-down", CHEVRON_SIZE).text_color(t.dim));
}

function RepoRow(view, root, current, branch) {
  const t = theme();
  const selected = root.path === current;
  return h_flex().id(`rp-${root.path}`).h(ROW_HEIGHT).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
    .bg(selected ? t.selected : TRANSPARENT).hover((style) => style.bg(t.hover))
    .on_click(() => {
      setActive(root, "pick");
      closeOverlay(props()?.overlay);
    })
    .child(FileIcon(view.icons, root.name, { dir: true, size: REPO_ICON_SIZE }))
    .child(div().flex_1().min_w(0).truncate().text_size(TEXT.small).child(root.name))
    .child(div().max_w(BRANCH_MAX_WIDTH).truncate().text_size(TEXT.caption).text_color(t.dim).child(branch ?? ""))
    .child(div().w(CHECK_COLUMN_WIDTH).flex_none().when(selected, (el) => el.child(Icon("check", CHECK_SIZE).text_color(t.accent))));
}

export function RepoMenu(view) {
  const t = theme();
  const ws = workspace();
  const git = shared("herdr-vscode.git") ?? {};
  const current = view.repoMenu?.current;
  const roots = ws?.roots ?? [];
  // A popup sizes to its content, so the list says how tall it is (it scrolls past the visible rows).
  const listHeight = Math.max(ROW_HEIGHT, Math.min(MAX_VISIBLE_ROWS, ws?.roots?.length ?? 0) * (ROW_HEIGHT + 1));
  return v_flex().id("repo-menu").size_full().p(6).gap(1).bg(t.popover ?? t.surface).text_color(t.foreground)
    .child(div().h(MENU_TITLE_HEIGHT).px(8).flex().items_center().text_size(TEXT.caption).text_color(t.dim).child((ws?.name ?? "Workspace").toUpperCase()))
    .child(v_flex().id("repo-list").flex_none().h(listHeight).overflow_y_scrollbar().gap(1)
      .children(roots.map((root) => RepoRow(view, root, current, git[root.path]?.branch))));
}
