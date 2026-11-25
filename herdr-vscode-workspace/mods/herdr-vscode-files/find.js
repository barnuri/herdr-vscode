import { div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { buildPattern, findMatches, nextMatchIndex, matchIndexAt, replaceAll, replacementAt } from "./find-core.js";
import { TEXT, Icon, IconButton, tint } from "./ui.js";
import { getSetting, setSetting, whenSettings } from "./settings.js";
import { toast } from "./log.js";

const OPTION_KEYS = ["caseSensitive", "word", "regex"];
const OPTION_ALPHA = "33";
const BAR_WIDTH = 440;
const TOAST_MS = 2500;

function toggle(t, id, label, tip, on, onClick) {
  return div().id(id).h(20).min_w(22).px(3).flex().items_center().justify_center().rounded(4).cursor_pointer()
    .text_size(TEXT.caption).font_medium().tooltip(tip)
    .when(on, (el) => el.bg(tint(t.accent, OPTION_ALPHA)).border_1().border_color(t.accent).text_color(t.foreground))
    .when(!on, (el) => el.text_color(t.muted).hover((style) => style.bg(t.hover)))
    .on_click((_e, cx) => onClick(cx)).child(label);
}

function textButton(t, id, label, tip, onClick) {
  return div().id(id).px(6).h(22).flex().items_center().rounded(4).cursor_pointer().text_size(TEXT.caption)
    .text_color(t.muted).hover((style) => style.bg(t.hover)).tooltip(tip).on_click((_e, cx) => onClick(cx)).child(label);
}

// Find and replace inside the open file (⌘F, ⌥⌘F), working on the editor's text and selection.
export const findMethods = {
  initFind(cx) {
    this.findOpts = { caseSensitive: false, word: false, regex: false };
    const fromSettings = () => OPTION_KEYS.forEach((key) => {
      this.findOpts[key] = getSetting("find", key, this.findOpts[key]) === true;
    });
    fromSettings();
    whenSettings(cx, fromSettings);
    this.findQuery = InputState.new({ placeholder: "Find" });
    this.findWith = InputState.new({ placeholder: "Replace" });
    this.findQuery.on("change", (_e, cx) => this.findRefresh(cx, { select: true }));
    this.findQuery.on("submit", (event, cx) => this.findStep(cx, Boolean(event?.shift)));
    this.findWith.on("submit", (_e, cx) => this.findReplaceOne(cx));
    this.findOpen = false;
    this.findShowReplace = false;
    this.findHits = [];
    this.findError = null;
  },

  // ⌘F / ⌥⌘F: opens the bar on the file's editor, starting the editor when the file shows as read-only code.
  openFind(cx, { replace = false } = {}) {
    if (!this.file || this.file.on) {
      return;
    }
    if (this.blameOn) {
      this.toggleBlame(cx);
    }
    if (!this.editor) {
      this.startEdit(cx, { auto: true });
    }
    if (!this.editor) {
      return;
    }
    this.findOpen = true;
    this.findShowReplace = this.findShowReplace || replace;
    const selected = this.editor.selected_range();
    const picked = selected.end > selected.start ? this.editor.value().slice(selected.start, selected.end) : "";
    if (picked && !picked.includes("\n")) {
      this.findQuery.set_value(picked);
    }
    this.findRefresh(cx, { select: false });
    if (replace) {
      this.findWith.focus();
    } else {
      this.findQuery.focus();
      const length = this.findQuery.value().length;
      this.findQuery.set_selected_range({ start: 0, end: length });
    }
    cx.notify();
  },

  closeFind(cx) {
    this.findOpen = false;
    this.findHits = [];
    this.editor?.focus();
    cx.notify();
  },

  setFindOption(key, cx) {
    this.findOpts[key] = !this.findOpts[key];
    setSetting("find", key, this.findOpts[key]);
    this.findRefresh(cx, { select: true });
  },

  findPattern() {
    return buildPattern(this.findQuery.value(), this.findOpts);
  },

  // Recounts the matches; `select` also moves the editor's selection to the nearest one.
  findRefresh(cx, { select = false } = {}) {
    if (!this.findOpen || !this.editor) {
      return;
    }
    const { pattern, error } = this.findPattern();
    this.findError = error;
    this.findHits = findMatches(this.editor.value(), pattern);
    if (select && this.findHits.length) {
      this.findSelect(nextMatchIndex(this.findHits, this.editor.selected_range().start));
    }
    cx.notify();
  },

  findSelect(index) {
    const hit = this.findHits[index];
    if (hit) {
      this.editor.set_selected_range({ start: hit.start, end: hit.end });
    }
  },

  findCurrent() {
    const range = this.editor?.selected_range();
    return range ? matchIndexAt(this.findHits, range.start, range.end) : -1;
  },

  findStep(cx, backward = false) {
    if (!this.editor) {
      return;
    }
    this.findRefresh(cx);
    const range = this.editor.selected_range();
    this.findSelect(nextMatchIndex(this.findHits, backward ? range.start : range.end, backward));
    cx.notify();
  },

  findReplaceOne(cx) {
    if (!this.editor) {
      return;
    }
    this.findRefresh(cx);
    const index = this.findCurrent();
    if (index === -1) {
      this.findStep(cx);
      return;
    }
    const hit = this.findHits[index];
    const text = this.editor.value();
    this.editor.replace(replacementAt(text, this.findPattern().pattern, hit.start, this.findWith.value(), this.findOpts.regex));
    this.findRefresh(cx);
    this.findStep(cx);
  },

  findReplaceAll(cx) {
    if (!this.editor) {
      return;
    }
    const { pattern } = this.findPattern();
    const result = replaceAll(this.editor.value(), pattern, this.findWith.value(), this.findOpts.regex);
    if (result.count) {
      this.editor.set_value(result.text);
      toast("herdr-vscode-files", { title: `Replaced ${result.count} ${result.count === 1 ? "occurrence" : "occurrences"}`, level: "success", timeout: TOAST_MS });
    }
    this.findRefresh(cx);
  },

  findCount() {
    if (this.findError) {
      return this.findError;
    }
    if (!this.findQuery.value()) {
      return "";
    }
    if (!this.findHits.length) {
      return "No results";
    }
    const index = this.findCurrent();
    return `${index === -1 ? "?" : index + 1} of ${this.findHits.length}`;
  },

  // Keys while focus is in the editor or the bar: Escape closes, ⌃F / ⌃H open it (⌘F and ⌥⌘F are layout keys).
  findKey(event, cx) {
    const modifiers = event.modifiers ?? {};
    if (event.key === "escape" && this.findOpen) {
      cx.stop_propagation();
      this.closeFind(cx);
      return true;
    }
    if ((modifiers.control || modifiers.platform) && event.key === "f" && !modifiers.alt) {
      cx.stop_propagation();
      this.openFind(cx);
      return true;
    }
    if ((modifiers.control && event.key === "h") || (modifiers.platform && modifiers.alt && event.key === "f")) {
      cx.stop_propagation();
      this.openFind(cx, { replace: true });
      return true;
    }
    return false;
  },

  findBar(t) {
    const count = this.findCount();
    const field = (state) => h_flex().flex_1().min_w(0).h(24).pl(6).pr(3).gap(2).items_center().rounded(4).border_1().border_color(t.border).bg(t.background)
      .child(Input.new(state).flex_1().h(22).text_size(TEXT.small));
    return v_flex().id("pv-find").flex_none().w(BAR_WIDTH).max_w_full().self_end().mr(14).mt(2).p(4).gap(4).rounded(6).border_1().border_color(t.border).bg(t.raised ?? t.chrome)
      .on_key_down((event, cx) => this.findKey(event, cx))
      .child(h_flex().gap(4).items_center()
        .child(div().id("pv-find-mode").size(18).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer().hover((style) => style.bg(t.hover))
          .tooltip("Toggle Replace").on_click((_e, cx) => {
            this.findShowReplace = !this.findShowReplace;
            cx.notify();
          }).child(Icon(this.findShowReplace ? "chevron-down" : "chevron-right", 13).text_color(t.muted)))
        .child(h_flex().flex_1().min_w(0).h(24).pl(6).pr(3).gap(2).items_center().rounded(4).border_1().border_color(this.findError ? t.ansi1 : t.border).bg(t.background)
          .child(Input.new(this.findQuery).flex_1().h(22).text_size(TEXT.small))
          .child(toggle(t, "pv-find-case", "Aa", "Match Case", this.findOpts.caseSensitive, (cx) => this.setFindOption("caseSensitive", cx)))
          .child(toggle(t, "pv-find-word", "ab", "Match Whole Word", this.findOpts.word, (cx) => this.setFindOption("word", cx)))
          .child(toggle(t, "pv-find-regex", ".*", "Use Regular Expression", this.findOpts.regex, (cx) => this.setFindOption("regex", cx))))
        .child(div().flex_none().min_w(54).text_size(TEXT.caption).text_color(this.findError || count === "No results" ? t.ansi1 : t.dim).truncate().child(count))
        .child(IconButton({ id: "pv-find-prev", icon: "chevron-up", label: "Previous Match (⇧Enter)", size: 22, onClick: (cx) => this.findStep(cx, true) }))
        .child(IconButton({ id: "pv-find-next", icon: "chevron-down", label: "Next Match (Enter)", size: 22, onClick: (cx) => this.findStep(cx) }))
        .child(IconButton({ id: "pv-find-close", icon: "x", label: "Close (Escape)", size: 22, onClick: (cx) => this.closeFind(cx) })))
      .when(this.findShowReplace, (el) => el.child(h_flex().gap(4).items_center().pl(22)
        .child(field(this.findWith))
        .child(textButton(t, "pv-replace-one", "Replace", "Replace (Enter)", (cx) => this.findReplaceOne(cx)))
        .child(textButton(t, "pv-replace-all", "All", "Replace All", (cx) => this.findReplaceAll(cx)))));
  },
};
