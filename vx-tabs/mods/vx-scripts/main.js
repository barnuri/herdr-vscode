// vx-scripts: package.json scripts for the repo the panels show, in the tab bar row.
//   control    [pm logo] ▾ script ▶   ▶ runs the chosen script in a new tab in its folder
//   list       every script (root + workspace packages), filter, run in a tab or beside,
//              and the package manager: detected from packageManager / lockfile, switchable
//              among the ones installed here
//   mod.open:vx-scripts opens the list directly (for a key).
// A script can run anything: the list shows each command before you run it.
import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { theme, props, openOverlay, closeOverlay, exec, home, checking } from "herdr";
import { ctx, contextKey, repoTop, baseName } from "./ws.js";
import { TEXT, Icon, codeFont } from "./ui.js";

const MOD = "vx-scripts";
import { PM_ICON, store, save, findProject, pmOf, keyOf, allScripts, chosenOf, runScript } from "./scripts.js";

class VxScripts extends View {
  init(given, cx) {
    const p = props() ?? given ?? {};
    this.tops = new Map();
    if (p.menu || p.overlay) {
      // The list: from the control (props.menu) or straight from mod.open.
      this.isMenu = true;
      this.project = p.menu?.project ?? null;
      this.filter = InputState.new({ placeholder: "Filter scripts" });
      this.filter.on("change", (_e, cx) => cx.notify());
      this.filter.focus();
      if (!this.project && !checking()) this.detect(cx, true);
      return;
    }
    if (checking()) return;
    cx.timer.every(400, (cx) => this.detect(cx));
    cx.timer.every(15000, (cx) => { this.key = null; this.detect(cx); });
  }

