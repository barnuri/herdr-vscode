import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { theme, props, shared, setShared } from "herdr";

class HelloExtension extends View {
  static BADGE_KEY = "hello.count";

  init(given) {
    this.greeting = (props() ?? given ?? {}).greeting ?? "Hello";
  }

  bump() {
    setShared(HelloExtension.BADGE_KEY, (shared(HelloExtension.BADGE_KEY) ?? 0) + 1);
  }

  render() {
    const t = theme();
    return v_flex().id("hello-extension").size_full().p(12).gap(8).bg(t.chrome).text_color(t.foreground)
      .child(div().text_size(14).font_semibold().child(this.greeting))
      .child(div().id("hello-bump").px(10).py(4).rounded(6).bg(t.raised).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click(() => this.bump()).child(`Clicked ${shared(HelloExtension.BADGE_KEY) ?? 0} times (the activity badge)`));
  }
}

export default HelloExtension;
