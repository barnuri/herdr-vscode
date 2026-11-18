// The Save As dialog of an Untitled buffer: a herdr-vscode-files dialog copy (props().saveAs). It sends the
// chosen path back through shared("herdr-vscode.untitled.saveas"); the buffer's own copy writes the file.
import { div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { theme, props, closeOverlay, setShared, home } from "herdr";
import { TEXT, Button } from "./ui.js";
import { resolveSaveAs, SAVE_AS_KEY } from "./untitled-core.js";

class SaveAsDialog {
  static FOCUS_RETRY_MS = 300;

  constructor(spec, cx) {
    this.spec = spec;
    this.error = null;
    this.input = InputState.new({ value: spec.suggested ?? "" });
    this.input.on("submit", (_event, cx) => this.submit(cx));
    this.input.on("change", (_event, cx) => {
      this.error = null;
      cx.notify();
    });
    this.input.focus();
    cx.timer.after(SaveAsDialog.FOCUS_RETRY_MS, () => this.input.focus());
  }

  submit(cx) {
    const target = resolveSaveAs(this.input.value(), this.spec.folder, home());
    if (target.error) {
      this.error = target.error;
      cx.notify();
      return;
    }
    setShared(SAVE_AS_KEY, { token: this.spec.token, path: target.path, at: Date.now() });
    closeOverlay(props()?.overlay);
  }

  render() {
    const t = theme();
    const target = resolveSaveAs(this.input.value(), this.spec.folder, home());
    return v_flex().id("herdr-vscode-save-as").size_full().p(18).gap(10).bg(t.popover ?? t.surface).text_color(t.foreground)
      .on_key_down((event, cx) => {
        if (event.key === "escape") {
          cx.stop_propagation();
          closeOverlay(props()?.overlay);
        }
      })
      .child(div().text_size(TEXT.title).font_semibold().child(`Save ${this.spec.token} as`))
      .child(Input.new(this.input).h(32).px(8).rounded(6).border_1().border_color(t.border).bg(t.background).text_size(TEXT.body))
      .child(div().text_size(TEXT.caption).text_color(this.error ? t.ansi1 : t.dim).truncate()
        .child(this.error ?? (target.path ? `→ ${target.path}` : `A name in ${this.spec.folder}, ~/…, or an absolute path`)))
      .child(div().flex_1())
      .child(h_flex().gap(8).justify_end()
        .child(Button({ id: "save-as-no", label: "Cancel", onClick: () => closeOverlay(props()?.overlay) }))
        .child(Button({ id: "save-as-yes", label: "Save", primary: true, onClick: (cx) => this.submit(cx) })));
  }
}

export default SaveAsDialog;
