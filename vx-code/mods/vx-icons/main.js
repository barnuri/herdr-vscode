// vx-icons: an asset pack (Material Icon Theme SVGs, MIT, and our ui/ icons) that the other vx
// mods draw by path. Shown in a layout anyway, it lists a few samples.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, appHome, readTextFile } from "herdr";
import { FileIcon } from "./ui.js";

const SAMPLES = [["src", true], [".github/workflows", true], ["package.json", false], ["main.ts", false], ["main.spec.ts", false], ["Dockerfile", false]];

export default class VxIcons extends View {
  init(_props, cx) {
    this.table = null;
    cx.spawn(async (cx) => {
      try { this.table = JSON.parse((await readTextFile(`${appHome()}/mods/vx-icons/icons.json`)) ?? "null"); } catch {}
      cx.notify();
    });
  }
  render() {
    const t = theme();
    return v_flex().id("vx-icons").size_full().p(10).gap(4).bg(t.background).text_color(t.foreground).text_size(13)
      .child(div().text_size(11).text_color(t.dim).child(this.table ? "Material Icon Theme (MIT)" : "Loading…"))
      .children(SAMPLES.map(([n, dir]) => h_flex().id(`s-${n}`).h(24).gap(8).items_center().child(FileIcon(this.table, n, { dir })).child(div().child(n))));
  }
}
