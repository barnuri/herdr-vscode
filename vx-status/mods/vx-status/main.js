import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, home, openOverlay, closeOverlay, props, run, notify, layout, checking, shared, setShared } from "herdr";
import { ctx, contextKey, git, repoTop, changedAt, baseName, workspace } from "./ws.js";
import { parseStatus } from "./git-core.js";
import { workspaceProblems, countProblems } from "./panel-core.js";
import { confirmMethods, runAction } from "./actions.js";
import { TEXT, Icon, ConfirmView, stateLook } from "./ui.js";
import { findNode } from "./layout-core.js";
import { AUTOSAVE_KEY, AUTOSAVE_OFF, AUTOSAVE_AFTER_DELAY, autoSaveMode } from "./fileops-core.js";

class VxStatus extends View {
  static MOD = "vx-status";
  static FOLLOW_MS = 400;
  static GIT_MS = 8000;
  static DEFAULT_WIDTH = 1200;
  static WIDE_WIDTH = 900;
  static MID_WIDTH = 620;
  static RESIZE_THRESHOLD = 8;
  static MENU_WIDTH = 270;
  static MENU_ROW_HEIGHT = 44;
  static MENU_PADDING = 12;
  static COPY_TOAST_MS = 1500;
  static NO_UPSTREAM = "its upstream";
  static CI_WORDS = {
    success: "passed", failure: "failed", running: "running", queued: "queued",
    manual: "manual", canceled: "canceled", skipped: "skipped", warning: "warning",
  };
  static STATUS_ARGS = ["status", "--porcelain=v1", "-z", "-b", "--no-renames", "--untracked-files=normal"];
  static STASH_ARGS = ["rev-list", "--walk-reflogs", "--count", "refs/stash"];

  static plural(count, word, suffix = "s") {
    return `${count} ${word}${count === 1 ? "" : suffix}`;
  }

  init(given, cx) {
    const options = props() ?? given ?? {};
    if (options.confirm) {
      this.confirmSpec = options.confirm;
      this.confirmOverlay = options.overlay;
      this.confirmFocus = cx.focus_handle();
      this.confirmFocus.focus();
      return;
    }
    if (options.menu) {
      this.menu = options.menu;
      return;
    }
    this.style = options.style === "vscode" ? "vscode" : "pill";
    this.width = VxStatus.DEFAULT_WIDTH;
    this.tops = new Map();
    this.repo = null;
    if (checking()) {
      return;
    }
    cx.timer.every(VxStatus.FOLLOW_MS, (cx) => this.follow(cx));
    cx.timer.every(VxStatus.GIT_MS, (cx) => this.refresh(cx));
  }

  follow(cx) {
    const key = contextKey(ctx());
    if (key === this.key && changedAt() === this.seenChange) {
      return;
    }
    this.key = key;
    this.seenChange = changedAt();
    this.refresh(cx);
  }

