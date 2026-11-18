// The right-click menu of the Projects view, drawn by a popup copy of vx-projects (props().menu).
// Items are plain data so they cross into the popup copy: { label, icon, danger?, act: { type, ... } }.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, run, props, closeOverlay, openOverlay, exec, notify } from "herdr";
import { repoWebPage } from "./remote-url.js";
import { TEXT, Icon } from "./ui.js";
import { MANUAL } from "./projects-core.js";

class ProjectsMenu {
  static MOD = "vx-projects";
  static WIDTH = 240;
  static ROW_PX = 26;
  static HEAD_PX = 44;
  static PAD_PX = 8;
  static ICON_PX = 13;
  static COPIED_TOAST_MS = 1500;
  static REMOVE_COMMAND = "vx-projects.remove:";

  static URL_INDEX = 2;

  static urlItem(url) {
    return { label: "Open repository", icon: "external", act: { type: "url", url } };
  }

  static items(project) {
    const items = [
      { label: "Open", icon: "folder", act: { type: "space", project } },
      { label: "Open in new tab", icon: "plus", act: { type: "tab", project } },
    ];
    items.push({ label: "Copy path", icon: "copy", act: { type: "copy", path: project.path } });
    if (project.source === MANUAL) {
      items.push({ label: "Remove from list", icon: "trash", danger: true, act: { type: "remove", path: project.path } });
    }
    return items;
  }

  // Opens at once (an overlay opened after an await never shows); the popup copy looks up the
  // repository link itself, so the height keeps a row for it.
  static open(project) {
    const items = ProjectsMenu.items(project);
    const height = ProjectsMenu.HEAD_PX + (items.length + 1) * ProjectsMenu.ROW_PX + ProjectsMenu.PAD_PX;
    openOverlay({ mod: ProjectsMenu.MOD, kind: "popup", width: ProjectsMenu.WIDTH, height, props: { menu: { title: project.name, subtitle: project.path, path: project.path, items } } });
  }

  // `openProject(project, asTab)` is the view's own open (a space, or a tab).
  constructor(menu, openProject, cx) {
    this.menu = menu;
    this.openProject = openProject;
    this.selected = 0;
    this.focus = cx.focus_handle();
    this.focus.focus();
    cx.spawn(async (cx) => {
      const url = await repoWebPage(menu.path);
      if (url) {
        this.menu = { ...this.menu, items: this.menu.items.toSpliced(ProjectsMenu.URL_INDEX, 0, ProjectsMenu.urlItem(url)) };
        cx.notify();
      }
    });
  }

  fire(act, cx) {
    const actions = {
      space: () => this.openProject(act.project, false),
      tab: () => this.openProject(act.project, true),
      url: () => exec("open", [act.url]).catch((error) => notify({ title: "Couldn't open the repository", body: String(error), level: "error" })),
      copy: () => {
        cx.write_to_clipboard(act.path);
        notify({ title: "Path copied", body: act.path, timeout: ProjectsMenu.COPIED_TOAST_MS });
      },
      remove: () => run(`${ProjectsMenu.REMOVE_COMMAND}${act.path}`),
    };
    actions[act.type]?.();
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
    return h_flex().id(`menu-${index}`).h(ProjectsMenu.ROW_PX).px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .when(index === this.selected, (el) => el.bg(t.selected))
      .hover((style) => style.bg(t.hover))
      .on_click((_event, cx) => this.choose(index, cx))
      .child(Icon(item.icon, ProjectsMenu.ICON_PX).text_color(item.danger ? t.ansi1 : t.muted))
      .child(div().flex_1().truncate().text_size(TEXT.body).text_color(item.danger ? t.ansi1 : t.foreground).child(item.label));
  }

  render() {
    const t = theme();
    return v_flex().id("projects-menu").size_full().p(4).bg(t.popover ?? t.surface).text_color(t.foreground)
      .track_focus(this.focus)
      .on_key_down((event, cx) => this.onKey(event, cx))
      .child(v_flex().px(8).pt(4).pb(6)
        .child(div().truncate().text_size(TEXT.small).font_semibold().child(this.menu.title ?? ""))
        .when(Boolean(this.menu.subtitle), (el) => el.child(div().truncate().text_size(TEXT.caption).text_color(t.dim).child(this.menu.subtitle))))
      .children(this.menu.items.map((item, index) => this.row(t, item, index)));
  }
}

export default ProjectsMenu;
