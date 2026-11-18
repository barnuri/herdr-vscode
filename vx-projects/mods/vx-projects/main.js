import { logError } from "./log.js";
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { theme, spaces, panes, run, exec, home, readTextFile, writeTextFile, checking, nextCommand, notify, props } from "herdr";
import { focusInfo } from "./ws.js";
import { showInViewer } from "./tabs.js";
import { TEXT, Icon, IconButton, FileIcon, Dot } from "./ui.js";
import { loadIcons } from "./icons.js";
import ProjectsMenu from "./projects-menu.js";
import {
  CONFIG_FILE, CACHE_FILE, DEFAULT_CONFIG, MANUAL, normalizeConfig, addManualProject, removeManualProject, pickCache, discovered, mergeProjects,
  sortProjects, parseConfigText, fuzzyFilter, spaceFor, busyPaths, discoveryPlan, findArgs, findMatches, baseName,
} from "./projects-core.js";

class VxProjects extends View {
  static MOD = "vx-projects";
  static ROW_PX = 24;
  static ICON_PX = 14;
  static REFRESH_MS = 300000;
  static OPEN_REFRESH_MS = 1500;
  static DISCOVER_TIMEOUT_MS = 300000;
  static FILES_MOD = "vx-files";
  static REMOVE_PREFIX = "remove:";
  static SCRIPT_NAME = "vx-projects";
  // zsh: each argument is a glob pattern (~ already expanded); prints every match.
  static DISCOVER_SCRIPT = 'setopt null_glob extended_glob; for g in "$@"; do print -rl -- ${~g}; done';

  static statusColor(space, colors) {
    const byStatus = { working: colors.working, blocked: colors.blocked, done: colors.done, idle: colors.idle };
    return byStatus[space?.status] ?? colors.ansi2;
  }

  // A vx-files tab of the shown space already named after the config file.
  static openConfigTab(name) {
    const space = spaces().find((candidate) => candidate.active);
    const fileTabs = new Set(panes().filter((pane) => pane.mod === VxProjects.FILES_MOD).map((pane) => pane.tab));
    return space?.tabs.find((tab) => tab.name === name && fileTabs.has(tab.id))?.id ?? null;
  }

