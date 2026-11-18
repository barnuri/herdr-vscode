import { appHome, readTextFile } from "herdr";

const ICON_TABLE = "mods/vx-icons/icons.json";

export function loadIcons(view, cx) {
  view.icons ??= null;
  cx.spawn(async (cx) => {
    try {
      view.icons = JSON.parse((await readTextFile(`${appHome()}/${ICON_TABLE}`)) ?? "null");
    } catch {
      view.icons = null;
    }
    cx.notify();
  });
}
