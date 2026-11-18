import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { theme, props, openOverlay, closeOverlay, exec, home, checking } from "herdr";
import { ctx, contextKey, repoTop } from "./ws.js";
import { TEXT, Icon, IconButton, codeFont } from "./ui.js";
import { SectionHead, sectionOpen } from "./side-sections.js";
import { PM_ICON, store, save, findProject, pmOf, keyOf, allScripts, chosenOf, runScript } from "./scripts.js";

export default class VxScripts extends View {
  static MOD = "vx-scripts";
  static DETECT_MS = 400;
  static REDETECT_MS = 15000;
  static TRANSPARENT = "#00000000";
  static MENU_WIDTH = 420;
  static MENU_CHROME_HEIGHT = 112;
  static MENU_ROW_HEIGHT = 36;
  static MENU_MAX_ROWS = 16;
  static LIST_ROW_HEIGHT = 37;
  static LIST_MIN_HEIGHT = 60;
  static LIST_MAX_HEIGHT = 440;
  static NO_SCRIPTS = "No package.json with scripts in this repo.";

  static stopPropagation(_e, cx) {
    cx.stop_propagation();
  }

  init(given, cx) {
    const initProps = props() ?? given ?? {};
    this.tops = new Map();
    if (initProps.menu || initProps.overlay) {
      this.initMenu(initProps, cx);
      return;
    }
    if (initProps.section) {
      this.section = initProps.block ?? "npm";
    }
    if (checking()) {
      return;
    }
    cx.timer.every(VxScripts.DETECT_MS, (cx) => this.detect(cx));
    cx.timer.every(VxScripts.REDETECT_MS, (cx) => {
      this.key = null;
      this.detect(cx);
    });
  }

  // The list opens from the control (props.menu) or straight from mod.open.
  initMenu(initProps, cx) {
    this.isMenu = true;
    this.project = initProps.menu?.project ?? null;
    this.filter = InputState.new({ placeholder: "Filter scripts" });
    this.filter.on("change", (_e, cx) => cx.notify());
    this.filter.focus();
    if (!this.project && !checking()) {
      this.detect(cx, true);
    }
  }

