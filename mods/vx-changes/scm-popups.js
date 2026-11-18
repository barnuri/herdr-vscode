// Source Control's popups: menus (⋯, a file's or commit's right-click, the Commit button's ⌄,
// the branch switcher) and small dialogs (new branch, stash). They are copies of this mod that
// close as soon as you choose, so they don't do the work: they post a command to the panel that
// opened them (shared "vx.changes.cmd", addressed by its `owner` id).
//   menu item = { id, icon, label, sub, color, checked, sep, header, cmd, copy, url }
import { div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { theme, props, openOverlay, closeOverlay, setShared, exec } from "herdr";
import { TEXT, Icon, Button, tint } from "./ui.js";
import { badBranchName } from "./scm-core.js";

const MOD = "vx-changes";
const ITEM = 28;
const HEADER = 22;

export const postScm = (owner, cmd) => setShared("vx.changes.cmd", { ...cmd, owner, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}` });

// A popup sizes to its content, so the list says how tall it is (it scrolls past 540).
const listHeight = (items) => Math.min(540, items.reduce((h, i) => h + (i.sep ? 9 : i.header ? HEADER : ITEM), 0));

export function openScmMenu(owner, items, width = 270) {
  openOverlay({ mod: MOD, kind: "popup", width, height: listHeight(items) + 12, props: { scmMenu: { owner, items } } });
}

// kind: "branch" { from } | "stash" { staged }
export function openScmAsk(owner, ask) {
  openOverlay({ mod: MOD, kind: "dialog", width: 420, height: ask.kind === "stash" ? 230 : 196, props: { scmAsk: { owner, ...ask } } });
}

export const scmPopupMethods = {
  initScmPopup(p, cx) {
    if (p.scmMenu) {
      this.scmMenu = p.scmMenu;
      return;
    }
    this.scmAsk = p.scmAsk;
    const a = this.scmAsk;
    this.askInput = InputState.new({ placeholder: a.kind === "branch" ? "Branch name, e.g. feat/new-thing" : "Message (optional)" });
    this.askInput.on("change", (_e, cx) => cx.notify());
    this.askInput.on("submit", (_e, cx) => this.askSubmit(cx));
    this.askToggles = a.kind === "branch" ? { switch: true } : { untracked: true, staged: Boolean(a.staged) };
    this.askInput.focus();
    this.askFocus = cx.focus_handle();
  },

  closeScm() {
    closeOverlay(props()?.overlay);
  },

  chooseItem(item, cx) {
    if (item.copy) cx.write_to_clipboard(item.copy);
    if (item.url) exec("open", [item.url]).catch(() => {});
    if (item.cmd) postScm(this.scmMenu.owner, item.cmd);
    this.closeScm();
  },

  renderScmMenu() {
    const t = theme();
    return v_flex().id("scm-menu").size_full().p(6).bg(t.popover ?? t.surface).text_color(t.foreground).text_size(TEXT.small)
      .child(v_flex().id("scm-menu-list").flex_none().h(listHeight(this.scmMenu.items)).overflow_y_scrollbar()
        .children(this.scmMenu.items.map((item) => {
          if (item.sep) return div().id(item.id).h(1).my(4).flex_none().bg(t.border);
          if (item.header) return div().id(item.id).h(HEADER).flex_none().px(8).flex().items_center().text_size(TEXT.tiny).font_medium().text_color(t.dim).child(item.header.toUpperCase());
          const off = Boolean(item.disabled);
          return h_flex().id(`sm-${item.id}`).h(ITEM).flex_none().px(8).gap(8).items_center().rounded(6)
            .when(!off, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.chooseItem(item, cx)))
            .when(Boolean(item.tip), (el) => el.tooltip(item.tip))
            .child(div().w(16).flex_none().flex().items_center().justify_center()
              .when(Boolean(item.icon), (el) => el.child(Icon(item.icon, 13).text_color(off ? t.dim : item.color ?? t.muted))))
            .child(div().flex_1().min_w(0).truncate().text_color(off ? t.dim : t.foreground).child(item.label))
            .when(Boolean(item.sub), (el) => el.child(div().flex_none().max_w(120).truncate().text_size(TEXT.caption).text_color(item.subColor ?? t.dim).child(item.sub)))
            .when(Boolean(item.checked), (el) => el.child(Icon("check", 12).text_color(t.accent)));
        })));
  },

  askSubmit(_cx) {
    const a = this.scmAsk;
    const value = this.askInput.value().trim();
    if (a.kind === "branch" && badBranchName(value)) return;
    postScm(a.owner, { cmd: a.kind === "branch" ? "createBranch" : "stashPush", value, ...this.askToggles, from: a.from });
    this.closeScm();
  },

  toggleRow(t, key, label, tip) {
    const on = this.askToggles[key];
    return h_flex().id(`tg-${key}`).gap(8).items_center().cursor_pointer().text_size(TEXT.small).text_color(on ? t.foreground : t.muted).tooltip(tip)
      .on_click((_e, cx) => { this.askToggles[key] = !on; cx.notify(); })
      .child(div().w(28).h(16).flex_none().rounded(8).p(2).bg(on ? t.accent : t.raised).border_1().border_color(on ? t.accent : t.border)
        .child(div().size(10).rounded(5).bg(on ? t.accent_foreground ?? t.background : t.dim).when(on, (el) => el.ml(12))))
      .child(label);
  },

  renderScmAsk() {
    const t = theme();
    const a = this.scmAsk;
    const value = this.askInput.value().trim();
    const problem = a.kind === "branch" && value ? badBranchName(value) : null;
    const ready = a.kind === "branch" ? value && !problem : true;
    return v_flex().id("scm-ask").size_full().p(18).gap(10).bg(t.popover ?? t.surface).text_color(t.foreground)
      .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); this.closeScm(); } })
      .child(h_flex().gap(8).items_center()
        .child(div().size(26).rounded(7).flex().items_center().justify_center().bg(tint(a.kind === "branch" ? t.ansi2 : t.ansi5))
          .child(Icon(a.kind === "branch" ? "branch" : "archive", 14).text_color(a.kind === "branch" ? t.ansi2 : t.ansi5)))
        .child(div().text_size(TEXT.title).font_semibold().child(a.kind === "branch" ? "New branch" : a.staged ? "Stash staged changes" : "Stash changes"))
        .child(div().flex_1())
        .when(a.kind === "branch" && Boolean(a.from), (el) => el.child(div().text_size(TEXT.caption).text_color(t.dim).child(`from ${a.from}`))))
      .child(h_flex().h(32).px(10).items_center().rounded(7).border_1().border_color(problem ? t.ansi1 : t.accent).bg(t.input ?? t.background)
        .child(Input.new(this.askInput).flex_1().h(30).text_size(TEXT.body)))
      .when(Boolean(problem), (el) => el.child(div().text_size(TEXT.caption).text_color(t.ansi1).child(problem)))
      .when(a.kind === "branch", (el) => el.child(this.toggleRow(t, "switch", "Switch to it", "Off: create the branch and stay where you are")))
      .when(a.kind === "stash" && !a.staged, (el) => el.child(this.toggleRow(t, "untracked", "Include new files", "Also stash files git doesn't track yet (-u)")))
      .when(a.kind === "stash", (el) => el.child(this.toggleRow(t, "staged", "Only staged changes", "Stash what's staged, keep the rest (--staged)")))
      .child(div().flex_1())
      .child(h_flex().gap(8).justify_end()
        .child(Button({ id: "ask-no", label: "Cancel", onClick: () => this.closeScm() }))
        .child(Button({ id: "ask-yes", label: a.kind === "branch" ? "Create Branch" : "Stash", primary: true, disabled: !ready, onClick: (cx) => this.askSubmit(cx) })));
  },
};
