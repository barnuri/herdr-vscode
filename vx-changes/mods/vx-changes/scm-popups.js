import { div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { theme, props, openOverlay, closeOverlay, setShared, exec } from "herdr";
import { TEXT, Icon, Button, tint } from "./ui.js";
import { badBranchName } from "./scm-core.js";

const MOD = "vx-changes";
const COMMAND_KEY = "vx.changes.cmd";
const ITEM_HEIGHT = 28;
const HEADER_HEIGHT = 22;
const SEPARATOR_HEIGHT = 9;
const MAX_LIST_HEIGHT = 540;
const MENU_PADDING = 12;
const MENU_WIDTH = 270;
const ASK_WIDTH = 420;
const ASK_HEIGHT_STASH = 230;
const ASK_HEIGHT_BRANCH = 196;
const ID_RADIX = 36;
const ID_SUFFIX_START = 2;
const ID_SUFFIX_END = 7;
const ASK_BRANCH = "branch";
const ASK_STASH = "stash";

export const postScm = (owner, cmd) => setShared(COMMAND_KEY, { ...cmd, owner, id: `${Date.now()}-${Math.random().toString(ID_RADIX).slice(ID_SUFFIX_START, ID_SUFFIX_END)}` });

function itemHeight(item) {
  if (item.sep) {
    return SEPARATOR_HEIGHT;
  }
  return item.header ? HEADER_HEIGHT : ITEM_HEIGHT;
}

// A popup sizes to its content, so the list reports its own height.
const listHeight = (items) => Math.min(MAX_LIST_HEIGHT, items.reduce((height, item) => height + itemHeight(item), 0));

export function openScmMenu(owner, items, width = MENU_WIDTH) {
  openOverlay({ mod: MOD, kind: "popup", width, height: listHeight(items) + MENU_PADDING, props: { scmMenu: { owner, items } } });
}

export function openScmAsk(owner, ask) {
  openOverlay({ mod: MOD, kind: "dialog", width: ASK_WIDTH, height: ask.kind === ASK_STASH ? ASK_HEIGHT_STASH : ASK_HEIGHT_BRANCH, props: { scmAsk: { owner, ...ask } } });
}

function askTitle(ask) {
  if (ask.kind === ASK_BRANCH) {
    return "New branch";
  }
  return ask.staged ? "Stash staged changes" : "Stash changes";
}

export const scmPopupMethods = {
  initScmPopup(options, cx) {
    if (options.scmMenu) {
      this.scmMenu = options.scmMenu;
      return;
    }
    this.scmAsk = options.scmAsk;
    const isBranch = this.scmAsk.kind === ASK_BRANCH;
    this.askInput = InputState.new({ placeholder: isBranch ? "Branch name, e.g. feat/new-thing" : "Message (optional)" });
    this.askInput.on("change", (_e, cx) => cx.notify());
    this.askInput.on("submit", (_e, cx) => this.askSubmit(cx));
    this.askToggles = isBranch ? { switch: true } : { untracked: true, staged: Boolean(this.scmAsk.staged) };
    this.askInput.focus();
    this.askFocus = cx.focus_handle();
  },

  closeScm() {
    closeOverlay(props()?.overlay);
  },

  chooseItem(item, cx) {
    if (item.copy) {
      cx.write_to_clipboard(item.copy);
    }
    if (item.url) {
      exec("open", [item.url]).catch(() => {});
    }
    if (item.cmd) {
      postScm(this.scmMenu.owner, item.cmd);
    }
    this.closeScm();
  },

  menuItem(colors, item) {
    if (item.sep) {
      return div().id(item.id).h(1).my(4).flex_none().bg(colors.border);
    }
    if (item.header) {
      return div().id(item.id).h(HEADER_HEIGHT).flex_none().px(8).flex().items_center().text_size(TEXT.tiny).font_medium().text_color(colors.dim).child(item.header.toUpperCase());
    }
    const disabled = Boolean(item.disabled);
    return h_flex().id(`sm-${item.id}`).h(ITEM_HEIGHT).flex_none().px(8).gap(8).items_center().rounded(6)
      .when(!disabled, (el) => el.cursor_pointer().hover((style) => style.bg(colors.hover)).on_click((_e, cx) => this.chooseItem(item, cx)))
      .when(Boolean(item.tip), (el) => el.tooltip(item.tip))
      .child(div().w(16).flex_none().flex().items_center().justify_center()
        .when(Boolean(item.icon), (el) => el.child(Icon(item.icon, 13).text_color(disabled ? colors.dim : item.color ?? colors.muted))))
      .child(div().flex_1().min_w(0).truncate().text_color(disabled ? colors.dim : colors.foreground).child(item.label))
      .when(Boolean(item.sub), (el) => el.child(div().flex_none().max_w(120).truncate().text_size(TEXT.caption).text_color(item.subColor ?? colors.dim).child(item.sub)))
      .when(Boolean(item.checked), (el) => el.child(Icon("check", 12).text_color(colors.accent)));
  },

  renderScmMenu() {
    const colors = theme();
    return v_flex().id("scm-menu").size_full().p(6).bg(colors.popover ?? colors.surface).text_color(colors.foreground).text_size(TEXT.small)
      .child(v_flex().id("scm-menu-list").flex_none().h(listHeight(this.scmMenu.items)).overflow_y_scrollbar()
        .children(this.scmMenu.items.map((item) => this.menuItem(colors, item))));
  },

  askSubmit(_cx) {
    const ask = this.scmAsk;
    const value = this.askInput.value().trim();
    if (ask.kind === ASK_BRANCH && badBranchName(value)) {
      return;
    }
    postScm(ask.owner, { cmd: ask.kind === ASK_BRANCH ? "createBranch" : "stashPush", value, ...this.askToggles, from: ask.from });
    this.closeScm();
  },

  toggleRow(colors, key, label, tip) {
    const on = this.askToggles[key];
    return h_flex().id(`tg-${key}`).gap(8).items_center().cursor_pointer().text_size(TEXT.small).text_color(on ? colors.foreground : colors.muted).tooltip(tip)
      .on_click((_e, cx) => {
        this.askToggles[key] = !on;
        cx.notify();
      })
      .child(div().w(28).h(16).flex_none().rounded(8).p(2).bg(on ? colors.accent : colors.raised).border_1().border_color(on ? colors.accent : colors.border)
        .child(div().size(10).rounded(5).bg(on ? colors.accent_foreground ?? colors.background : colors.dim).when(on, (el) => el.ml(12))))
      .child(label);
  },

  renderScmAsk() {
    const colors = theme();
    const ask = this.scmAsk;
    const isBranch = ask.kind === ASK_BRANCH;
    const isStash = ask.kind === ASK_STASH;
    const value = this.askInput.value().trim();
    const problem = isBranch && value ? badBranchName(value) : null;
    const ready = isBranch ? value && !problem : true;
    const kindColor = isBranch ? colors.ansi2 : colors.ansi5;
    return v_flex().id("scm-ask").size_full().p(18).gap(10).bg(colors.popover ?? colors.surface).text_color(colors.foreground)
      .on_key_down((event, cx) => {
        if (event.key !== "escape") {
          return;
        }
        cx.stop_propagation();
        this.closeScm();
      })
      .child(h_flex().gap(8).items_center()
        .child(div().size(26).rounded(7).flex().items_center().justify_center().bg(tint(kindColor))
          .child(Icon(isBranch ? "branch" : "archive", 14).text_color(kindColor)))
        .child(div().text_size(TEXT.title).font_semibold().child(askTitle(ask)))
        .child(div().flex_1())
        .when(isBranch && Boolean(ask.from), (el) => el.child(div().text_size(TEXT.caption).text_color(colors.dim).child(`from ${ask.from}`))))
      .child(h_flex().h(32).px(10).items_center().rounded(7).border_1().border_color(problem ? colors.ansi1 : colors.accent).bg(colors.input ?? colors.background)
        .child(Input.new(this.askInput).flex_1().h(30).text_size(TEXT.body)))
      .when(Boolean(problem), (el) => el.child(div().text_size(TEXT.caption).text_color(colors.ansi1).child(problem)))
      .when(isBranch, (el) => el.child(this.toggleRow(colors, "switch", "Switch to it", "Off: create the branch and stay where you are")))
      .when(isStash && !ask.staged, (el) => el.child(this.toggleRow(colors, "untracked", "Include new files", "Also stash files git doesn't track yet (-u)")))
      .when(isStash, (el) => el.child(this.toggleRow(colors, "staged", "Only staged changes", "Stash what's staged, keep the rest (--staged)")))
      .child(div().flex_1())
      .child(h_flex().gap(8).justify_end()
        .child(Button({ id: "ask-no", label: "Cancel", onClick: () => this.closeScm() }))
        .child(Button({ id: "ask-yes", label: isBranch ? "Create Branch" : "Stash", primary: true, disabled: !ready, onClick: (cx) => this.askSubmit(cx) })));
  },
};