  detect(cx, once = false) {
    const context = ctx();
    const key = contextKey(context);
    if ((!once && key === this.key) || this.busy) {
      return;
    }
    this.key = key;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const top = context.cwd ? await repoTop(this.tops, context.cwd, context.on) : null;
        const fromCwd = context.source === "focus" || context.source === "repo";
        const start = fromCwd ? context.cwd : top ?? context.cwd;
        const project = start ? await findProject(start, context.on) : null;
        if (JSON.stringify(project) !== JSON.stringify(this.project)) {
          this.project = project;
        }
        if (once && !project) {
          this.none = true;
        }
        cx.notify();
      } finally {
        this.busy = false;
      }
    });
  }

  openMenu() {
    const rows = Math.min(VxScripts.MENU_MAX_ROWS, allScripts(this.project).length + this.project.groups.length);
    const height = VxScripts.MENU_CHROME_HEIGHT + rows * VxScripts.MENU_ROW_HEIGHT;
    openOverlay({ mod: VxScripts.MOD, kind: "popup", width: VxScripts.MENU_WIDTH, height, props: { menu: { project: this.project } } });
  }

  close() {
    closeOverlay(props()?.overlay);
  }

  scriptRow(t, project, entry, id) {
    const pm = pmOf(project);
    const chosen = chosenOf(project);
    const iconButton = (suffix) => div().id(`${id}-${suffix}`).size(24).flex().items_center().justify_center().rounded(5);
    return h_flex().id(id).h(36).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .bg(chosen?.key === entry.key ? t.selected : VxScripts.TRANSPARENT).hover((style) => style.bg(t.hover))
      .tooltip(`${pm} run ${entry.s.name}${entry.g.rel ? `  (in ${entry.g.rel})` : ""}`)
      .on_click(() => {
        save({ chosen: { ...store().chosen, [project.root]: entry.key } });
        this.close();
      })
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_size(TEXT.small).text_color(t.foreground).child(entry.s.name))
        .child(div().truncate().text_size(TEXT.caption).font_family(codeFont()).text_color(t.dim).child(entry.s.cmd)))
      .child(iconButton("split").text_color(t.dim).hover((style) => style.bg(t.raised).text_color(t.foreground))
        .tooltip("Run beside the focused pane").on_click((_e, cx) => {
          cx.stop_propagation();
          this.close();
          runScript(project, entry, true);
        })
        .child(Icon("split", 12)))
      .child(iconButton("run").text_color(t.ansi2).hover((style) => style.bg(t.raised))
        .tooltip("Run in a new tab").on_click((_e, cx) => {
          cx.stop_propagation();
          this.close();
          runScript(project, entry);
        })
        .child(Icon("play", 11)));
  }

  groupHead(t, text, sub) {
    return h_flex().h(22).flex_none().px(8).gap(6).items_center().text_size(TEXT.caption).text_color(t.dim)
      .child(div().child(text.toUpperCase())).when(Boolean(sub), (el) => el.child(div().truncate().text_color(t.dim).child(sub)));
  }

  scriptList(t, project, query) {
    const matches = (entry) => !query || [entry.s.name, entry.s.cmd, entry.g.rel ?? ""].some((text) => text.toLowerCase().includes(query));
    const recentKeys = store().recent?.[project.root] ?? [];
    const all = allScripts(project);
    const showRecent = recentKeys.length && !query;
    // A popup sizes to its content, so the list states its own height and scrolls past it.
    const shownRows = all.filter(matches).length + (showRecent ? recentKeys.length + 1 : 0) + project.groups.length;
    const height = Math.max(VxScripts.LIST_MIN_HEIGHT, Math.min(VxScripts.LIST_MAX_HEIGHT, shownRows * VxScripts.LIST_ROW_HEIGHT));
    const list = v_flex().id("sc-list").flex_none().h(height).overflow_y_scrollbar().gap(1);
    const recent = recentKeys.map((key) => all.find((entry) => entry.key === key)).filter(Boolean).filter(matches);
    if (recent.length && !query) {
      list.child(this.groupHead(t, "Recent"));
      list.children(recent.map((entry) => this.scriptRow(t, project, entry, `r-${entry.key}`)));
    }
    for (const group of project.groups) {
      const entries = group.scripts.map((script) => ({ g: group, s: script, key: keyOf(group, script) })).filter(matches);
      if (!entries.length) {
        continue;
      }
      list.child(this.groupHead(t, group.rel ? group.name : `${group.name} · ${group.scripts.length} scripts`, group.rel ?? null));
      list.children(entries.map((entry) => this.scriptRow(t, project, entry, `a-${entry.key}`)));
    }
    return list;
  }

  pmChip(t, project, name) {
    const pm = pmOf(project);
    const selected = name === pm;
    const detected = name === project.detected;
    return h_flex().id(`pm-${name}`).h(22).px(7).gap(4).items_center().rounded(11).cursor_pointer().text_size(TEXT.caption)
      .bg(selected ? t.selected : VxScripts.TRANSPARENT).text_color(selected ? t.foreground : t.dim).border_1().border_color(selected ? t.border : VxScripts.TRANSPARENT)
      .hover((style) => style.bg(t.hover))
      .tooltip(detected ? `${name} (detected from ${project.declared ? "packageManager" : "the lockfile"})` : `Use ${name} for this project`)
      .on_click((_e, cx) => {
        save({ pm: { ...(store().pm ?? {}), [project.root]: name } });
        cx.notify();
      })
      .child(image(PM_ICON(name)).size(12)).child(detected ? `${name} ✓` : name);
  }

  openPackageJson(project) {
    this.close();
    if (!project.on) {
      exec("open", [`${project.root}/package.json`]).catch(() => {});
    }
  }

  renderMenu() {
    const t = theme();
    const project = this.project;
    const shell = v_flex().id("vx-scripts-menu").size_full().p(8).gap(6).bg(t.popover ?? t.surface).text_color(t.foreground);
    if (!project) {
      return shell.child(div().p(8).text_size(TEXT.small).text_color(t.dim).child(this.none ? VxScripts.NO_SCRIPTS : "Looking for package.json…"));
    }
    const pm = pmOf(project);
    const query = this.filter.value().trim().toLowerCase();
    return shell
      .child(h_flex().h(28).flex_none().px(4).gap(6).items_center()
        .child(image(PM_ICON(pm)).size(16).flex_none())
        .child(div().flex_1().truncate().font_medium().text_size(TEXT.small).child(project.name))
        .children(project.installed.map((name) => this.pmChip(t, project, name))))
      .child(h_flex().h(28).flex_none().px(8).gap(6).items_center().rounded(6).border_1().border_color(t.border).bg(t.input ?? t.background)
        .child(Icon("search", 12).text_color(t.dim)).child(Input.new(this.filter).flex_1().h(26).text_size(TEXT.small))
        .child(div().text_size(TEXT.caption).text_color(t.dim).child(`${allScripts(project).length}`)))
      .child(this.scriptList(t, project, query))
      .child(h_flex().h(22).flex_none().px(4).gap(8).items_center().text_size(TEXT.caption).text_color(t.dim)
        .child(div().flex_1().truncate().child(project.root.replace(home(), "~")))
        .child(div().id("sc-open").text_color(t.accent).cursor_pointer().on_click(() => this.openPackageJson(project)).child("open package.json")));
  }

  sectionRow(t, project, entry, indent) {
    const pm = pmOf(project);
    const script = entry.s;
    return h_flex().id(`npm-${entry.key}`).h(22).flex_none().pl(indent).pr(6).gap(6).items_center().cursor_pointer()
      .hover((style) => style.bg(t.hover)).tooltip(`${pm} run ${script.name}\n${script.cmd}`)
      .on_click(() => runScript(project, entry))
      .child(Icon("terminal", 12).text_color(t.dim))
      .child(div().flex_none().max_w(150).truncate().text_size(TEXT.small).child(script.name))
      .child(div().flex_1().min_w(0).truncate().text_size(TEXT.caption).font_family(codeFont()).text_color(t.dim).child(script.cmd))
      .child(div().id(`npm-run-${entry.key}`).size(18).flex_none().flex().items_center().justify_center().rounded(4).text_color(t.ansi2)
        .hover((style) => style.bg(t.raised)).tooltip("Run in a new tab").on_click((_e, cx) => {
          cx.stop_propagation();
          runScript(project, entry);
        })
        .child(Icon("play", 10)));
  }

  sectionRows(t, project) {
    const pm = pmOf(project);
    const grouped = project.groups.length > 1;
    const rows = [];
    for (const group of project.groups.filter((candidate) => candidate.scripts.length)) {
      if (grouped) {
        rows.push(h_flex().id(`npm-g-${group.dir}`).h(22).flex_none().pl(14).gap(6).items_center().text_size(TEXT.caption).text_color(t.dim)
          .child(image(PM_ICON(pm)).size(12)).child(div().truncate().child(group.rel ?? group.name)));
      }
      for (const script of group.scripts) {
        rows.push(this.sectionRow(t, project, { g: group, s: script, key: keyOf(group, script) }, grouped ? 30 : 20));
      }
    }
    return rows;
  }

  renderSection() {
    const t = theme();
    const project = this.project;
    const open = sectionOpen(this.section);
    const filterButton = project ? IconButton({ id: "npm-all", icon: "search", label: "Filter scripts…", size: 18, onClick: () => this.openMenu() }) : null;
    const root = v_flex().id("vx-npm").size_full().bg(t.chrome).text_color(t.foreground).overflow_hidden()
      .child(SectionHead(t, {
        block: this.section,
        title: project ? `NPM Scripts · ${project.name}` : "NPM Scripts",
        open,
        count: project ? allScripts(project).length : null,
        right: [filterButton],
      }));
    if (!open) {
      return root;
    }
    if (!project) {
      return root.child(div().px(20).py(6).text_size(TEXT.small).text_color(t.dim).child(VxScripts.NO_SCRIPTS));
    }
    return root.child(v_flex().id("npm-rows").flex_1().min_h(0).overflow_y_scrollbar().children(this.sectionRows(t, project)));
  }

  render() {
    if (this.isMenu) {
      return this.renderMenu();
    }
    if (this.section) {
      return this.renderSection();
    }
    const t = theme();
    const project = this.project;
    const root = h_flex().id(VxScripts.MOD).size_full().px(8).gap(2).items_center().justify_end().bg(t.chrome).border_b(1).border_color(t.border);
    if (!project) {
      return root;
    }
    const chosen = chosenOf(project);
    const pm = pmOf(project);
    const total = allScripts(project).length;
    return root
      .child(h_flex().id("sc-pick").h(26).max_w(170).px(7).gap(5).items_center().rounded_l(6).border_1().border_color(t.border).bg(t.background)
        .cursor_pointer().hover((style) => style.bg(t.hover)).tooltip(`${project.name}: ${total} scripts · ${pm}\n${pm} run ${chosen.s.name}\n${chosen.s.cmd}`)
        .on_mouse_down("left", VxScripts.stopPropagation)
        .on_click(() => this.openMenu())
        .child(image(PM_ICON(pm)).size(13).flex_none())
        .child(div().truncate().text_size(TEXT.small).text_color(t.foreground).child(chosen.s.name))
        .child(Icon("chevron-down", 11).text_color(t.dim)))
      .child(div().id("sc-run").h(26).w(28).flex().items_center().justify_center().rounded_r(6).border_1().border_color(t.border).bg(t.background)
        .text_color(t.ansi2).cursor_pointer().hover((style) => style.bg(t.hover)).tooltip(`Run ${chosen.s.name} in a new tab`)
        .on_mouse_down("left", VxScripts.stopPropagation)
        .on_click(() => runScript(project, chosen))
        .child(Icon("play", 11)));
  }
}