  static parse(text) {
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  init(given, cx) {
    const options = props() ?? given ?? {};
    if (options.menu) {
      this.menu = new ProjectsMenu(options.menu, (project, asTab) => this.open(project, asTab), cx);
      return;
    }
    loadIcons(this, cx);
    this.projects = [];
    this.selected = 0;
    this.scanning = false;
    this.error = null;
    this.filter = InputState.new({ placeholder: "Filter projects" });
    this.filter.on("change", (_event, cx) => {
      this.selected = 0;
      cx.notify();
    });
    this.filter.on("submit", () => this.openSelected(false));
    if (checking()) {
      return;
    }
    this.load(cx);
    cx.timer.every(VxProjects.REFRESH_MS, (cx) => this.discover(cx));
    cx.timer.every(VxProjects.OPEN_REFRESH_MS, (cx) => cx.notify());
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") {
          this.filter.focus();
        }
        if (command === "config") {
          this.editConfig(cx);
        }
        if (command === "context-menu" && this.shown()[this.selected]) {
          ProjectsMenu.open(this.shown()[this.selected]);
        }
        if (command.startsWith(VxProjects.REMOVE_PREFIX)) {
          this.removeManual({ path: command.slice(VxProjects.REMOVE_PREFIX.length) }, cx);
        }
        cx.notify();
      }
    });
  }

  path(file) {
    return `${home()}/${file}`;
  }

  async readConfig() {
    const text = await readTextFile(this.path(CONFIG_FILE)).catch(() => null);
    return { text, ...parseConfigText(text) };
  }

  // The cache paints at once; discovery then replaces it.
  load(cx) {
    cx.spawn(async (cx) => {
      const cached = pickCache(VxProjects.parse(await readTextFile(this.path(CACHE_FILE)).catch(() => null)));
      if (cached.length && this.projects.length === 0) {
        this.projects = cached;
        cx.notify();
      }
      this.discover(cx);
    });
  }

  discover(cx) {
    if (this.scanning) {
      return;
    }
    this.scanning = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const read = await this.readConfig();
        if (read.error) {
          throw new Error(`~/${CONFIG_FILE} is not valid JSON (${read.error}); the list is kept until it is fixed.`);
        }
        const config = normalizeConfig(read.raw, home());
        const matches = await this.globMatches(config);
        const next = mergeProjects(config.projects, discovered(matches, config.excludes, home()));
        if (JSON.stringify(next) !== JSON.stringify(this.projects)) {
          this.projects = next;
          await this.saveCache(next);
        }
      } catch (error) {
        this.error = String(error?.message ?? error);
        logError("vx-projects", "discovery failed", this.error);
      }
      this.scanning = false;
      cx.notify();
    });
  }

  // Every glob at once; a failed glob is reported and the others still count.
  async globMatches(config) {
    const plan = discoveryPlan(config.globs, config.excludes, home());
    const runs = [
      ...plan.finds.map(async (find) => findMatches(await this.execChecked("find", findArgs(find.root, plan.prunes), find.glob), find.glob)),
      ...plan.shell.map(async (glob) => (await this.execChecked("zsh", ["-fc", VxProjects.DISCOVER_SCRIPT, VxProjects.SCRIPT_NAME, glob], glob)).split("\n")),
    ];
    const results = await Promise.allSettled(runs);
    const failures = results.filter((result) => result.status === "rejected").map((result) => String(result.reason?.message ?? result.reason));
    this.error = failures.length ? `Discovery failed: ${failures.join("\n")}` : null;
    if (this.error) {
      logError("vx-projects", this.error);
    }
    return results.flatMap((result) => (result.status === "fulfilled" ? result.value.filter(Boolean) : []));
  }

  // find exits 1 on an unreadable folder but still prints the rest: only no output is a failure.
  async execChecked(command, args, label) {
    const result = await exec(command, args, { timeout: VxProjects.DISCOVER_TIMEOUT_MS });
    if (result.code !== 0 && !result.stdout.trim()) {
      throw new Error(`${label}: ${result.stderr.trim() || `${command} exited ${result.code}`}`);
    }
    return result.stdout;
  }

  async saveCache(projects) {
    const file = this.path(CACHE_FILE);
    const previous = await readTextFile(file).catch(() => null);
    await this.ensureFolder(file);
    await writeTextFile(file, `${JSON.stringify(projects)}\n`, previous).catch((error) => logError("vx-projects", "cache not saved", String(error)));
  }

  async ensureFolder(file) {
    await exec("mkdir", ["-p", file.replace(/\/[^/]*$/, "")]).catch(() => null);
  }

  // Applies `change` to the raw config and writes it back with every other key kept.
  editConfigFile(change, done, cx) {
    cx.spawn(async (cx) => {
      const { text, raw, error } = await this.readConfig();
      const file = this.path(CONFIG_FILE);
      if (error) {
        notify({ title: "projects.json is not valid JSON", body: `Fix it first: ${error}`, level: "error" });
        return;
      }
      try {
        await this.ensureFolder(file);
        await writeTextFile(file, `${JSON.stringify(change(raw ?? DEFAULT_CONFIG), null, 2)}\n`, text);
        notify({ ...done, level: "success" });
      } catch (error) {
        notify({ title: "Couldn't change projects.json", body: String(error?.message ?? error), level: "error" });
      }
      this.discover(cx);
    });
  }

  addCurrent(cx) {
    const cwd = focusInfo().cwd ?? spaces().find((space) => space.active)?.folder;
    if (!cwd) {
      notify({ title: "No folder to add", body: "Focus a terminal in the project first." });
      return;
    }
    this.editConfigFile((raw) => addManualProject(raw, cwd), { title: "Project added", body: cwd }, cx);
  }

  removeManual(project, cx) {
    this.editConfigFile((raw) => removeManualProject(raw, project.path), { title: "Project removed", body: project.path }, cx);
  }

  // Opens projects.json in the vx-files viewer, in Edit mode (⌘S saves).
  editConfig(cx) {
    cx.spawn(async () => {
      const file = this.path(CONFIG_FILE);
      if ((await this.readConfig()).text === null) {
        await this.ensureFolder(file);
        await writeTextFile(file, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, null).catch(() => null);
      }
      const open = VxProjects.openConfigTab(baseName(file));
      if (open) {
        run("tab.select", { id: open });
        return;
      }
      const root = file.replace(/\/[^/]*$/, "");
      showInViewer(VxProjects.FILES_MOD, { root, on: null, rel: baseName(file), edit: true }, baseName(file));
    });
  }

  shown() {
    return fuzzyFilter(sortProjects(this.projects), this.filter.value());
  }

  // As a space: the one already working there, else a new one.
  open(project, asTab) {
    if (asTab) {
      run("tab.new", { folder: project.path });
      return;
    }
    const space = spaceFor(project, spaces());
    if (space) {
      run("space.select", { id: space.id });
      return;
    }
    run("space.new", { folder: project.path, name: project.name });
  }

  openSelected(asTab) {
    const project = this.shown()[this.selected];
    if (project) {
      this.open(project, asTab);
    }
  }

  onKey(event, cx) {
    const moves = { down: 1, up: -1 };
    if (!(event.key in moves)) {
      return;
    }
    const last = Math.max(0, this.shown().length - 1);
    this.selected = Math.min(last, Math.max(0, this.selected + moves[event.key]));
    cx.stop_propagation();
    cx.notify();
  }

  row(project, index, context) {
    const { colors, allSpaces, busy } = context;
    const space = spaceFor(project, allSpaces);
    const working = busy.has(project.path);
    return h_flex().id(`proj-${project.path}`).h(VxProjects.ROW_PX).flex_none().px(10).gap(6).items_center().cursor_pointer()
      .tooltip(project.path)
      .when(index === this.selected, (el) => el.bg(colors.selected))
      .hover((style) => style.bg(colors.hover))
      .on_click((_event, cx) => {
        this.selected = index;
        this.open(project, false);
        cx.notify();
      })
      .on_mouse_down("right", (_event, cx) => {
        cx.stop_propagation();
        ProjectsMenu.open(project);
      })
      .child(FileIcon(this.icons, project.path, { dir: true, open: Boolean(space), size: VxProjects.ICON_PX }))
      .child(div().flex_1().min_w(0).truncate().text_color(space ? colors.foreground : colors.muted).child(project.name))
      .when(Boolean(space) || working, (el) => el.child(Dot(space ? VxProjects.statusColor(space, colors) : colors.dim)))
      .when(project.source === MANUAL, (el) => el.child(IconButton({ id: `rm-${project.path}`, icon: "x", label: "Remove this pinned project",
        onClick: (cx) => this.removeManual(project, cx) })))
      .child(IconButton({ id: `tab-${project.path}`, icon: "plus", label: "Open as a new tab here", onClick: () => this.open(project, true) }));
  }

  toolbar(colors) {
    return h_flex().h(30).flex_none().px(6).gap(2).items_center().border_b(1).border_color(colors.border)
      .child(Icon("search", 12).text_color(colors.dim).ml(4))
      .child(Input.new(this.filter).flex_1().h(24).text_size(TEXT.small))
      .child(IconButton({ id: "add", icon: "plus", label: "Add the focused folder as a project", onClick: (cx) => this.addCurrent(cx) }))
      .child(IconButton({ id: "edit", icon: "gear", label: "Edit projects.json (globs, excludes, projects)", onClick: (cx) => this.editConfig(cx) }))
      .child(IconButton({ id: "refresh", icon: "refresh", label: "Discover again", spinning: this.scanning, onClick: (cx) => this.discover(cx) }));
  }

  emptyText() {
    if (this.projects.length === 0) {
      return this.scanning ? "Looking for projects…" : `No projects. Add globs such as "~/src/*/.git" to ~/${CONFIG_FILE}, or + to add the focused folder.`;
    }
    return "No project matches.";
  }

  render() {
    if (this.menu) {
      return this.menu.render();
    }
    const colors = theme();
    const shown = this.shown();
    const allSpaces = spaces();
    const context = { colors, allSpaces, busy: busyPaths(shown, panes()) };
    return v_flex().id(VxProjects.MOD).size_full().bg(colors.chrome).text_size(TEXT.small).text_color(colors.foreground)
      .on_key_down((event, cx) => this.onKey(event, cx))
      .child(this.toolbar(colors))
      .when(Boolean(this.error), (el) => el.child(div().px(12).py(6).text_size(TEXT.caption).text_color(colors.ansi1).whitespace_normal().child(this.error)))
      .child(v_flex().id("projects-body").flex_1().min_h(0).overflow_y_scrollbar()
        .when(shown.length === 0, (el) => el.child(div().p(12).text_color(colors.dim).whitespace_normal().child(this.emptyText())))
        .children(shown.map((project, index) => this.row(project, index, context))))
      .child(h_flex().h(22).flex_none().px(10).items_center().border_t(1).border_color(colors.border).text_size(TEXT.caption).text_color(colors.dim)
        .child(`${shown.length} of ${this.projects.length}${this.scanning ? " · scanning…" : ""} · Enter: open · right-click: menu`));
  }
}

export default VxProjects;
