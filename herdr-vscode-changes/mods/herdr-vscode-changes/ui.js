// The herdr-vscode look: Herdr's own sizes and colours as small components. Values in, callbacks out.
import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, settings } from "herdr";
import { iconFor, isLight } from "./icons-core.js";

export const TEXT = { tiny: 10, caption: 11, small: 12, body: 13, title: 14 };
export const SPIN_MS = 900;
export const UI = (name) => `mods/herdr-vscode-icons/ui/${name}.svg`;
const DEFAULT_CODE_FONT = "JetBrains Mono";
const DEFAULT_CODE_SIZE = 14;
const DEFAULT_TINT_ALPHA = "26";
const HEX_COLOR = /^#[0-9a-f]{6}/i;
const HEX_RGB_LENGTH = 7;
const ICON_SIZE = 14;
const BUTTON_ICON_SIZE = 13;
const ICON_BUTTON_SIZE = 24;
const HEADER_HEIGHT = 40;
const BUTTON_HEIGHT = 30;
const SECTION_HEAD_HEIGHT = 26;
const DOT_SIZE = 7;
const HOVER_OPACITY = 0.88;
const HIDDEN_CONFIRM_ARGS = /^(core|diff)\./;

export const codeFont = () => settings().font_family ?? DEFAULT_CODE_FONT;
export const codeSize = () => settings().font_size ?? DEFAULT_CODE_SIZE;
export const tint = (color, alpha = DEFAULT_TINT_ALPHA) => (HEX_COLOR.test(color ?? "") ? `${color.slice(0, HEX_RGB_LENGTH)}${alpha}` : color);

export const Icon = (name, size = ICON_SIZE) => svg(UI(name)).size(size).flex_none();

// A herdr-vscode-icons name ("files"), or an svg path inside the app home ("mods/<mod>/icon.svg").
export const IconAt = (icon, size = ICON_SIZE) => (icon.includes("/") ? svg(icon).size(size).flex_none() : Icon(icon, size));

// A workspace root, as vscode-icons draws one in VS Code.
export const RootIcon = (open = false, size = ICON_SIZE) => image(`mods/herdr-vscode-icons/icons/root_folder${open ? "_open" : ""}.svg`).size(size).flex_none();

// The plain icon when herdr-vscode-icons' table isn't loaded.
export function FileIcon(table, path, { dir = false, open = false, size = ICON_SIZE, color } = {}) {
  const t = theme();
  const picture = iconFor(table, path, { dir, open, light: isLight(t.background) });
  return picture ? image(picture).size(size).flex_none() : Icon(dir ? "folder" : "file", size).text_color(color ?? t.muted);
}

export function Panel(id) {
  const t = theme();
  return v_flex().id(id).size_full().min_w(0).min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(TEXT.body);
}

export function Header() {
  const t = theme();
  return h_flex().h(HEADER_HEIGHT).flex_none().px(12).gap(6).items_center().border_b(1).border_color(t.border);
}

export function Badge(text, color) {
  const t = theme();
  return div().flex_none().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(TEXT.tiny).text_color(color ?? t.muted).child(String(text));
}

