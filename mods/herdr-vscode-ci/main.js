import { View, div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { theme, props, closeOverlay, layout, run, checking, setShared, shared, readTextFile, exec, home } from "herdr";
import { ctx, contextKey, repoTop, changedAt, workspace, baseName, git } from "./ws.js";
import { parseLog, LOG_FORMAT } from "./git-core.js";
import { byStage, duration, since, isDone, gitlabVariables } from "./ci-core.js";
import { findNode } from "./layout-core.js";
import { resolveProject } from "./providers.js";
import { askConfirm, confirmMethods } from "./actions.js";
import { TEXT, Icon, IconButton, Badge, Button, Message, ConfirmView, stateLook, codeFont } from "./ui.js";
import { RepoButton, RepoMenu } from "./repo-picker.js";
import { loadIcons } from "./icons.js";
import { toast, logError } from "./log.js";
import { getSetting, setSetting, whenSettings } from "./settings.js";

export default class HerdrVscodeCi extends View {
  static MOD = "herdr-vscode-ci";
  static FOLLOW_MS = 400;
  static LIST_MS = 30000;
  static LIVE_MS = 5000;
  static SUMMARY_MS = 60000;
  static FIRST_SUMMARY_MS = 3000;
  static SUBJECT_LOG_DEPTH = "300";
  static SHORT_SHA_LENGTH = 8;
  static BYTES_PER_KB = 1024;
  static TRANSPARENT = "#00000000";
  static SUMMARY_KEY = "herdr-vscode.ci.summary";
  static GIT_KEY = "herdr-vscode.git";
  static NOT_A_REPO = "Not a git repository. Pick a repo in Workspace.";
  static GITLAB = "gitlab";
  static ALL = "all";
  static FAILED_KINDS = ["failure", "warning"];
  static RETRYABLE_JOB_KINDS = ["failure", "warning", "canceled", "success"];
  static FILTERS = [["all", "All"], ["running", "Running"], ["failure", "Failed"], ["success", "Passed"]];

  static {
    Object.assign(HerdrVscodeCi.prototype, confirmMethods);
  }

  static matchesFilter(ciRun, filter) {
    if (filter === HerdrVscodeCi.ALL) {
      return true;
    }
    if (filter === "failure") {
      return HerdrVscodeCi.FAILED_KINDS.includes(ciRun.kind);
    }
    return ciRun.kind === filter;
  }

  static elapsedSeconds(ciRun) {
    if (!ciRun.started) {
      return null;
    }
    const end = ciRun.finished ? Date.parse(ciRun.finished) : Date.now();
    return (end - Date.parse(ciRun.started)) / 1000;
  }

  static parseExtraVariables(text) {
    return text.split(",").map((pair) => pair.trim()).filter(Boolean)
      .map((pair) => ({ key: pair.split("=")[0].trim(), value: pair.slice(pair.indexOf("=") + 1).trim() }))
      .filter((variable) => variable.key);
  }

  static openUrl(url) {
    exec("open", [url]).catch(() => {});
  }

  init(given, cx) {
    const initProps = props() ?? given ?? {};
    if (initProps.repoMenu) {
      this.repoMenu = initProps.repoMenu;
      loadIcons(this, cx);
      return;
    }
    if (initProps.confirm) {
      this.confirmSpec = initProps.confirm;
      this.confirmOverlay = initProps.overlay;
      this.confirmFocus = cx.focus_handle();
      this.confirmFocus.focus();
      return;
    }
    if (initProps.overlay && !initProps.panel) {
      if (!checking()) {
        this.toggle(initProps.overlay);
      }
      this.toggleOnly = true;
      return;
    }
    loadIcons(this, cx);
    this.tops = new Map();
    this.projects = new Map();
    this.subjects = new Map();
    // Before settings.json the filter and "mine" lived in localStorage: still the defaults.
    this.filter = getSetting("ci", "filter", localStorage.getItem("filter") ?? HerdrVscodeCi.ALL);
    this.mine = getSetting("ci", "mine", localStorage.getItem("mine") !== "0") !== false;
    whenSettings(cx, (cx) => {
      this.filter = getSetting("ci", "filter", this.filter);
      const mine = getSetting("ci", "mine", this.mine) !== false;
      if (mine !== this.mine) {
        this.mine = mine;
        this.runs = null;
        this.loadRuns(cx);
      }
    });
    this.tab = "runs";
    if (checking()) {
      return;
    }
    cx.timer.every(HerdrVscodeCi.FOLLOW_MS, (cx) => this.follow(cx));
    cx.timer.every(HerdrVscodeCi.LIST_MS, (cx) => this.loadRuns(cx));
    cx.timer.every(HerdrVscodeCi.LIVE_MS, (cx) => this.live(cx));
    cx.timer.every(HerdrVscodeCi.SUMMARY_MS, (cx) => this.summarize(cx));
    cx.timer.after(HerdrVscodeCi.FIRST_SUMMARY_MS, (cx) => this.summarize(cx));
  }

  toggle(overlay) {
    try {
      this.togglePanel();
    } finally {
      closeOverlay(overlay);
    }
  }

  togglePanel() {
    const root = layout();
    const panel = findNode(root, "panel");
    const body = findNode(root, "panel-body");
    if (!panel || !body || !findNode(body, "ci")) {
      toast("herdr-vscode-ci", { title: "No CI panel in this layout", level: "warning" });
      return;
    }
    if (!panel.hidden && body.active === "ci") {
      run("layout.hide", { id: "panel" });
      return;
    }
    run("layout.select", { stack: "panel-body", child: "ci" });
    run("layout.show", { id: "panel" });
  }

  follow(cx) {
    const context = ctx();
    const key = contextKey(context);
    if (key === this.key) {
      return;
    }
    this.key = key;
    this.source = context.source;
    this.detail = null;
    this.runs = null;
    this.error = null;
    cx.spawn(async (cx) => {
      const top = context.cwd ? await repoTop(this.tops, context.cwd, context.on) : null;
      if (this.key !== key) {
        return;
      }
      this.top = top;
      this.on = context.on;
      if (!top) {
        this.project = null;
        this.error = HerdrVscodeCi.NOT_A_REPO;
        cx.notify();
        return;
      }
      const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: top, on: context.on }).catch(() => null);
      this.branch = branch?.code === 0 ? branch.stdout.trim() : null;
      this.project = await this.projectFor(top, context.on);
      if (this.key !== key) {
        return;
      }
      if (this.project.error) {
        this.error = this.project.error;
      }
      this.loadRuns(cx);
      cx.notify();
    });
  }

  async projectFor(top, on) {
    if (!this.projects.has(top)) {
      this.projects.set(top, await resolveProject(top, on));
    }
    return this.projects.get(top);
  }

  // GitLab's pipeline list has no titles, so commit subjects come from the local repo.
  async learnSubjects(top, on) {
    const log = await git(["log", "-n", HerdrVscodeCi.SUBJECT_LOG_DEPTH, "--all", LOG_FORMAT], { cwd: top, on }).catch(() => null);
    if (log?.code !== 0) {
      return;
    }
    for (const commit of parseLog(log.stdout)) {
      this.subjects.set(commit.hash, commit.subject);
    }
  }

  loadRuns(cx) {
    const project = this.project;
    if (!project || project.error || this.loadingRuns) {
      return;
    }
    this.loadingRuns = true;
    const key = this.key;
    cx.spawn(async (cx) => {
      try {
        const [runs] = await Promise.all([project.runs({ ref: this.mine ? this.branch : null }), this.learnSubjects(this.top, this.on)]);
        if (this.key !== key) {
          return;
        }
        this.runs = runs;
        this.error = null;
      } catch (error) {
        logError("herdr-vscode-ci", "runs load failed", String(error?.message ?? error));
        if (this.key === key) {
          this.error = error.message;
        }
      } finally {
        this.loadingRuns = false;
        cx.notify();
      }
    });
  }

  openRun(ciRun, cx) {
    this.detail = { run: ciRun, jobs: null };
    this.loadDetail(cx);
    cx.notify();
  }

  loadDetail(cx) {
    const detail = this.detail;
    const project = this.project;
    if (!detail || !project || this.loadingDetail) {
      return;
    }
    this.loadingDetail = true;
    cx.spawn(async (cx) => {
      try {
        const [ciRun, jobs] = await Promise.all([project.run(detail.run.id), project.jobs(detail.run.id)]);
        if (this.detail?.run.id !== detail.run.id) {
          return;
        }
        this.detail = { run: ciRun, jobs, artifacts: project.artifacts ?? [] };
      } catch (error) {
        logError("herdr-vscode-ci", "run detail failed", String(error?.message ?? error));
        if (this.detail) {
          this.detail.error = error.message;
        }
      } finally {
        this.loadingDetail = false;
        cx.notify();
      }
    });
  }

  live(cx) {
    if (changedAt() !== this.seenChange) {
      this.seenChange = changedAt();
      this.loadRuns(cx);
    }
    if (this.detail && !isDone(this.detail.run.kind)) {
      this.loadDetail(cx);
    } else if ((this.runs ?? []).some((ciRun) => !isDone(ciRun.kind))) {
      this.loadRuns(cx);
    }
  }

  summarize(cx) {
    const roots = workspace()?.roots ?? [];
    const gitSummary = shared(HerdrVscodeCi.GIT_KEY) ?? {};
    if (!roots.length || this.summarizing) {
      return;
    }
    this.summarizing = true;
    cx.spawn(async () => {
      const summary = { ...(shared(HerdrVscodeCi.SUMMARY_KEY) ?? {}) };
      try {
        for (const root of roots) {
          await this.summarizeRoot(root, gitSummary[root.path]?.branch, summary);
        }
        setShared(HerdrVscodeCi.SUMMARY_KEY, summary);
      } finally {
        this.summarizing = false;
      }
    });
  }

  async summarizeRoot(root, branch, summary) {
    if (!branch) {
      return;
    }
    const project = await this.projectFor(root.path, null);
    if (project.error) {
      return;
    }
    try {
      const [latest] = await project.runs({ ref: branch, per: 1 });
      summary[root.path] = latest ? { kind: latest.kind, label: latest.label, url: latest.url, number: latest.number, at: Date.now() } : null;
    } catch {}
  }

  isGitLab() {
    return this.project.provider === HerdrVscodeCi.GITLAB;
  }

  confirm(title, detail, label, action, danger = false) {
    askConfirm(HerdrVscodeCi.MOD, { title, detail, label, danger, action: { ...action, root: this.top } });
  }

  retry(ciRun) {
    const noun = this.isGitLab() ? "pipeline" : "run";
    this.confirm(`Retry ${noun} #${ciRun.number}?`, `${ciRun.title ?? ""} on ${ciRun.ref}. Failed and cancelled jobs run again.`, "Retry", this.project.retrySpec(ciRun));
  }

  cancel(ciRun) {
    this.confirm(`Cancel #${ciRun.number}?`, `Stops every running job of ${ciRun.ref}.`, "Cancel run", this.project.cancelSpec(ciRun), true);
  }

  jobAction(job, verb) {
    const verbLabel = verb === "play" ? "Start" : "Retry";
    this.confirm(`${verbLabel} job ${job.name}?`, null, verbLabel, this.project.jobSpec(job, verb));
  }

  download(ciRun, artifact) {
    const dir = `${home()}/Downloads/herdr-vscode-ci/${baseName(this.project.path)}/${ciRun.number}`;
    this.confirm(`Download ${artifact.name} artifacts?`, `Into ${dir.replace(home(), "~")}`, "Download", this.project.artifactSpec(ciRun, artifact, dir));
  }

  // The form's text boxes are created here, on a click, never during a render.
  openStart(cx) {
    this.tab = "start";
    const ref = InputState.new({ value: this.branch ?? this.project.defaultBranch ?? "" });
    this.form = { ref, vars: [], workflows: null, workflow: null };
    cx.spawn(async (cx) => {
      if (this.isGitLab()) {
        const yaml = await readTextFile(`${this.top}/.gitlab-ci.yml`, { on: this.on }).catch(() => null);
        this.form.vars = gitlabVariables(yaml)
          .filter((variable) => variable.description)
          .map((variable) => ({ ...variable, state: InputState.new({ value: variable.value ?? "" }) }));
      } else {
        this.form.workflows = await this.project.workflows().catch(() => []);
        this.form.workflow = this.form.workflows[0]?.id ?? null;
      }
      this.form.extra = InputState.new({ placeholder: "KEY=value, KEY2=value (optional)" });
      cx.notify();
    });
    cx.notify();
  }

  start() {
    const form = this.form;
    const ref = form.ref.value().trim();
    if (!ref) {
      toast("herdr-vscode-ci", { title: "Pick a branch", level: "warning" });
      return;
    }
    const extra = HerdrVscodeCi.parseExtraVariables(form.extra?.value() ?? "");
    const variables = [...form.vars.map((variable) => ({ key: variable.key, value: variable.state.value() })), ...extra];
    const isGitLab = this.isGitLab();
    if (!isGitLab && !form.workflow) {
      toast("herdr-vscode-ci", { title: "No workflow to dispatch", level: "warning" });
      return;
    }
    const workflow = form.workflows?.find((candidate) => candidate.id === form.workflow);
    this.confirm(
      isGitLab ? `Run a pipeline on ${ref}?` : `Dispatch ${workflow?.name ?? "workflow"} on ${ref}?`,
      variables.length ? variables.map((variable) => `${variable.key}=${variable.value}`).join("  ") : "No variables.",
      isGitLab ? "Run pipeline" : "Dispatch",
      this.project.startSpec({ ref, workflow: form.workflow, variables }),
    );
  }

  subjectOf(ciRun) {
    return this.subjects.get(ciRun.sha) ?? ciRun.title ?? `#${ciRun.number}`;
  }

  statusGlyph(t, kind, size = 12) {
    const look = stateLook(kind, t);
    return div().w(size + 4).flex_none().text_center().text_size(size).text_color(look.color).child(look.glyph);
  }

  runRow(t, ciRun) {
    const seconds = HerdrVscodeCi.elapsedSeconds(ciRun);
    return h_flex().id(`run-${ciRun.id}`).flex_none().mx(4).px(8).py(5).gap(8).items_start().rounded(6).cursor_pointer().hover((style) => style.bg(t.hover))
      .on_click((_e, cx) => this.openRun(ciRun, cx))
      .child(div().pt(1).child(this.statusGlyph(t, ciRun.kind)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_size(TEXT.small).text_color(t.foreground).child(this.subjectOf(ciRun)))
        .child(h_flex().gap(6).text_size(TEXT.caption).text_color(t.dim).min_w(0)
          .child(div().flex_none().child(`#${ciRun.number}`))
          .child(div().max_w(140).truncate().child(ciRun.ref ?? ""))
          .when(Boolean(ciRun.event), (el) => el.child(div().flex_none().child(ciRun.event.replace(/_/g, " "))))
          .child(div().flex_1())
          .child(div().flex_none().child(ciRun.kind === "running" ? duration(seconds) : since(ciRun.created)))));
  }

  filterChip(t, [id, label]) {
    const count = (this.runs ?? []).filter((ciRun) => HerdrVscodeCi.matchesFilter(ciRun, id)).length;
    const selected = this.filter === id;
    return h_flex().id(`flt-${id}`).h(22).px(8).gap(4).items_center().rounded(11).text_size(TEXT.caption).cursor_pointer()
      .bg(selected ? t.selected : HerdrVscodeCi.TRANSPARENT).text_color(selected ? t.foreground : t.dim).border_1().border_color(selected ? t.border : HerdrVscodeCi.TRANSPARENT)
      .hover((style) => style.bg(t.hover))
      .on_click((_e, cx) => {
        this.filter = id;
        setSetting("ci", "filter", id);
        cx.notify();
      })
      .child(label).child(div().text_color(t.dim).child(String(count)));
  }

  toggleMine(cx) {
    this.mine = !this.mine;
    setSetting("ci", "mine", this.mine);
    this.runs = null;
    this.loadRuns(cx);
    cx.notify();
  }

  renderRuns(t, body) {
    const runs = (this.runs ?? []).filter((ciRun) => HerdrVscodeCi.matchesFilter(ciRun, this.filter));
    body.child(h_flex().flex_none().px(10).py(6).gap(4).items_center()
      .children(HerdrVscodeCi.FILTERS.map((filter) => this.filterChip(t, filter)))
      .child(div().flex_1())
      .child(h_flex().id("mine").h(22).px(8).items_center().rounded(11).text_size(TEXT.caption).cursor_pointer()
        .text_color(this.mine ? t.accent : t.dim).hover((style) => style.bg(t.hover))
        .tooltip(this.mine ? `Only ${this.branch}` : "Every branch")
        .on_click((_e, cx) => this.toggleMine(cx))
        .child(this.mine ? this.branch ?? "branch" : "all branches")));
    const list = v_flex().id("runs").flex_1().min_h(0).overflow_y_scrollbar().pb(6);
    if (!this.runs) {
      list.child(Message("Loading…"));
    } else if (!runs.length) {
      list.child(Message(this.mine ? `No runs on ${this.branch} yet.` : "No runs."));
    } else {
      list.children(runs.map((ciRun) => this.runRow(t, ciRun)));
    }
    body.child(list);
  }

  detailHeader(t, ciRun) {
    const look = stateLook(ciRun.kind, t);
    const seconds = HerdrVscodeCi.elapsedSeconds(ciRun);
    return v_flex().flex_none().px(12).py(8).gap(6).border_b(1).border_color(t.border)
      .child(h_flex().gap(6).items_center()
        .child(IconButton({ id: "back", icon: "back", label: "Back to runs", size: 22, onClick: (cx) => {
          this.detail = null;
          cx.notify();
        } }))
        .child(div().text_color(look.color).font_medium().child(`${look.glyph} ${ciRun.label}`))
        .child(div().text_size(TEXT.caption).text_color(t.dim).child(`#${ciRun.number}`))
        .child(div().flex_1())
        .child(IconButton({ id: "web", icon: "external", label: "Open in browser", size: 22, onClick: () => HerdrVscodeCi.openUrl(ciRun.url) })))
      .child(div().text_size(TEXT.body).whitespace_normal().child(this.subjectOf(ciRun)))
      .child(h_flex().gap(8).text_size(TEXT.caption).text_color(t.dim)
        .child(h_flex().gap(3).items_center().child(Icon("branch", 10)).child(div().max_w(160).truncate().child(ciRun.ref ?? "")))
        .child(div().font_family(codeFont()).child((ciRun.sha ?? "").slice(0, HerdrVscodeCi.SHORT_SHA_LENGTH)))
        .when(Boolean(ciRun.actor), (el) => el.child(div().child(ciRun.actor)))
        .child(div().flex_1())
        .child(div().child(seconds ? duration(seconds) : since(ciRun.created))))
      .child(h_flex().gap(6)
        .when(isDone(ciRun.kind) && ciRun.kind !== "success", (el) => el.child(Button({ id: "retry", icon: "retry", label: "Retry…", onClick: () => this.retry(ciRun) })))
        .when(!isDone(ciRun.kind), (el) => el.child(Button({ id: "cancel", icon: "stop", label: "Cancel…", onClick: () => this.cancel(ciRun) }))));
  }

  sectionTitle(t, text) {
    return h_flex().h(26).flex_none().px(12).pt(6).items_center().text_size(TEXT.caption).font_medium().text_color(t.muted).child(text);
  }

  jobRow(t, ciRun, job) {
    const isGitLab = this.isGitLab();
    return h_flex().id(`job-${job.id}`).h(28).flex_none().mx(4).px(8).gap(8).items_center().rounded(6).hover((style) => style.bg(t.hover))
      .child(this.statusGlyph(t, job.kind))
      .child(div().flex_1().min_w(0).truncate().text_size(TEXT.small).child(job.name))
      .child(div().flex_none().text_size(TEXT.caption).text_color(t.dim).child(duration(job.seconds)))
      .when(isGitLab && job.kind === "manual", (el) => el.child(IconButton({ id: `play-${job.id}`, icon: "play", label: "Start job…", size: 20, onClick: () => this.jobAction(job, "play") })))
      .when(isGitLab && HerdrVscodeCi.RETRYABLE_JOB_KINDS.includes(job.kind), (el) => el.child(IconButton({ id: `rj-${job.id}`, icon: "retry", label: "Retry job…", size: 20, onClick: () => this.jobAction(job, "retry") })))
      .when(job.artifacts, (el) => el.child(IconButton({ id: `art-${job.id}`, icon: "download", label: "Download artifacts…", size: 20, onClick: () => this.download(ciRun, job) })))
      .child(IconButton({ id: `log-${job.id}`, icon: "external", label: "Open log in browser", size: 20, onClick: () => HerdrVscodeCi.openUrl(job.url) }));
  }

  artifactRow(t, ciRun, artifact) {
    const kilobytes = Math.max(1, Math.round(artifact.size / HerdrVscodeCi.BYTES_PER_KB));
    return h_flex().id(`ga-${artifact.name}`).h(28).flex_none().mx(4).px(8).gap(8).items_center().rounded(6).hover((style) => style.bg(t.hover))
      .child(Icon("archive", 12).text_color(t.dim)).child(div().flex_1().truncate().text_size(TEXT.small).child(artifact.name))
      .child(div().text_size(TEXT.caption).text_color(t.dim).child(`${kilobytes} KB`))
      .child(IconButton({ id: `gad-${artifact.name}`, icon: "download", label: "Download…", size: 20, onClick: () => this.download(ciRun, artifact) }));
  }

  fillJobs(t, list, detail) {
    for (const { stage, jobs } of byStage(detail.jobs)) {
      list.child(this.sectionTitle(t, stage.toUpperCase()));
      list.children(jobs.map((job) => this.jobRow(t, detail.run, job)));
    }
    if (!detail.artifacts?.length) {
      return;
    }
    list.child(this.sectionTitle(t, "ARTIFACTS"));
    list.children(detail.artifacts.map((artifact) => this.artifactRow(t, detail.run, artifact)));
  }

  renderDetail(t, body) {
    const detail = this.detail;
    body.child(this.detailHeader(t, detail.run));
    const list = v_flex().id("jobs").flex_1().min_h(0).overflow_y_scrollbar().pb(8);
    if (detail.error) {
      list.child(Message(detail.error, true));
    } else if (!detail.jobs) {
      list.child(Message("Loading jobs…"));
    } else {
      this.fillJobs(t, list, detail);
    }
    body.child(list);
  }

  workflowPicker(t, form) {
    return v_flex().gap(2).children(form.workflows.map((workflow) =>
      h_flex().id(`wf-${workflow.id}`).h(26).px(8).gap(6).items_center().rounded(6).cursor_pointer().text_size(TEXT.small)
        .bg(form.workflow === workflow.id ? t.selected : HerdrVscodeCi.TRANSPARENT).hover((style) => style.bg(t.hover))
        .on_click((_e, cx) => {
          form.workflow = workflow.id;
          cx.notify();
        })
        .child(div().flex_1().truncate().child(workflow.name))
        .child(div().text_size(TEXT.caption).text_color(t.dim).child(workflow.path.split("/").pop()))));
  }

  static variableLabel(variable) {
    const description = variable.description ? ` · ${variable.description}` : "";
    const options = variable.options ? ` (${variable.options.join(" / ")})` : "";
    return `${variable.key}${description}${options}`;
  }

  renderStart(t, body) {
    const form = this.form;
    const isGitLab = this.isGitLab();
    const field = (label, el) => v_flex().gap(4).child(div().text_size(TEXT.caption).text_color(t.muted).child(label)).child(el);
    const box = (state) => h_flex().h(28).px(8).items_center().rounded(6).border_1().border_color(t.border).bg(t.input ?? t.background)
      .child(Input.new(state).flex_1().h(26).text_size(TEXT.small));
    const intro = isGitLab ? "Starts a new pipeline. You'll be asked to confirm." : "Dispatches a workflow that allows workflow_dispatch. You'll be asked to confirm.";
    const formEl = v_flex().id("start").flex_1().min_h(0).overflow_y_scrollbar().p(12).gap(12)
      .child(div().text_size(TEXT.small).text_color(t.dim).whitespace_normal().child(intro))
      .child(field("Branch or tag", box(form.ref)));
    if (!isGitLab) {
      formEl.child(form.workflows ? field("Workflow", this.workflowPicker(t, form)) : Message("Loading workflows…"));
    }
    for (const variable of form.vars) {
      formEl.child(field(HerdrVscodeCi.variableLabel(variable), box(variable.state)));
    }
    if (form.extra) {
      formEl.child(field(isGitLab ? "More variables" : "Inputs", box(form.extra)));
    }
    formEl.child(h_flex().gap(8).justify_end()
      .child(Button({ id: "start-cancel", label: "Back", onClick: (cx) => {
        this.tab = "runs";
        cx.notify();
      } }))
      .child(Button({ id: "start-go", icon: "play", label: isGitLab ? "Run pipeline…" : "Dispatch…", primary: true, onClick: () => this.start() })));
    body.child(formEl);
  }

  refresh(cx) {
    if (this.detail) {
      this.loadDetail(cx);
    } else {
      this.loadRuns(cx);
    }
  }

  header(t, project) {
    const hasProject = Boolean(project);
    const isGitLab = project?.provider === HerdrVscodeCi.GITLAB;
    return h_flex().h(36).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border)
      .child(RepoButton(this, HerdrVscodeCi.MOD, this.top))
      .child(div().flex_1())
      .when(hasProject, (el) => el.child(div().tooltip(`${project.name} · ${project.path}`).child(Badge(project.name, isGitLab ? t.ansi3 : t.foreground))))
      .when(hasProject, (el) => el.child(IconButton({ id: "start", icon: "play", label: isGitLab ? "Run pipeline…" : "Dispatch workflow…", size: 22, active: this.tab === "start", onClick: (cx) => this.openStart(cx) })))
      .when(hasProject, (el) => el.child(IconButton({ id: "open-web", icon: "external", label: `Open ${project.name}`, size: 22, onClick: () => HerdrVscodeCi.openUrl(project.web) })))
      .child(IconButton({ id: "refresh", icon: "refresh", label: "Refresh", spinning: Boolean(this.loadingRuns || this.loadingDetail), size: 22, onClick: (cx) => this.refresh(cx) }));
  }

  fillBody(t, body, project) {
    if (this.error) {
      body.child(Message(this.error, !this.error.startsWith("Not a git")));
    } else if (!project) {
      body.child(Message("Finding this repo's CI…"));
    } else if (this.tab === "start" && this.form) {
      this.renderStart(t, body);
    } else if (this.detail) {
      this.renderDetail(t, body);
    } else {
      this.renderRuns(t, body);
    }
  }

  render() {
    if (this.repoMenu) {
      return RepoMenu(this);
    }
    if (this.confirmSpec) {
      return ConfirmView(this);
    }
    if (this.toggleOnly) {
      return div();
    }
    const t = theme();
    const project = this.project && !this.project.error ? this.project : null;
    const body = v_flex().id("ci-body").flex_1().min_h(0);
    this.fillBody(t, body, project);
    return v_flex().id(HerdrVscodeCi.MOD).size_full().min_w(0).min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(TEXT.body)
      .child(this.header(t, project)).child(body);
  }
}
