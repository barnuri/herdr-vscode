import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, appHome, readTextFile } from "herdr";
import { FileIcon, TEXT } from "./ui.js";

export default class HerdrVscodeIcons extends View {
  static TABLE_PATH = "mods/herdr-vscode-icons/icons.json";
  static SAMPLES = [["src", true], [".github/workflows", true], ["package.json", false], ["main.ts", false], ["main.spec.ts", false], ["Dockerfile", false]];

  init(_props, cx) {
    this.table = null;
    cx.spawn(async (cx) => {
      try {
        this.table = JSON.parse((await readTextFile(`${appHome()}/${HerdrVscodeIcons.TABLE_PATH}`)) ?? "null");
      } catch {}
      cx.notify();
    });
  }

  render() {
    const t = theme();
    return v_flex().id("herdr-vscode-icons").size_full().p(10).gap(4).bg(t.background).text_color(t.foreground).text_size(TEXT.body)
      .child(div().text_size(TEXT.caption).text_color(t.dim).child(this.table ? "vscode-icons (MIT)" : "Loading…"))
      .children(HerdrVscodeIcons.SAMPLES.map(([name, dir]) => h_flex().id(`s-${name}`).h(24).gap(8).items_center()
        .child(FileIcon(this.table, name, { dir })).child(div().child(name))));
  }
}
