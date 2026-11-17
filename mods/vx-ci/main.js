// vx-ci: CI for the context repo, GitLab pipelines or GitHub Actions runs.
//   panel    props { panel: true }     runs, a run's jobs by stage, run pipeline / dispatch
//   toggle   opened by mod.open:vx-ci  (the ⌘⌥C key) shows or hides the CI panel, then closes
//   confirm  props { confirm }         retry, cancel, run, download: always asked first
// The panel also publishes shared("vx.ci.summary"): the latest run of each workspace root's
// branch, which vx-workspace shows as a dot.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { theme, props, closeOverlay, layout, run, notify, checking, setShared, shared, readTextFile, exec, home } from "herdr";
import { ctx, contextKey, repoTop, changedAt, workspace, baseName } from "./ws.js";
import { parseLog, LOG_FORMAT } from "./git-core.js";
import { byStage, duration, since, isDone, gitlabVariables } from "./ci-core.js";
import { resolveProject } from "./providers.js";
import { askConfirm, confirmMethods } from "./actions.js";
import { TEXT, Icon, IconButton, Badge, Button, Message, ConfirmView, stateLook, codeFont } from "./ui.js";
import { git } from "./ws.js";
import { RepoButton, RepoMenu } from "./repo-picker.js";
import { loadIcons } from "./icons.js";

const MOD = "vx-ci";
const LIST_MS = 30000;
const LIVE_MS = 5000;
const SUMMARY_MS = 60000;
const FILTERS = [["all", "All"], ["running", "Running"], ["failure", "Failed"], ["success", "Passed"]];

const find = (n, id) => (n?.id === id ? n : (n?.children ?? []).map((c) => find(c, id)).find(Boolean) ?? null);

class VxCi extends View {
  init(given, cx) {
    const p = props() ?? given ?? {};
    if (p.repoMenu) {
      this.repoMenu = p.repoMenu;
      loadIcons(this, cx);
      return;
    }
    if (p.confirm) {
      this.confirmSpec = p.confirm;
      this.confirmOverlay = p.overlay;
      this.confirmFocus = cx.focus_handle();
      this.confirmFocus.focus();
      return;
    }
    if (p.overlay && !p.panel) {
      if (!checking()) this.toggle(p.overlay);
      this.toggleOnly = true;
      return;
    }
    loadIcons(this, cx);
    this.tops = new Map();
    this.projects = new Map(); // repo top -> project | { error }
    this.subjects = new Map(); // sha -> commit subject (from local git)
    this.filter = localStorage.getItem("filter") ?? "all";
    this.mine = localStorage.getItem("mine") !== "0";
    this.tab = "runs";
    if (checking()) return;
    cx.timer.every(400, (cx) => this.follow(cx));
    cx.timer.every(LIST_MS, (cx) => this.loadRuns(cx));
    cx.timer.every(LIVE_MS, (cx) => this.live(cx));
    cx.timer.every(SUMMARY_MS, (cx) => this.summarize(cx));
    cx.timer.after(3000, (cx) => this.summarize(cx));
  }

  // ⌘⌥C: open the CI panel (select it in its stack, show the column), or hide it if it's showing.
  toggle(overlay) {
    try {
      const root = layout();
      const panel = find(root, "panel");
      const body = find(root, "panel-body");
      if (!panel || !body || !find(body, "ci")) notify({ title: "No CI panel in this layout", level: "warning" });
      else if (!panel.hidden && body.active === "ci") run("layout.hide", { id: "panel" });
      else {
        run("layout.select", { stack: "panel-body", child: "ci" });
        run("layout.show", { id: "panel" });
      }
    } finally {
      closeOverlay(overlay);
    }
  }

