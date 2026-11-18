import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, updates, agents, checking, nextCommand } from "herdr";
import { TEXT, Icon, Button, Badge, SectionHead } from "./ui.js";
import { timeAgo } from "./git-core.js";
import { UPDATE_CONFIG_FILE, UPDATE_TOGGLES, readUpdateConfig, appPlan, corePlan, waitingNotes, busyAgents } from "./updates-core.js";
import UpdatesWorker from "./updates-worker.js";

class HerdrVscodeUpdates extends View {
  static MOD = "herdr-vscode-updates";
  static REFRESH_MS = 2000;
  static MS_PER_SECOND = 1000;
  static TOGGLE_LABELS = {
    autoUpdateApp: "Restart into app updates",
    autoUpdateCore: "Install herdr-core updates",
    autoUpdatePatches: "Patch versions (1.2.x)",
    autoUpdateMinors: "Minor versions (1.x)",
    autoUpdateMajors: "Major versions",
  };
  static PLAN_TEXT = {
    none: "up to date",
    skip: "ready, not installed automatically",
    wait: "ready, waiting for agents",
    update: "ready, installing",
    managed: "managed by a package manager",
    busy: "updating now",
  };

  init(_props, cx) {
    this.config = readUpdateConfig(null);
    this.dryRun = false;
    if (checking()) {
      return;
    }
    this.worker = new UpdatesWorker();
    this.worker.start(cx);
    this.reload(cx);
    cx.timer.every(HerdrVscodeUpdates.REFRESH_MS, (cx) => this.reload(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "check") {
          UpdatesWorker.checkNow();
        }
        cx.notify();
      }
    });
  }

  reload(cx) {
    cx.spawn(async (cx) => {
      this.config = await UpdatesWorker.readConfigFile();
      this.dryRun = await UpdatesWorker.dryRun();
      cx.notify();
    });
  }

  setToggle(key, cx) {
    cx.spawn(async (cx) => {
      await UpdatesWorker.toggle(key);
      this.reload(cx);
    });
  }

  act(command, what) {
    UpdatesWorker.act(command, what);
  }

  versionRow(t, label, version, plan, ready) {
    const color = { none: t.dim, update: t.accent, wait: t.ansi3, skip: t.muted, busy: t.ansi4, managed: t.dim }[plan.action] ?? t.dim;
    return h_flex().h(24).px(12).gap(8).items_center()
      .child(div().w(44).flex_none().text_color(t.muted).child(label))
      .child(div().flex_none().font_semibold().child(version ?? "–"))
      .when(Boolean(ready), (el) => el.child(div().flex_none().text_color(t.accent).child(`↑ ${ready}`)))
      .when(Boolean(plan.kind), (el) => el.child(Badge(plan.kind)))
      .child(div().flex_1().min_w(0).truncate().text_size(TEXT.caption).text_color(color).child(HerdrVscodeUpdates.PLAN_TEXT[plan.action] ?? ""));
  }

  toggleRow(t, key) {
    const on = this.config.config[key];
    return h_flex().id(`toggle-${key}`).h(24).px(12).gap(8).items_center().cursor_pointer().hover((style) => style.bg(t.hover))
      .on_click((_event, cx) => this.setToggle(key, cx))
      .child(div().size(14).flex_none().rounded(3).border_1().border_color(on ? t.accent : t.border).bg(on ? t.accent : t.background)
        .flex().items_center().justify_center().when(on, (el) => el.child(Icon("check", 11).text_color(t.accent_foreground ?? t.background))))
      .child(div().flex_1().truncate().child(HerdrVscodeUpdates.TOGGLE_LABELS[key]));
  }

  noteBlock(t, note) {
    return v_flex().px(12).py(4).gap(2)
      .child(div().text_size(TEXT.caption).font_semibold().text_color(t.foreground).child(`${note.version}${note.date ? ` · ${note.date}` : ""}`))
      .children(note.items.map((item) => v_flex().pl(8)
        .child(div().text_size(TEXT.caption).text_color(t.foreground).whitespace_normal().child(`• ${item.headline}`))
        .when(Boolean(item.detail), (el) => el.child(div().pl(10).text_size(TEXT.caption).text_color(t.dim).whitespace_normal().child(item.detail)))));
  }

  checkedText(info) {
    if (info.checking) {
      return "Checking…";
    }
    if (!info.checks) {
      return "This build never updates (built from source).";
    }
    return info.checked ? `Checked ${timeAgo(info.checked * HerdrVscodeUpdates.MS_PER_SECOND)} ago` : "Not checked yet";
  }

  buttons(info, busy) {
    const coreReady = Boolean(info.core?.ready) && !info.core?.managed && !info.core?.updating;
    const restart = busy > 0 ? `Restart anyway (${busy} busy)` : "Restart to update";
    return h_flex().px(12).py(8).gap(6).flex_wrap()
      .child(Button({ id: "check", label: "Check now", icon: "refresh", disabled: info.checking || !info.checks, onClick: () => UpdatesWorker.checkNow() }))
      .child(Button({ id: "core", label: "Update core", disabled: !coreReady, onClick: () => this.act("app.update_core", `core ${info.core.ready}`) }))
      .child(Button({ id: "restart", label: restart, primary: true, disabled: !info.app?.ready, onClick: () => this.act("app.update", `app ${info.app.ready}`) }));
  }

  render() {
    const t = theme();
    const info = updates();
    const config = this.config.config;
    const app = appPlan(info, config, agents() ?? []);
    const core = corePlan(info, config);
    const busy = busyAgents(agents() ?? []).length;
    const notes = waitingNotes(info);
    const status = UpdatesWorker.status().text;
    return v_flex().id(HerdrVscodeUpdates.MOD).size_full().bg(t.chrome).text_size(TEXT.small).text_color(t.foreground).overflow_y_scrollbar()
      .child(div().h(6).flex_none())
      .child(this.versionRow(t, "App", info.app?.version, app, info.app?.ready))
      .child(this.versionRow(t, "Core", info.core?.version, core, info.core?.ready))
      .when(Boolean(info.core?.error), (el) => el.child(div().px(12).text_size(TEXT.caption).text_color(t.ansi1).whitespace_normal().child(info.core.error)))
      .child(div().px(12).py(2).text_size(TEXT.caption).text_color(t.dim).child(this.checkedText(info)))
      .when(Boolean(status), (el) => el.child(div().px(12).py(2).text_size(TEXT.caption).text_color(t.ansi3).whitespace_normal().child(status)))
      .child(this.buttons(info, busy))
      .when(notes.length > 0, (el) => el.child(SectionHead("What's new", notes.length)).children(notes.map((note) => this.noteBlock(t, note))))
      .child(SectionHead("Automatic updates"))
      .when(Boolean(this.config.error), (el) => el.child(div().px(12).text_size(TEXT.caption).text_color(t.ansi1).whitespace_normal()
        .child(`config.json is not valid JSON (${this.config.error}); defaults are used.`)))
      .children(UPDATE_TOGGLES.map((key) => this.toggleRow(t, key)))
      .child(div().px(12).py(4).text_size(TEXT.caption).text_color(t.dim).whitespace_normal()
        .child(`Checks every ${config.checkIntervalMinutes} min (checkIntervalMinutes, at least 15). Shared with the herdr-auto-update plugin: ~/${UPDATE_CONFIG_FILE}`));
  }
}

export default HerdrVscodeUpdates;
