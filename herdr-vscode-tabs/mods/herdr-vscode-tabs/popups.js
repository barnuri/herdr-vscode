import { div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { theme, props, closeOverlay, spaces, run, shared, setShared } from "herdr";
import { describeTab, tabIcon, repoColor } from "./kinds.js";
import { TEXT, Icon } from "./ui.js";
import { AUTOSAVE_KEY, AUTOSAVE_OFF, AUTOSAVE_AFTER_DELAY, autoSaveMode } from "./fileops-core.js";

const ROW = 32;
const MAX_VISIBLE_ROWS = 12;
const UNRANKED = 1e6;
const ID_RADIX = 36;
const ID_SUFFIX = [2, 7];
const CMD_KEY = "herdr-vscode.tabs.cmd";
const MRU_KEY = "herdr-vscode.tabs.mru";
const PINNED_KEY = "herdr-vscode.tabs.pinned";
const TRANSPARENT = "#00000000";
const NEEDS_YOU = ["blocked", "done"];

// Popups close as soon as you choose, so follow-up work is posted to the bar.
export const postTabs = (cmd) => setShared(CMD_KEY, { ...cmd, id: `${Date.now()}-${Math.random().toString(ID_RADIX).slice(...ID_SUFFIX)}` });

const visibleTabs = (space) => (space?.tabs ?? []).filter((tab) => !tab.settled);
const isItalic = (described) => (described.kind === "preview" || described.kind === "diff" ? described.preview : false);

export const popupMethods = {
  initList(options, cx) {
    this.list = options.list;
    const switching = options.list.mode === "switch";
    this.filter = InputState.new({ placeholder: switching ? "Switch to tab" : "Search tabs" });
    this.filter.on("change", (_e, cx) => { this.cursor = 0; cx.notify(); });
    this.filter.on("submit", (_e, cx) => this.chooseAt(this.cursor ?? 0, cx));
    this.filter.focus();
    this.cursor = switching ? 1 : 0;
  },

  listedTabs() {
    const space = spaces().find((s) => s.active);
    let tabs = visibleTabs(space);
    if (this.list.mode === "switch") {
      const mru = shared(MRU_KEY)?.[space?.id] ?? [];
      const rank = (tab) => {
        if (tab.active) {
          return -1;
        }
        const position = mru.indexOf(tab.id);
        return position < 0 ? UNRANKED + (tab.index ?? 0) : position;
      };
      tabs = [...tabs].sort((a, b) => rank(a) - rank(b));
    }
    const query = this.filter.value().trim().toLowerCase();
    return tabs
      .map((tab) => ({ t: tab, d: describeTab(tab, space.id) }))
      .filter(({ d }) => !query || `${d.label} ${d.context}`.toLowerCase().includes(query));
  },

  chooseAt(index, _cx) {
    const item = this.listedTabs()[index];
    if (item) {
      run("tab.select", { id: item.t.id });
    }
    closeOverlay(props()?.overlay);
  },

  onListKey(event, cur, count, cx) {
    const shift = Boolean(event.modifiers?.shift);
    if (event.key === "down" || (event.key === "tab" && !shift)) {
      this.cursor = Math.min(count - 1, cur + 1);
      cx.stop_propagation();
      cx.notify();
    } else if (event.key === "up" || (event.key === "tab" && shift)) {
      this.cursor = Math.max(0, cur - 1);
      cx.stop_propagation();
      cx.notify();
    } else if (event.key === "enter") {
      cx.stop_propagation();
      this.chooseAt(cur, cx);
    } else if (event.key === "escape") {
      cx.stop_propagation();
      closeOverlay(props()?.overlay);
    }
  },

  listRow(t, { t: tab, d: described }, index, cur) {
    return h_flex().id(`lt-${tab.id}`).h(ROW).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .bg(index === cur ? t.selected : TRANSPARENT).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.chooseAt(index, cx))
      .child(div().w(3).h(16).flex_none().rounded(2).when(Boolean(described.repo), (el) => el.bg(repoColor(described.repo, t))))
      .child(tabIcon(described, this.icons))
      .child(div().flex_none().max_w(220).truncate().text_size(TEXT.small).when(isItalic(described), (el) => el.italic()).child(described.label))
      .child(div().flex_1().min_w(0).truncate().text_size(TEXT.caption).text_color(t.dim).child(described.context))
      .when(tab.status === "working", (el) => el.child(Icon("spinner", 11).text_color(t.working).spin(900)))
      .when(NEEDS_YOU.includes(tab.status), (el) => el.child(div().size(6).rounded(3).bg(t[tab.status])))
      .when(tab.active, (el) => el.child(div().text_size(TEXT.caption).text_color(t.dim).child("current")));
  },

  renderList() {
    const t = theme();
    const items = this.listedTabs();
    const cur = Math.min(this.cursor ?? 0, Math.max(0, items.length - 1));
    return v_flex().id("herdr-vscode-tabs-list").size_full().p(6).gap(4).bg(t.popover ?? t.surface).text_color(t.foreground)
      .track_focus(this.listFocus)
      .on_key_down((event, cx) => this.onListKey(event, cur, items.length, cx))
      .child(h_flex().h(30).flex_none().px(8).gap(6).items_center().rounded(6).border_1().border_color(t.accent).bg(t.input ?? t.background)
        .child(Icon("search", 12).text_color(t.dim)).child(Input.new(this.filter).flex_1().h(28).text_size(TEXT.small))
        .child(div().text_size(TEXT.caption).text_color(t.dim).child(`${items.length}`)))
      .child(v_flex().id("herdr-vscode-tabs-rows").flex_none().h(Math.max(ROW, Math.min(MAX_VISIBLE_ROWS, items.length) * (ROW + 1))).overflow_y_scrollbar().gap(1)
        .children(items.map((item, index) => this.listRow(t, item, index, cur))))
      .when(!items.length, (el) => el.child(div().p(8).text_size(TEXT.small).text_color(t.dim).child("No matching tabs.")));
  },

  menuItems(menu) {
    const space = spaces().find((s) => s.active);
    const tabs = visibleTabs(space);
    const index = tabs.findIndex((tab) => tab.id === menu.tab);
    const others = tabs.filter((tab) => tab.id !== menu.tab);
    const right = tabs.slice(index + 1);
    const pinned = Boolean(shared(PINNED_KEY)?.[menu.tab]);
    const autoSaveOn = autoSaveMode(shared(AUTOSAVE_KEY)) !== AUTOSAVE_OFF;
    return [
      menu.preview && { id: "keep", icon: "check", label: "Keep Open", run: () => postTabs({ cmd: "keep", tab: menu.tab }) },
      { id: "pin", icon: pinned ? "minus" : "up", label: pinned ? "Unpin" : "Pin", run: () => postTabs({ cmd: pinned ? "unpin" : "pin", tab: menu.tab }) },
      { id: "rename", icon: "pencil", label: "Rename…", run: () => run("tab.rename", { id: menu.tab }) },
      { sep: true, id: "s1" },
      { id: "close", icon: "x", label: "Close", run: () => { const tab = tabs.find((candidate) => candidate.id === menu.tab); if (tab) this.constructor.closeTab(tab, "menu Close"); } },
      others.length && { id: "others", icon: "x", label: `Close Others (${others.length})`, twice: true, run: () => others.forEach((tab) => this.constructor.closeTab(tab, "menu Close Others")) },
      right.length && { id: "right", icon: "x", label: `Close to the Right (${right.length})`, twice: true, run: () => right.forEach((tab) => this.constructor.closeTab(tab, "menu Close to the Right")) },
      { id: "settle", icon: "archive", label: "Put Away (keeps running)", run: () => run("tab.settle", { id: menu.tab }) },
      { sep: true, id: "s2" },
      { id: "autosave", icon: autoSaveOn ? "check" : "minus", label: autoSaveOn ? "Auto Save: on (after delay)" : "Auto Save: off", run: () => setShared(AUTOSAVE_KEY, autoSaveOn ? AUTOSAVE_OFF : AUTOSAVE_AFTER_DELAY) },
    ].filter(Boolean);
  },

  // Closing several tabs ends their terminals: the first click arms it, the second does it.
  clickMenuItem(item, cx) {
    if (item.twice && this.armed !== item.id) {
      this.armed = item.id;
      return cx.notify();
    }
    item.run();
    closeOverlay(props()?.overlay);
  },

  menuRow(t, item) {
    if (item.sep) {
      return div().id(item.id).h(1).my(4).flex_none().bg(t.border);
    }
    const armed = this.armed === item.id;
    return h_flex().id(`tm-${item.id}`).h(28).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
      .when(armed, (el) => el.bg(t.ansi1).text_color(t.background))
      .on_click((_e, cx) => this.clickMenuItem(item, cx))
      .child(Icon(item.icon, 13).text_color(armed ? t.background : t.dim))
      .child(div().flex_1().truncate().child(armed ? `${item.label}: click again` : item.label));
  },

  renderMenu() {
    const t = theme();
    return v_flex().id("herdr-vscode-tabs-menu").size_full().p(6).bg(t.popover ?? t.surface).text_color(t.foreground).text_size(TEXT.small)
      .children(this.menuItems(this.menu).map((item) => this.menuRow(t, item)));
  },
};
