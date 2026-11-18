import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, exec, run, spaces, layout, props, setShared, shared, checking, nextCommand, home, appHome, readTextFile } from "herdr";
import { setActive, baseName } from "./ws.js";
import { TEXT, IconButton, FileIcon, Message } from "./ui.js";
import { loadIcons } from "./icons.js";
import { timeAgo } from "./git-core.js";
import { findNode } from "./layout-core.js";
import { repoWebPage } from "./remote-url.js";
import ContextMenu from "./context-menu.js";
import { parseAudit, summaryText } from "./pending-core.js";
import { toast, logError } from "./log.js";

class HerdrVscodePending extends View {
  static MOD = "herdr-vscode-pending";
  static VIEW_ID = "ext-pending";
  static STACK = "sidebar-views";
  static SIDEBAR = "sidebar";
  static BADGE_KEY = "herdr-vscode.pending.badge";
  // The audit script (read-only, never fetches): mod.json settings.auditScript, else the bundled copy.
  static BUNDLED_SCRIPT = "repo_pending_audit.py";
  static DEFAULT_ROOT = "~/code";
  static COPIED_TOAST_MS = 1500;
  static SCAN_TIMEOUT_MS = 60000;
  static REFRESH_MS = 300000;
  static SHOWN_POLL_MS = 1500;
  static AGO_TICK_MS = 30000;
  static ROW_PX = 24;
  static ICON_PX = 14;
  static URL_ITEM_AT = 3;

  static markerColor(kind, t) {
    const colors = { ahead: t.accent, added: t.ansi2, untracked: t.dim, modified: t.ansi3, deleted: t.ansi1, conflict: t.ansi1, noUpstream: t.ansi1 };
    return colors[kind] ?? t.dim;
  }

  static expandHome(path) {
    return path.replace(/^~(?=\/|$)/, home());
  }

  // Settings live in the installed mod.json ("settings"), which sync.sh keeps across updates.
  static async scanSettings() {
    const dir = `${appHome()}/mods/${HerdrVscodePending.MOD}`;
    const text = await readTextFile(`${dir}/mod.json`).catch(() => null);
    let settings = {};
    try {
      settings = JSON.parse(text ?? "{}").settings ?? {};
    } catch (error) {
      logError(HerdrVscodePending.MOD, "mod.json is not valid JSON", String(error));
    }
    const script = settings.auditScript ? HerdrVscodePending.expandHome(settings.auditScript) : `${dir}/${HerdrVscodePending.BUNDLED_SCRIPT}`;
    return { script, root: settings.root || HerdrVscodePending.DEFAULT_ROOT };
  }

  static spaceAt(path) {
    return spaces().find((space) => !space.machine && space.folder.replace(/\/+$/, "") === path) ?? null;
  }

  static menuItems(repo) {
    return [
      { label: "Open as space", icon: "folder", act: { type: "space", repo } },
      { label: "Open in new tab", icon: "plus", act: { type: "tab", repo } },
      { label: "Show changes", icon: "branch", act: { type: "changes", repo } },
      { label: "Copy path", icon: "copy", act: { type: "copy", repo } },
    ];
  }

  static async urlItem(menu) {
    const url = await repoWebPage(menu.path);
    return url ? { label: "Open repository", icon: "external", act: { type: "url", url } } : null;
  }

  static showChanges(repo) {
    setActive({ path: repo.path, name: baseName(repo.path) });
    run("layout.select", { stack: HerdrVscodePending.STACK, child: "scm" });
    run("layout.show", { id: HerdrVscodePending.SIDEBAR });
  }

  static fire(act, cx) {
    const actions = {
      space: () => {
        const space = HerdrVscodePending.spaceAt(act.repo.path);
        run(space ? "space.select" : "space.new", space ? { id: space.id } : { folder: act.repo.path, name: baseName(act.repo.path) });
      },
      tab: () => run("tab.new", { folder: act.repo.path }),
      changes: () => HerdrVscodePending.showChanges(act.repo),
      copy: () => {
        cx.write_to_clipboard(act.repo.path);
        toast("herdr-vscode-pending", { title: "Path copied", body: act.repo.path, timeout: HerdrVscodePending.COPIED_TOAST_MS });
      },
      url: () => exec("open", [act.url]).catch((error) => toast("herdr-vscode-pending", { title: "Couldn't open the repository", body: String(error), level: "error" })),
    };
    actions[act.type]?.();
  }