  // ── context ────────────────────────────────────────────────────────────────────────────
  follow(cx) {
    const c = ctx();
    const key = contextKey(c);
    if (key === this.key) return;
    this.key = key;
    this.source = c.source;
    this.detail = null;
    this.runs = null;
    this.error = null;
    cx.spawn(async (cx) => {
      const top = c.cwd ? await repoTop(this.tops, c.cwd, c.on) : null;
      if (this.key !== key) return;
      this.top = top;
      this.on = c.on;
      if (!top) {
        this.project = null;
        this.error = "Not a git repository. Pick a repo in Workspace.";
        return cx.notify();
      }
      const br = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: top, on: c.on }).catch(() => null);
      this.branch = br?.code === 0 ? br.stdout.trim() : null;
      this.project = await this.projectFor(top, c.on);
      if (this.key !== key) return;
      if (this.project.error) this.error = this.project.error;
      this.loadRuns(cx);
      cx.notify();
    });
  }

  async projectFor(top, on) {
    if (!this.projects.has(top)) this.projects.set(top, await resolveProject(top, on));
    return this.projects.get(top);
  }

  // Commit subjects come from the local repo: GitLab's pipeline list has no titles.
  async learnSubjects(top, on) {
    const r = await git(["log", "-n", "300", "--all", LOG_FORMAT], { cwd: top, on }).catch(() => null);
    if (r?.code === 0) for (const c of parseLog(r.stdout)) this.subjects.set(c.hash, c.subject);
  }

  loadRuns(cx) {
    const p = this.project;
    if (!p || p.error || this.loadingRuns) return;
    this.loadingRuns = true;
    const key = this.key;
    cx.spawn(async (cx) => {
      try {
        const [runs] = await Promise.all([p.runs({ ref: this.mine ? this.branch : null }), this.learnSubjects(this.top, this.on)]);
        if (this.key !== key) return;
        this.runs = runs;
        this.error = null;
      } catch (e) {
        if (this.key === key) this.error = e.message;
      } finally {
        this.loadingRuns = false;
        cx.notify();
      }
    });
  }

  openRun(r, cx) {
    this.detail = { run: r, jobs: null };
    this.loadDetail(cx);
    cx.notify();
  }

  loadDetail(cx) {
    const d = this.detail;
    const p = this.project;
    if (!d || !p || this.loadingDetail) return;
    this.loadingDetail = true;
    cx.spawn(async (cx) => {
      try {
        const [r, jobs] = await Promise.all([p.run(d.run.id), p.jobs(d.run.id)]);
        if (this.detail?.run.id !== d.run.id) return;
        this.detail = { run: r, jobs, artifacts: p.artifacts ?? [] };
      } catch (e) {
        if (this.detail) this.detail.error = e.message;
      } finally {
        this.loadingDetail = false;
        cx.notify();
      }
    });
  }

  // Running things refresh every 5 s; finished ones stay put.
  live(cx) {
    if (changedAt() !== this.seenChange) {
      this.seenChange = changedAt();
      this.loadRuns(cx);
    }
    if (this.detail && !isDone(this.detail.run.kind)) this.loadDetail(cx);
    else if ((this.runs ?? []).some((r) => !isDone(r.kind))) this.loadRuns(cx);
  }

  // The latest run on each workspace root's current branch, for the Workspace dots.
  summarize(cx) {
    const roots = workspace()?.roots ?? [];
    const gitSum = shared("vx.git") ?? {};
    if (!roots.length || this.summarizing) return;
    this.summarizing = true;
    cx.spawn(async () => {
      const out = { ...(shared("vx.ci.summary") ?? {}) };
      try {
        for (const root of roots) {
          const branch = gitSum[root.path]?.branch;
          if (!branch) continue;
          const p = await this.projectFor(root.path, null);
          if (p.error) continue;
          try {
            const [latest] = await p.runs({ ref: branch, per: 1 });
            out[root.path] = latest ? { kind: latest.kind, label: latest.label, url: latest.url, number: latest.number, at: Date.now() } : null;
          } catch {}
        }
        setShared("vx.ci.summary", out);
      } finally {
        this.summarizing = false;
      }
    });
  }

  // ── actions (all confirmed) ────────────────────────────────────────────────────────────
  confirm(title, detail, label, action, danger = false) {
    askConfirm(MOD, { title, detail, label, danger, action: { ...action, root: this.top } });
  }

  retry(r) {
    this.confirm(`Retry ${this.project.provider === "gitlab" ? "pipeline" : "run"} #${r.number}?`, `${r.title ?? ""} on ${r.ref}. Failed and cancelled jobs run again.`, "Retry", this.project.retrySpec(r));
  }

  cancel(r) {
    this.confirm(`Cancel #${r.number}?`, `Stops every running job of ${r.ref}.`, "Cancel run", this.project.cancelSpec(r), true);
  }

  jobAction(job, verb) {
    this.confirm(`${verb === "play" ? "Start" : "Retry"} job ${job.name}?`, null, verb === "play" ? "Start" : "Retry", this.project.jobSpec(job, verb));
  }

  download(r, what) {
    const dir = `${home()}/Downloads/vx-ci/${baseName(this.project.path)}/${r.number}`;
    this.confirm(`Download ${what.name} artifacts?`, `Into ${dir.replace(home(), "~")}`, "Download", this.project.artifactSpec(r, what, dir));
  }

  // Run pipeline (GitLab) / Dispatch (GitHub): the form's text boxes are made here, on a click,
  // never during a render.
  openStart(cx) {
    this.tab = "start";
    this.form = { ref: InputState.new({ value: this.branch ?? this.project.defaultBranch ?? "" }), vars: [], workflows: null, workflow: null };
    cx.spawn(async (cx) => {
      if (this.project.provider === "gitlab") {
        const yaml = await readTextFile(`${this.top}/.gitlab-ci.yml`, { on: this.on }).catch(() => null);
        this.form.vars = gitlabVariables(yaml).filter((v) => v.description).map((v) => ({ ...v, state: InputState.new({ value: v.value ?? "" }) }));
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
    const f = this.form;
    const ref = f.ref.value().trim();
    if (!ref) return notify({ title: "Pick a branch", level: "warning" });
    const extra = (f.extra?.value() ?? "").split(",").map((s) => s.trim()).filter(Boolean)
      .map((s) => ({ key: s.split("=")[0].trim(), value: s.slice(s.indexOf("=") + 1).trim() })).filter((v) => v.key && v.key !== "");
    const variables = [...f.vars.map((v) => ({ key: v.key, value: v.state.value() })), ...extra];
    const gl = this.project.provider === "gitlab";
    if (!gl && !f.workflow) return notify({ title: "No workflow to dispatch", level: "warning" });
    const wf = f.workflows?.find((w) => w.id === f.workflow);
    this.confirm(
      gl ? `Run a pipeline on ${ref}?` : `Dispatch ${wf?.name ?? "workflow"} on ${ref}?`,
      variables.length ? variables.map((v) => `${v.key}=${v.value}`).join("  ") : "No variables.",
      gl ? "Run pipeline" : "Dispatch",
      this.project.startSpec({ ref, workflow: f.workflow, variables }),
    );
  }

  // ── drawing ────────────────────────────────────────────────────────────────────────────
  statusGlyph(t, kind, size = 12) {
    const look = stateLook(kind, t);
    return div().w(size + 4).flex_none().text_center().text_size(size).text_color(look.color).child(look.glyph);
  }

  runRow(t, r) {
    const subject = this.subjects.get(r.sha) ?? r.title ?? `#${r.number}`;
    const secs = r.started ? ((r.finished ? Date.parse(r.finished) : Date.now()) - Date.parse(r.started)) / 1000 : null;
    return h_flex().id(`run-${r.id}`).flex_none().mx(4).px(8).py(5).gap(8).items_start().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.openRun(r, cx))
      .child(div().pt(1).child(this.statusGlyph(t, r.kind)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_size(TEXT.small).text_color(t.foreground).child(subject))
        .child(h_flex().gap(6).text_size(TEXT.caption).text_color(t.dim).min_w(0)
          .child(div().flex_none().child(`#${r.number}`))
          .child(div().max_w(140).truncate().child(r.ref ?? ""))
          .when(Boolean(r.event), (el) => el.child(div().flex_none().child(r.event.replace(/_/g, " "))))
          .child(div().flex_1())
          .child(div().flex_none().child(r.kind === "running" ? duration(secs) : since(r.created)))));
  }

  renderRuns(t, body) {
    const runs = (this.runs ?? []).filter((r) => this.filter === "all" || (this.filter === "failure" ? ["failure", "warning"].includes(r.kind) : r.kind === this.filter));
    body.child(h_flex().flex_none().px(10).py(6).gap(4).items_center()
      .children(FILTERS.map(([id, label]) => {
        const n = id === "all" ? (this.runs ?? []).length : (this.runs ?? []).filter((r) => (id === "failure" ? ["failure", "warning"].includes(r.kind) : r.kind === id)).length;
        const on = this.filter === id;
        return h_flex().id(`flt-${id}`).h(22).px(8).gap(4).items_center().rounded(11).text_size(TEXT.caption).cursor_pointer()
          .bg(on ? t.selected : "#00000000").text_color(on ? t.foreground : t.dim).border_1().border_color(on ? t.border : "#00000000")
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.filter = id; localStorage.setItem("filter", id); cx.notify(); })
          .child(label).child(div().text_color(t.dim).child(String(n)));
      }))
      .child(div().flex_1())
      .child(h_flex().id("mine").h(22).px(8).items_center().rounded(11).text_size(TEXT.caption).cursor_pointer()
        .text_color(this.mine ? t.accent : t.dim).hover((s) => s.bg(t.hover))
        .tooltip(this.mine ? `Only ${this.branch}` : "Every branch")
        .on_click((_e, cx) => { this.mine = !this.mine; localStorage.setItem("mine", this.mine ? "1" : "0"); this.runs = null; this.loadRuns(cx); cx.notify(); })
        .child(this.mine ? this.branch ?? "branch" : "all branches")));
    const list = v_flex().id("runs").flex_1().min_h(0).overflow_y_scrollbar().pb(6);
    if (!this.runs) list.child(Message("Loading…"));
    else if (!runs.length) list.child(Message(this.mine ? `No runs on ${this.branch} yet.` : "No runs."));
    else list.children(runs.map((r) => this.runRow(t, r)));
    body.child(list);
  }

  renderDetail(t, body) {
    const d = this.detail;
    const r = d.run;
    const p = this.project;
    const subject = this.subjects.get(r.sha) ?? r.title ?? `#${r.number}`;
    const look = stateLook(r.kind, t);
    const secs = r.started ? ((r.finished ? Date.parse(r.finished) : Date.now()) - Date.parse(r.started)) / 1000 : null;
    body.child(v_flex().flex_none().px(12).py(8).gap(6).border_b(1).border_color(t.border)
      .child(h_flex().gap(6).items_center()
        .child(IconButton({ id: "back", icon: "back", label: "Back to runs", size: 22, onClick: (cx) => { this.detail = null; cx.notify(); } }))
        .child(div().text_color(look.color).font_medium().child(`${look.glyph} ${r.label}`))
        .child(div().text_size(TEXT.caption).text_color(t.dim).child(`#${r.number}`))
        .child(div().flex_1())
        .child(IconButton({ id: "web", icon: "external", label: "Open in browser", size: 22, onClick: () => exec("open", [r.url]).catch(() => {}) })))
      .child(div().text_size(TEXT.body).whitespace_normal().child(subject))
      .child(h_flex().gap(8).text_size(TEXT.caption).text_color(t.dim)
        .child(h_flex().gap(3).items_center().child(Icon("branch", 10)).child(div().max_w(160).truncate().child(r.ref ?? "")))
        .child(div().font_family(codeFont()).child((r.sha ?? "").slice(0, 8)))
        .when(Boolean(r.actor), (el) => el.child(div().child(r.actor)))
        .child(div().flex_1())
        .child(div().child(secs ? duration(secs) : since(r.created))))
      .child(h_flex().gap(6)
        .when(isDone(r.kind) && r.kind !== "success", (el) => el.child(Button({ id: "retry", icon: "retry", label: "Retry…", onClick: () => this.retry(r) })))
        .when(!isDone(r.kind), (el) => el.child(Button({ id: "cancel", icon: "stop", label: "Cancel…", onClick: () => this.cancel(r) })))));
    const list = v_flex().id("jobs").flex_1().min_h(0).overflow_y_scrollbar().pb(8);
    if (d.error) list.child(Message(d.error, true));
    else if (!d.jobs) list.child(Message("Loading jobs…"));
    else {
      for (const { stage, jobs } of byStage(d.jobs)) {
        list.child(h_flex().h(26).flex_none().px(12).pt(6).items_center().text_size(TEXT.caption).font_medium().text_color(t.muted).child(stage.toUpperCase()));
        list.children(jobs.map((j) => h_flex().id(`job-${j.id}`).h(28).flex_none().mx(4).px(8).gap(8).items_center().rounded(6).hover((s) => s.bg(t.hover))
          .child(this.statusGlyph(t, j.kind))
          .child(div().flex_1().min_w(0).truncate().text_size(TEXT.small).child(j.name))
          .child(div().flex_none().text_size(TEXT.caption).text_color(t.dim).child(duration(j.seconds)))
          .when(p.provider === "gitlab" && j.kind === "manual", (el) => el.child(IconButton({ id: `play-${j.id}`, icon: "play", label: "Start job…", size: 20, onClick: () => this.jobAction(j, "play") })))
          .when(p.provider === "gitlab" && ["failure", "warning", "canceled", "success"].includes(j.kind), (el) => el.child(IconButton({ id: `rj-${j.id}`, icon: "retry", label: "Retry job…", size: 20, onClick: () => this.jobAction(j, "retry") })))
          .when(j.artifacts, (el) => el.child(IconButton({ id: `art-${j.id}`, icon: "download", label: "Download artifacts…", size: 20, onClick: () => this.download(r, j) })))
          .child(IconButton({ id: `log-${j.id}`, icon: "external", label: "Open log in browser", size: 20, onClick: () => exec("open", [j.url]).catch(() => {}) }))));
      }
      if (d.artifacts?.length) {
        list.child(h_flex().h(26).flex_none().px(12).pt(6).items_center().text_size(TEXT.caption).font_medium().text_color(t.muted).child("ARTIFACTS"));
        list.children(d.artifacts.map((a) => h_flex().id(`ga-${a.name}`).h(28).flex_none().mx(4).px(8).gap(8).items_center().rounded(6).hover((s) => s.bg(t.hover))
          .child(Icon("archive", 12).text_color(t.dim)).child(div().flex_1().truncate().text_size(TEXT.small).child(a.name))
          .child(div().text_size(TEXT.caption).text_color(t.dim).child(`${Math.max(1, Math.round(a.size / 1024))} KB`))
          .child(IconButton({ id: `gad-${a.name}`, icon: "download", label: "Download…", size: 20, onClick: () => this.download(r, a) }))));
      }
    }
    body.child(list);
  }

  renderStart(t, body) {
    const f = this.form;
    const gl = this.project.provider === "gitlab";
    const field = (label, el) => v_flex().gap(4).child(div().text_size(TEXT.caption).text_color(t.muted).child(label)).child(el);
    const box = (state) => h_flex().h(28).px(8).items_center().rounded(6).border_1().border_color(t.border).bg(t.input ?? t.background).child(Input.new(state).flex_1().h(26).text_size(TEXT.small));
    const form = v_flex().id("start").flex_1().min_h(0).overflow_y_scrollbar().p(12).gap(12)
      .child(div().text_size(TEXT.small).text_color(t.dim).whitespace_normal().child(gl ? "Starts a new pipeline. You'll be asked to confirm." : "Dispatches a workflow that allows workflow_dispatch. You'll be asked to confirm."))
      .child(field("Branch or tag", box(f.ref)));
    if (!gl) {
      if (!f.workflows) form.child(Message("Loading workflows…"));
      else form.child(field("Workflow", v_flex().gap(2).children(f.workflows.map((w) =>
        h_flex().id(`wf-${w.id}`).h(26).px(8).gap(6).items_center().rounded(6).cursor_pointer().text_size(TEXT.small)
          .bg(f.workflow === w.id ? t.selected : "#00000000").hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { f.workflow = w.id; cx.notify(); })
          .child(div().flex_1().truncate().child(w.name)).child(div().text_size(TEXT.caption).text_color(t.dim).child(w.path.split("/").pop()))))));
    }
    for (const v of f.vars) form.child(field(`${v.key}${v.description ? ` · ${v.description}` : ""}${v.options ? ` (${v.options.join(" / ")})` : ""}`, box(v.state)));
    if (f.extra) form.child(field(gl ? "More variables" : "Inputs", box(f.extra)));
    form.child(h_flex().gap(8).justify_end()
      .child(Button({ id: "start-cancel", label: "Back", onClick: (cx) => { this.tab = "runs"; cx.notify(); } }))
      .child(Button({ id: "start-go", icon: "play", label: gl ? "Run pipeline…" : "Dispatch…", primary: true, onClick: () => this.start() })));
    body.child(form);
  }

  render() {
    if (this.repoMenu) return RepoMenu(this);
    if (this.confirmSpec) return ConfirmView(this);
    if (this.toggleOnly) return div();
    const t = theme();
    const p = this.project && !this.project.error ? this.project : null;
    const head = h_flex().h(36).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border)
      .child(RepoButton(this, MOD, this.top))
      .child(div().flex_1())
      .when(Boolean(p), (el) => el.child(div().tooltip(`${p.name} · ${p.path}`).child(Badge(p.name, p.provider === "gitlab" ? t.ansi3 : t.foreground))))
      .when(Boolean(p), (el) => el.child(IconButton({ id: "start", icon: "play", label: p.provider === "gitlab" ? "Run pipeline…" : "Dispatch workflow…", size: 22, active: this.tab === "start", onClick: (cx) => this.openStart(cx) })))
      .when(Boolean(p), (el) => el.child(IconButton({ id: "open-web", icon: "external", label: `Open ${p.name}`, size: 22, onClick: () => exec("open", [p.web]).catch(() => {}) })))
      .child(IconButton({ id: "refresh", icon: "refresh", label: "Refresh", spinning: Boolean(this.loadingRuns || this.loadingDetail), size: 22, onClick: (cx) => { this.detail ? this.loadDetail(cx) : this.loadRuns(cx); } }));
    const body = v_flex().id("ci-body").flex_1().min_h(0);
    if (this.error) body.child(Message(this.error, !this.error.startsWith("Not a git")));
    else if (!p) body.child(Message("Finding this repo's CI…"));
    else if (this.tab === "start" && this.form) this.renderStart(t, body);
    else if (this.detail) this.renderDetail(t, body);
    else this.renderRuns(t, body);
    return v_flex().id(MOD).size_full().min_w(0).min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(TEXT.body)
      .child(head).child(body);
  }
}

Object.assign(VxCi.prototype, confirmMethods);
export default VxCi;
