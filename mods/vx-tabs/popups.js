// vx-tabs' popups: the tab list (the ⌄ overflow button, and the ⌘E switcher in recent order)
// and a tab's right-click menu. Popups close as soon as you choose, so anything that needs
// follow-up work (keep a preview, pin) is posted to the bar (shared "vx.tabs.cmd").
import { div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { theme, props, closeOverlay, spaces, run, shared, setShared } from "herdr";
import { describeTab, tabIcon, repoColor } from "./kinds.js";
import { TEXT, Icon } from "./ui.js";

const ROW = 32;
export const postTabs = (cmd) => setShared("vx.tabs.cmd", { ...cmd, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}` });

export const popupMethods = {
  // ── tab list / switcher ────────────────────────────────────────────────────────────────
  initList(p, cx) {
    this.list = p.list; // { mode: "list" | "switch" }
    this.filter = InputState.new({ placeholder: p.list.mode === "switch" ? "Switch to tab" : "Search tabs" });
    this.filter.on("change", (_e, cx) => { this.cursor = 0; cx.notify(); });
    this.filter.on("submit", (_e, cx) => this.chooseAt(this.cursor ?? 0, cx));
    this.filter.focus();
    this.cursor = p.list.mode === "switch" ? 1 : 0;
  },

  listedTabs() {
    const space = spaces().find((s) => s.active);
    let tabs = (space?.tabs ?? []).filter((t) => !t.settled);
    if (this.list.mode === "switch") {
      const mru = shared("vx.tabs.mru")?.[space?.id] ?? [];
      const rank = (t) => {
        const i = mru.indexOf(t.id);
        return t.active ? -1 : i < 0 ? 1e6 + (t.index ?? 0) : i;
      };
      tabs = [...tabs].sort((a, b) => rank(a) - rank(b));
    }
    const q = this.filter.value().trim().toLowerCase();
    return tabs
      .map((t) => ({ t, d: describeTab(t, space.id) }))
      .filter(({ d }) => !q || `${d.label} ${d.context}`.toLowerCase().includes(q));
  },

  chooseAt(i, _cx) {
    const item = this.listedTabs()[i];
    if (item) run("tab.select", { id: item.t.id });
    closeOverlay(props()?.overlay);
  },

  renderList() {
    const t = theme();
    const items = this.listedTabs();
    const cur = Math.min(this.cursor ?? 0, Math.max(0, items.length - 1));
    return v_flex().id("vx-tabs-list").size_full().p(6).gap(4).bg(t.popover ?? t.surface).text_color(t.foreground)
      .track_focus(this.listFocus)
      .on_key_down((e, cx) => {
        if (e.key === "down" || (e.key === "tab" && !e.modifiers?.shift)) { this.cursor = Math.min(items.length - 1, cur + 1); cx.stop_propagation(); cx.notify(); }
        else if (e.key === "up" || (e.key === "tab" && e.modifiers?.shift)) { this.cursor = Math.max(0, cur - 1); cx.stop_propagation(); cx.notify(); }
        else if (e.key === "enter") { cx.stop_propagation(); this.chooseAt(cur, cx); }
        else if (e.key === "escape") { cx.stop_propagation(); closeOverlay(props()?.overlay); }
      })
      .child(h_flex().h(30).flex_none().px(8).gap(6).items_center().rounded(6).border_1().border_color(t.accent).bg(t.input ?? t.background)
        .child(Icon("search", 12).text_color(t.dim)).child(Input.new(this.filter).flex_1().h(28).text_size(TEXT.small))
        .child(div().text_size(TEXT.caption).text_color(t.dim).child(`${items.length}`)))
      .child(v_flex().id("vx-tabs-rows").flex_none().h(Math.max(ROW, Math.min(12, items.length) * (ROW + 1))).overflow_y_scrollbar().gap(1)
        .children(items.map(({ t: tab, d }, i) => h_flex().id(`lt-${tab.id}`).h(ROW).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
          .bg(i === cur ? t.selected : "#00000000").hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.chooseAt(i, cx))
          .child(div().w(3).h(16).flex_none().rounded(2).when(Boolean(d.repo), (el) => el.bg(repoColor(d.repo, t))))
          .child(tabIcon(d, this.icons))
          .child(div().flex_none().max_w(220).truncate().text_size(TEXT.small).when(d.kind === "preview" || d.kind === "diff" ? d.preview : false, (el) => el.italic()).child(d.label))
          .child(div().flex_1().min_w(0).truncate().text_size(TEXT.caption).text_color(t.dim).child(d.context))
          .when(tab.status === "working", (el) => el.child(Icon("spinner", 11).text_color(t.working).spin(900)))
          .when(tab.status === "blocked" || tab.status === "done", (el) => el.child(div().size(6).rounded(3).bg(t[tab.status])))
          .when(tab.active, (el) => el.child(div().text_size(TEXT.caption).text_color(t.dim).child("current"))))))
      .when(!items.length, (el) => el.child(div().p(8).text_size(TEXT.small).text_color(t.dim).child("No matching tabs.")));
  },

  // ── right-click menu ───────────────────────────────────────────────────────────────────
  menuItems(m) {
    const space = spaces().find((s) => s.active);
    const tabs = (space?.tabs ?? []).filter((t) => !t.settled);
    const i = tabs.findIndex((t) => t.id === m.tab);
    const others = tabs.filter((t) => t.id !== m.tab);
    const right = tabs.slice(i + 1);
    const pinned = Boolean(shared("vx.tabs.pinned")?.[m.tab]);
    return [
      m.preview && { id: "keep", icon: "check", label: "Keep Open", run: () => postTabs({ cmd: "keep", tab: m.tab }) },
      { id: "pin", icon: pinned ? "minus" : "up", label: pinned ? "Unpin" : "Pin", run: () => postTabs({ cmd: pinned ? "unpin" : "pin", tab: m.tab }) },
      { id: "rename", icon: "pencil", label: "Rename…", run: () => run("tab.rename", { id: m.tab }) },
      { sep: true, id: "s1" },
      { id: "close", icon: "x", label: "Close", run: () => run("tab.close", { id: m.tab }) },
      others.length && { id: "others", icon: "x", label: `Close Others (${others.length})`, twice: true, run: () => others.forEach((t) => run("tab.close", { id: t.id })) },
      right.length && { id: "right", icon: "x", label: `Close to the Right (${right.length})`, twice: true, run: () => right.forEach((t) => run("tab.close", { id: t.id })) },
      { id: "settle", icon: "archive", label: "Put Away (keeps running)", run: () => run("tab.settle", { id: m.tab }) },
    ].filter(Boolean);
  },

  renderMenu() {
    const t = theme();
    const close = () => closeOverlay(props()?.overlay);
    return v_flex().id("vx-tabs-menu").size_full().p(6).bg(t.popover ?? t.surface).text_color(t.foreground).text_size(TEXT.small)
      .children(this.menuItems(this.menu).map((item) => item.sep
        ? div().id(item.id).h(1).my(4).flex_none().bg(t.border)
        : h_flex().id(`tm-${item.id}`).h(28).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
          .when(this.armed === item.id, (el) => el.bg(t.ansi1).text_color(t.background))
          .on_click((_e, cx) => {
            // Closing several tabs ends their terminals: the first click arms it, the second does it.
            if (item.twice && this.armed !== item.id) {
              this.armed = item.id;
              return cx.notify();
            }
            item.run();
            close();
          })
          .child(Icon(item.icon, 13).text_color(this.armed === item.id ? t.background : t.dim))
          .child(div().flex_1().truncate().child(this.armed === item.id ? `${item.label}: click again` : item.label))));
  },
};