  init(given, cx) {
    const options = props() ?? given ?? {};
    if (options.menu) {
      this.menu = new ContextMenu(options.menu, HerdrVscodePending.fire, cx, { later: HerdrVscodePending.urlItem, laterAt: HerdrVscodePending.URL_ITEM_AT });
      return;
    }
    loadIcons(this, cx);
    this.result = null;
    this.error = null;
    this.scanning = false;
    this.scannedAt = null;
    this.wasShown = false;
    if (checking()) {
      return;
    }
    this.scan(cx);
    cx.timer.every(HerdrVscodePending.REFRESH_MS, (cx) => this.scan(cx));
    cx.timer.every(HerdrVscodePending.SHOWN_POLL_MS, (cx) => this.rescanWhenShown(cx));
    cx.timer.every(HerdrVscodePending.AGO_TICK_MS, (cx) => cx.notify());
    cx.spawn(async (cx) => {
      for (;;) {
        if ((await nextCommand()) === "refresh") {
          this.scan(cx);
        }
      }
    });
  }

  // Each time the view comes into sight it scans again.
  rescanWhenShown(cx) {
    const shown = findNode(layout(), HerdrVscodePending.STACK)?.active === HerdrVscodePending.VIEW_ID;
    if (shown && !this.wasShown) {
      this.scan(cx);
    }
    this.wasShown = shown;
  }

  scan(cx) {
    if (this.scanning) {
      return;
    }
    this.scanning = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const { script, root } = await HerdrVscodePending.scanSettings();
      this.root = root;
      const result = await exec("python3", ["-I", script, "--json", "--root", root], { timeout: HerdrVscodePending.SCAN_TIMEOUT_MS })
        .catch((error) => ({ code: -1, stdout: "", stderr: String(error?.message ?? error) }));
      const parsed = result.code === 0 ? parseAudit(result.stdout) : { error: result.stderr.trim() || `repo-pending-audit exited ${result.code}` };
      this.error = parsed.error ?? null;
      if (!parsed.error) {
        this.result = parsed;
        this.scannedAt = Date.now();
      }
      const badge = this.result?.repos.length || null;
      if (shared(HerdrVscodePending.BADGE_KEY) !== badge) {
        setShared(HerdrVscodePending.BADGE_KEY, badge);
      }
      this.scanning = false;
      cx.notify();
    });
  }

  row(t, repo) {
    return h_flex().id(`repo-${repo.path}`).h(HerdrVscodePending.ROW_PX).flex_none().px(10).gap(6).items_center().cursor_pointer()
      .tooltip(repo.path)
      .hover((style) => style.bg(t.hover))
      .on_click(() => HerdrVscodePending.showChanges(repo))
      .on_mouse_down("right", (_event, cx) => {
        cx.stop_propagation();
        ContextMenu.open(HerdrVscodePending.MOD, { title: repo.rel, subtitle: repo.path, path: repo.path, items: HerdrVscodePending.menuItems(repo) }, 1);
      })
      .child(FileIcon(this.icons, repo.path, { dir: true, size: HerdrVscodePending.ICON_PX }))
      .child(div().flex_none().max_w(160).truncate().child(repo.rel))
      .child(div().flex_none().text_size(TEXT.caption).text_color(t.ansi6 ?? t.muted).child(repo.branch))
      .child(h_flex().flex_1().min_w(0).gap(5).overflow_hidden().text_size(TEXT.caption)
        .children(repo.markers.map((marker) => div().flex_none().text_color(HerdrVscodePending.markerColor(marker.kind, t)).child(marker.text))));
  }

  header(t) {
    const summary = this.result ? summaryText(this.result) : `Scanning ${this.root ?? HerdrVscodePending.DEFAULT_ROOT}…`;
    const ago = this.scannedAt ? `scanned ${timeAgo(this.scannedAt)} ago` : "";
    return h_flex().h(30).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border)
      .child(div().flex_none().font_medium().child(summary))
      .child(div().flex_1().min_w(0).truncate().text_size(TEXT.caption).text_color(t.dim).child(ago))
      .child(IconButton({ id: "pending-refresh", icon: "refresh", label: "Scan again", spinning: this.scanning, onClick: (cx) => this.scan(cx) }));
  }

  render() {
    if (this.menu) {
      return this.menu.render();
    }
    const t = theme();
    const repos = this.result?.repos ?? [];
    return v_flex().id(HerdrVscodePending.MOD).size_full().bg(t.chrome).text_size(TEXT.small).text_color(t.foreground)
      .child(this.header(t))
      .when(Boolean(this.error), (el) => el.child(Message(this.error, true)))
      .child(v_flex().id("pending-body").flex_1().min_h(0).overflow_y_scrollbar()
        .when(Boolean(this.result) && repos.length === 0, (el) => el.child(Message("Every repo is committed and pushed.")))
        .children(repos.map((repo) => this.row(t, repo))));
  }
}

export default HerdrVscodePending;