export function IconButton({ id, icon, label, onClick, spinning = false, active = false, size = ICON_BUTTON_SIZE, disabled = false }) {
  const t = theme();
  return div()
    .id(id).size(size).flex_none().flex().items_center().justify_center().rounded(6)
    .text_color(active ? t.foreground : t.dim)
    .when(active, (el) => el.bg(t.selected))
    .accessibility_label(label).tooltip(label)
    .when(!disabled, (el) =>
      el.cursor_pointer().hover((style) => style.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
        .on_click((event, cx) => {
          cx.stop_propagation();
          onClick(cx, event);
        }))
    .child(spinning ? Icon("spinner", ICON_SIZE).spin(SPIN_MS) : Icon(icon, ICON_SIZE));
}

function buttonTextColor(t, solid, disabled) {
  if (solid) {
    return t.solid_foreground ?? t.background;
  }
  return disabled ? t.dim : t.foreground;
}

export function Button({ id, label, onClick, primary = false, danger = false, disabled = false, icon }) {
  const t = theme();
  const solid = (primary || danger) && !disabled;
  const fill = danger ? t.ansi1 : t.solid;
  return h_flex()
    .id(id).h(BUTTON_HEIGHT).flex_none().px(14).gap(6).items_center().justify_center().rounded(8).text_size(TEXT.small)
    .bg(solid ? fill : t.raised).text_color(buttonTextColor(t, solid, disabled))
    .border_1().border_color(solid ? fill : t.border)
    .when(!disabled, (el) => el.cursor_pointer().hover((style) => (solid ? style.opacity(HOVER_OPACITY) : style.bg(t.hover))).on_click((_event, cx) => onClick(cx)))
    .when(Boolean(icon), (el) => el.child(Icon(icon, BUTTON_ICON_SIZE)))
    .child(label);
}

export function Message(text, error = false) {
  const t = theme();
  return div().flex_none().px(12).py(8).text_size(TEXT.small).whitespace_normal().text_color(error ? t.ansi1 : t.dim).child(text);
}

export function SectionHead(label, count, right) {
  const t = theme();
  return h_flex().h(SECTION_HEAD_HEIGHT).flex_none().px(12).gap(6).items_center().text_size(TEXT.caption).font_medium().text_color(t.muted)
    .child(div().child(label.toUpperCase()))
    .when(count !== undefined && count !== null, (el) => el.child(Badge(count)))
    .child(div().flex_1())
    .when(Boolean(right), (el) => el.child(right));
}

export const Dot = (color, size = DOT_SIZE) => div().size(size).flex_none().rounded(size / 2).bg(color);

// A git letter's colour: green new, red gone or conflict, yellow edited.
export function markColor(mark, t = theme()) {
  if (!mark) {
    return null;
  }
  if (mark === "A" || mark === "?") {
    return t.ansi2;
  }
  if (mark === "D" || mark === "U") {
    return t.ansi1;
  }
  return t.ansi3;
}

export function stateLook(kind, t = theme()) {
  return {
    success: { color: t.ansi2, glyph: "✓" },
    failure: { color: t.ansi1, glyph: "✕" },
    running: { color: t.ansi4, glyph: "●" },
    queued: { color: t.dim, glyph: "○" },
    manual: { color: t.ansi5, glyph: "▸" },
    canceled: { color: t.dim, glyph: "–" },
    skipped: { color: t.dim, glyph: "–" },
    warning: { color: t.ansi3, glyph: "!" },
  }[kind] ?? { color: t.dim, glyph: "·" };
}

const isShownConfirmArg = (arg) => !String(arg).startsWith("--no-optional") && arg !== "-c" && !HIDDEN_CONFIRM_ARGS.test(arg);

function ConfirmStep(t, step) {
  return div().px(8).py(5).rounded(6).bg(t.raised).text_size(TEXT.caption).font_family(codeFont()).text_color(t.dim).truncate()
    .child(step.command ? step.command : [step.cmd, ...step.args.filter(isShownConfirmArg)].join(" "));
}

function confirmKeyDown(view, event, cx) {
  if (event.key === "enter") {
    cx.stop_propagation();
    view.confirmYes(cx);
  }
  if (event.key === "escape") {
    cx.stop_propagation();
    view.confirmNo();
  }
}

// The confirm dialog, drawn by a copy opened with props().confirm (see actions.js).
export function ConfirmView(view) {
  const t = theme();
  const spec = view.confirmSpec;
  const yesLabel = view.confirmBusy ? `${spec.action.doing ?? "Working"}…` : spec.label ?? "OK";
  return v_flex()
    .id("herdr-vscode-confirm").size_full().p(18).gap(10).bg(t.popover ?? t.surface).text_color(t.foreground)
    .track_focus(view.confirmFocus)
    .on_key_down((event, cx) => confirmKeyDown(view, event, cx))
    .child(div().text_size(TEXT.title).font_semibold().child(spec.title))
    .when(Boolean(spec.detail), (el) => el.child(div().text_size(TEXT.small).text_color(t.muted).whitespace_normal().child(spec.detail)))
    .children((spec.action.steps ?? [spec.action]).map((step) => ConfirmStep(t, step)))
    .child(div().flex_1())
    .child(h_flex().gap(8).justify_end()
      .child(Button({ id: "herdr-vscode-confirm-no", label: "Cancel", onClick: () => view.confirmNo(), disabled: view.confirmBusy }))
      .child(Button({ id: "herdr-vscode-confirm-yes", label: yesLabel, primary: !spec.danger, danger: Boolean(spec.danger), disabled: view.confirmBusy, onClick: (cx) => view.confirmYes(cx) })));
}