  refresh(cx) {
    const context = ctx();
    if (!context.cwd) {
      this.repo = null;
      return;
    }
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        await this.loadRepo(context);
      } catch {
        this.repo = null;
      } finally {
        this.busy = false;
        if (this.again) {
          this.again = false;
          this.refresh(cx);
        }
        cx.notify();
      }
    });
  }

  async loadRepo(context) {
    const key = contextKey(context);
    const top = await repoTop(this.tops, context.cwd, context.on);
    if (!top) {
      if (contextKey(ctx()) === key) {
        this.repo = { top: null, cwd: context.cwd, on: context.on };
      }
      return;
    }
    const [status, stash] = await Promise.all([
      git(VxStatus.STATUS_ARGS, { cwd: top, on: context.on }),
      git(VxStatus.STASH_ARGS, { cwd: top, on: context.on }).catch(() => null),
    ]);
    if (contextKey(ctx()) !== key || status.code !== 0) {
      return;
    }
    const stashCount = stash?.code === 0 ? Number(stash.stdout.trim()) || 0 : 0;
    this.repo = { ...parseStatus(status.stdout), stash: stashCount, top, cwd: context.cwd, on: context.on };
  }

  openGitMenu() {
    const repo = this.repo;
    const rows = 1 + (repo.ahead ? 1 : 0) + (repo.behind ? 1 : 0);
    openOverlay({
      mod: VxStatus.MOD, kind: "popup", width: VxStatus.MENU_WIDTH,
      height: rows * VxStatus.MENU_ROW_HEIGHT + VxStatus.MENU_PADDING, props: { menu: { g: repo } },
    });
  }

  ask(repo, verb) {
    const upstream = repo.upstream ?? VxStatus.NO_UPSTREAM;
    const name = baseName(repo.top);
    const specs = {
      fetch: { title: `Fetch ${name}?`, detail: "Downloads new commits from the remote. Nothing local changes.", label: "Fetch", args: ["fetch", "--prune"], doing: "Fetching", done: `Fetched ${name}` },
      pull: { title: `Pull ${VxStatus.plural(repo.behind, "commit")} into ${repo.branch}?`, detail: `From ${upstream}.`, label: "Pull", args: ["pull"], doing: "Pulling", done: `Pulled ${name}` },
      push: { title: `Push ${VxStatus.plural(repo.ahead, "commit")} from ${repo.branch}?`, detail: `To ${upstream}. Other people will see these commits.`, label: "Push", args: ["push"], doing: "Pushing", done: `Pushed ${name}`, danger: true },
    };
    const spec = specs[verb];
    runAction({ cmd: "git", args: spec.args, cwd: repo.top, on: repo.on, doing: spec.doing, done: spec.done, root: repo.top });
  }

  // Prefers the sidebar view; falls back to the right panel stack.
  revealPanel(sidebarChild, panelChild, missingTitle) {
    const root = layout();
    if (findNode(root, "sidebar-views") && findNode(root, sidebarChild)) {
      run("layout.select", { stack: "sidebar-views", child: sidebarChild });
      return run("layout.show", { id: "sidebar" });
    }
    if (!findNode(root, panelChild)) {
      return notify({ title: missingTitle });
    }
    run("layout.select", { stack: "panel-body", child: panelChild });
    run("layout.show", { id: "panel" });
  }

  showChanges() {
    this.revealPanel("scm", "changes", "No Changes panel in this layout");
  }

  showCi() {
    this.revealPanel("ci", "ci", "No CI panel in this layout");
  }

  chip(t, id, { icon, color, tip, onClick }, ...kids) {
    const vs = this.style === "vscode";
    return h_flex().id(id).h(20).px(6).gap(5).flex_none().items_center().rounded(5).text_size(vs ? 12 : 11.5).text_color(color ?? t.muted)
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .when(Boolean(onClick), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { onClick(cx); cx.notify(); }))
      .when(Boolean(icon), (el) => el.child(Icon(icon, vs ? 14 : 11).text_color(color ?? t.dim)))
      .children(kids.filter((kid) => kid !== null && kid !== undefined && kid !== ""));
  }

  renderMenu() {
    const t = theme();
    const { g: repo } = this.menu;
    const item = (id, label, sub, verb) =>
      v_flex().id(id).px(10).py(6).gap(1).rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click(() => { closeOverlay(props()?.overlay); this.ask(repo, verb); })
        .child(div().text_size(12.5).text_color(t.foreground).child(label))
        .child(div().text_size(11).text_color(t.dim).child(sub));
    const upstream = repo.upstream ?? VxStatus.NO_UPSTREAM;
    return v_flex().id("vx-status-menu").size_full().p(6).bg(t.popover ?? t.surface)
      .when(Boolean(repo.ahead), (el) => el.child(item("push", `Push ${VxStatus.plural(repo.ahead, "commit")}`, `to ${upstream}`, "push")))
      .when(Boolean(repo.behind), (el) => el.child(item("pull", `Pull ${VxStatus.plural(repo.behind, "commit")}`, `from ${upstream}`, "pull")))
      .child(item("fetch", "Fetch…", "update ↑ ↓ from the remote", "fetch"));
  }

  folderName(context) {
    if (this.repo?.top) {
      return baseName(this.repo.top);
    }
    if (!context.cwd) {
      return null;
    }
    return context.cwd === home() ? "~" : baseName(context.cwd);
  }

  locationChip(t, context, folder) {
    const viaWorkspace = context.source === "active" || context.source === "picked";
    if (viaWorkspace) {
      const tip = `Showing the repo picked in Workspace (${context.root?.name ?? folder}). Focus a terminal inside a repo to follow it instead.`;
      return this.chip(t, "st-ws", { icon: "layers", color: t.accent, tip }, div().max_w(200).truncate().child(folder ?? ""));
    }
    if (!folder) {
      return null;
    }
    return this.chip(t, "st-folder", { icon: "folder", color: t.muted, tip: this.repo?.top ?? context.cwd ?? "" }, div().max_w(200).truncate().child(folder));
  }

  branchChip(t, wide) {
    const repo = this.repo;
    if (!repo?.branch && !repo?.detached) {
      return null;
    }
    const copyBranch = (cx) => {
      cx.write_to_clipboard(repo.branch ?? "HEAD");
      notify({ title: "Copied", body: repo.branch ?? "HEAD", timeout: VxStatus.COPY_TOAST_MS });
    };
    return this.chip(t, "st-branch", { icon: "branch", color: t.foreground, tip: `${repo.upstream ? `Tracks ${repo.upstream} · ` : ""}Click to copy`, onClick: copyBranch },
      div().max_w(wide ? 260 : 150).truncate().child(repo.detached ? "detached" : repo.branch));
  }

  syncChip(t) {
    const repo = this.repo;
    if (!repo?.top) {
      return null;
    }
    const { ahead, behind } = repo;
    let icon = "refresh";
    let color = t.dim;
    if (ahead) {
      icon = "arrow-up";
      color = t.ansi6;
    } else if (behind) {
      icon = "arrow-down";
      color = t.ansi4;
    }
    const tip = repo.upstream ? `↑${ahead} to push · ↓${behind} to pull · click for fetch / pull / push` : "No upstream · click to fetch";
    const label = ahead || behind ? `${ahead ? `↑${ahead}` : ""}${ahead && behind ? " " : ""}${behind ? `↓${behind}` : ""}` : "";
    return this.chip(t, "st-sync", { icon, color, tip, onClick: () => this.openGitMenu() }, label);
  }

  leftChips(t, context, vs, wide, mid) {
    const repo = this.repo;
    return [
      vs ? this.chip(t, "st-remote", { icon: "remote", color: t.muted, tip: context.on ? `On ${context.on}` : "This machine" }, context.on ?? null) : null,
      this.locationChip(t, context, this.folderName(context)),
      this.branchChip(t, wide),
      this.syncChip(t),
      repo?.changed ? this.chip(t, "st-changed", { icon: "pencil", color: t.ansi3, tip: `${repo.changed} changed (${repo.untracked} new) · open Changes`, onClick: () => this.showChanges() }, String(repo.changed)) : null,
      repo?.staged && mid ? this.chip(t, "st-staged", { icon: "plus", color: t.ansi2, tip: `${repo.staged} staged` }, String(repo.staged)) : null,
      repo?.conflicts ? this.chip(t, "st-conflicts", { icon: "alert", color: t.ansi1, tip: `${repo.conflicts} with conflicts · open Changes`, onClick: () => this.showChanges() }, String(repo.conflicts)) : null,
      repo?.stash && mid ? this.chip(t, "st-stash", { icon: "archive", color: t.dim, tip: VxStatus.plural(repo.stash, "stash", "es") }, String(repo.stash)) : null,
      repo && repo.top && !repo.changed && mid ? div().text_size(11).text_color(t.dim).child("clean") : null,
    ].filter(Boolean);
  }

  // The VS Code style adds problems and ports on the left, the repo's pipeline and the workspace on the right.
  addVscodeChips(t, mid, left, right) {
    const problems = countProblems(workspaceProblems(workspace()?.roots ?? [], shared("vx.git") ?? {}, shared("vx.ci.summary") ?? {}), shared("vx.checks") ?? {});
    const openPanel = (view) => {
      setShared("vx.panel", { ...(shared("vx.panel") ?? {}), view });
      run("layout.show", { id: "bottom" });
    };
    left.push(this.chip(t, "st-problems", { color: problems.errors ? t.ansi1 : t.muted, tip: `${problems.errors} errors, ${problems.warnings} warnings · open Problems`, onClick: () => openPanel("problems") },
      div().child(`✕ ${problems.errors}`), div().text_color(problems.warnings ? t.ansi3 : t.muted).child(`⚠ ${problems.warnings}`)));
    const ports = shared("vx.ports");
    if (ports && mid) {
      left.push(this.chip(t, "st-ports", { icon: "plug", color: t.muted, tip: `${VxStatus.plural(ports, "listening port")} · open Ports`, onClick: () => openPanel("ports") }, String(ports)));
    }
    const ci = this.repo?.top ? shared("vx.ci.summary")?.[this.repo.top] : null;
    if (ci) {
      const look = stateLook(ci.kind, t);
      const word = VxStatus.CI_WORDS[ci.kind] ?? ci.kind;
      right.push(this.chip(t, "st-ci", { icon: "ci", color: look.color, tip: `CI: ${ci.label ?? word}${ci.number ? ` #${ci.number}` : ""} · open CI / CD`, onClick: () => this.showCi() },
        div().child(`${look.glyph} ${word}`)));
    }
    const ws = workspace();
    if (ws?.name && mid) {
      right.push(this.chip(t, "st-wsname", { icon: "layers", color: t.muted, tip: ws.file ?? ws.name }, ws.name));
    }
    const autoSaveOn = autoSaveMode(shared(AUTOSAVE_KEY)) !== AUTOSAVE_OFF;
    right.push(this.chip(t, "st-autosave", {
      icon: "check", color: autoSaveOn ? t.muted : t.dim, tip: autoSaveOn ? "Auto Save after a 1 s pause · click to turn off" : "Auto Save is off (⌘S saves) · click to turn on",
      onClick: () => setShared(AUTOSAVE_KEY, autoSaveOn ? AUTOSAVE_OFF : AUTOSAVE_AFTER_DELAY),
    }, div().child(autoSaveOn ? "Auto Save" : "Auto Save: off")));
  }

  render() {
    if (this.confirmSpec) {
      return ConfirmView(this);
    }
    if (this.menu) {
      return this.renderMenu();
    }
    const vs = this.style === "vscode";
    const t = theme();
    const context = ctx();
    const wide = this.width >= VxStatus.WIDE_WIDTH;
    const mid = this.width >= VxStatus.MID_WIDTH;
    const left = this.leftChips(t, context, vs, wide, mid);
    const right = [];
    if (vs) {
      this.addVscodeChips(t, mid, left, right);
    }
    return h_flex().id(VxStatus.MOD).size_full().px(vs ? 6 : 10).gap(vs ? 2 : 4).items_center().overflow_hidden().bg(vs ? t.canvas ?? t.chrome : t.chrome).when(!vs, (el) => el.border_t(1).border_color(t.border))
      .text_size(TEXT.small).text_color(t.muted)
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.width) > VxStatus.RESIZE_THRESHOLD) {
          this.width = size.width;
          cx.notify();
        }
      })
      .children(left)
      .child(div().flex_1().min_w(8))
      .children(right);
  }
}

Object.assign(VxStatus.prototype, confirmMethods);
export default VxStatus;