  detect(cx, once = false) {
    const c = ctx();
    const key = contextKey(c);
    if ((!once && key === this.key) || this.busy) return;
    this.key = key;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const top = c.cwd ? await repoTop(this.tops, c.cwd, c.on) : null;
        const start = c.source === "focus" || c.source === "repo" ? c.cwd : top ?? c.cwd;
        const project = start ? await findProject(start, c.on) : null;
        if (JSON.stringify(project) !== JSON.stringify(this.project)) this.project = project;
        if (once && !project) this.none = true;
        cx.notify();
      } finally {
        this.busy = false;
      }
    });
  }

  openMenu() {
    const rows = Math.min(16, allScripts(this.project).length + this.project.groups.length);
    openOverlay({ mod: MOD, kind: "popup", width: 420, height: 112 + rows * 36, props: { menu: { project: this.project } } });
  }

  close() {
    closeOverlay(props()?.overlay);
  }

  renderMenu() {
    const t = theme();
    const p = this.project;
    const shell = v_flex().id("vx-scripts-menu").size_full().p(8).gap(6).bg(t.popover ?? t.surface).text_color(t.foreground);
    if (!p) return shell.child(div().p(8).text_size(TEXT.small).text_color(t.dim).child(this.none ? "No package.json with scripts in this repo." : "Looking for package.json…"));
    const pm = pmOf(p);
    const chosen = chosenOf(p);
    const q = this.filter.value().trim().toLowerCase();
    const match = (x) => !q || x.s.name.toLowerCase().includes(q) || x.s.cmd.toLowerCase().includes(q) || (x.g.rel ?? "").toLowerCase().includes(q);
    const recentKeys = store().recent?.[p.root] ?? [];
    const all = allScripts(p);
    const row = (x, id) => h_flex().id(id).h(36).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .bg(chosen?.key === x.key ? t.selected : "#00000000").hover((s) => s.bg(t.hover))
      .tooltip(`${pm} run ${x.s.name}${x.g.rel ? `  (in ${x.g.rel})` : ""}`)
      .on_click(() => { save({ chosen: { ...store().chosen, [p.root]: x.key } }); this.close(); })
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_size(TEXT.small).text_color(t.foreground).child(x.s.name))
        .child(div().truncate().text_size(TEXT.caption).font_family(codeFont()).text_color(t.dim).child(x.s.cmd)))
      .child(div().id(`${id}-split`).size(24).flex().items_center().justify_center().rounded(5).text_color(t.dim).hover((s) => s.bg(t.raised).text_color(t.foreground))
        .tooltip("Run beside the focused pane").on_click((_e, cx) => { cx.stop_propagation(); this.close(); runScript(p, x, true); })
        .child(Icon("split", 12)))
      .child(div().id(`${id}-run`).size(24).flex().items_center().justify_center().rounded(5).text_color(t.ansi2).hover((s) => s.bg(t.raised))
        .tooltip("Run in a new tab").on_click((_e, cx) => { cx.stop_propagation(); this.close(); runScript(p, x); })
        .child(Icon("play", 11)));
    const head = (text, sub) => h_flex().h(22).flex_none().px(8).gap(6).items_center().text_size(TEXT.caption).text_color(t.dim)
      .child(div().child(text.toUpperCase())).when(Boolean(sub), (el) => el.child(div().truncate().text_color(t.dim).child(sub)));
    // A popup sizes to its content, so the list says how tall it is (it scrolls past that).
    const shownRows = all.filter(match).length + (recentKeys.length && !q ? recentKeys.length + 1 : 0) + p.groups.length;
    const list = v_flex().id("sc-list").flex_none().h(Math.max(60, Math.min(440, shownRows * 37))).overflow_y_scrollbar().gap(1);
    const recent = recentKeys.map((k) => all.find((x) => x.key === k)).filter(Boolean).filter(match);
    if (recent.length && !q) {
      list.child(head("Recent"));
      list.children(recent.map((x) => row(x, `r-${x.key}`)));
    }
    for (const g of p.groups) {
      const items = g.scripts.map((s) => ({ g, s, key: keyOf(g, s) })).filter(match);
      if (!items.length) continue;
      list.child(head(g.rel ? g.name : `${g.name} · ${g.scripts.length} scripts`, g.rel ?? null));
      list.children(items.map((x) => row(x, `a-${x.key}`)));
    }
    return shell
      .child(h_flex().h(28).flex_none().px(4).gap(6).items_center()
        .child(image(PM_ICON(pm)).size(16).flex_none())
        .child(div().flex_1().truncate().font_medium().text_size(TEXT.small).child(p.name))
        .children(p.installed.map((name) => h_flex().id(`pm-${name}`).h(22).px(7).gap(4).items_center().rounded(11).cursor_pointer().text_size(TEXT.caption)
          .bg(name === pm ? t.selected : "#00000000").text_color(name === pm ? t.foreground : t.dim).border_1().border_color(name === pm ? t.border : "#00000000")
          .hover((s) => s.bg(t.hover))
          .tooltip(name === p.detected ? `${name} (detected from ${p.declared ? "packageManager" : "the lockfile"})` : `Use ${name} for this project`)
          .on_click((_e, cx) => { save({ pm: { ...(store().pm ?? {}), [p.root]: name } }); cx.notify(); })
          .child(image(PM_ICON(name)).size(12)).child(name === p.detected ? `${name} ✓` : name))))
      .child(h_flex().h(28).flex_none().px(8).gap(6).items_center().rounded(6).border_1().border_color(t.border).bg(t.input ?? t.background)
        .child(Icon("search", 12).text_color(t.dim)).child(Input.new(this.filter).flex_1().h(26).text_size(TEXT.small))
        .child(div().text_size(TEXT.caption).text_color(t.dim).child(`${all.length}`)))
      .child(list)
      .child(h_flex().h(22).flex_none().px(4).gap(8).items_center().text_size(TEXT.caption).text_color(t.dim)
        .child(div().flex_1().truncate().child(p.root.replace(home(), "~")))
        .child(div().id("sc-open").text_color(t.accent).cursor_pointer().on_click(() => { this.close(); if (!p.on) exec("open", [`${p.root}/package.json`]).catch(() => {}); }).child("open package.json")));
  }

  render() {
    if (this.isMenu) return this.renderMenu();
    const t = theme();
    const p = this.project;
    const root = h_flex().id(MOD).size_full().px(8).gap(2).items_center().justify_end().bg(t.chrome).border_b(1).border_color(t.border);
    if (!p) return root;
    const x = chosenOf(p);
    const pm = pmOf(p);
    const total = allScripts(p).length;
    return root
      .child(h_flex().id("sc-pick").h(26).max_w(170).px(7).gap(5).items_center().rounded_l(6).border_1().border_color(t.border).bg(t.background)
        .cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(`${p.name}: ${total} scripts · ${pm}\n${pm} run ${x.s.name}\n${x.s.cmd}`)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => this.openMenu())
        .child(image(PM_ICON(pm)).size(13).flex_none())
        .child(div().truncate().text_size(TEXT.small).text_color(t.foreground).child(x.s.name))
        .child(Icon("chevron-down", 11).text_color(t.dim)))
      .child(div().id("sc-run").h(26).w(28).flex().items_center().justify_center().rounded_r(6).border_1().border_color(t.border).bg(t.background)
        .text_color(t.ansi2).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(`Run ${x.s.name} in a new tab`)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => runScript(p, x))
        .child(Icon("play", 11)));
  }
}

export default VxScripts;
