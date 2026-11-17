// vx-status: the bottom bar. Left: the repo every vx panel shows (and why), its branch, ahead /
// behind, changes, staged, conflicts and stashes. Right, for a Claude Code pane: model, effort
// and the ctx / 5h / 7d meters our vx-status Claude Code plugin writes to
// ~/.local/state/vx-status/<terminal>.json.
// Fetch, pull and push sit behind the ↑↓ menu and always ask first.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, home, readTextFile, watchFolder, exec, openOverlay, closeOverlay, props, run, notify, layout, checking, shared, setShared } from "herdr";
import { ctx, contextKey, git, repoTop, changedAt, baseName, workspace } from "./ws.js";
import { parseStatus } from "./git-core.js";
import { workspaceProblems, countProblems } from "./panel-core.js";
import { askConfirm, confirmMethods } from "./actions.js";
import { TEXT, Icon, ConfirmView, tint, stateLook } from "./ui.js";

const MOD = "vx-status";
const FOLLOW_MS = 400;
const GIT_MS = 8000;
const METER = { ctx: "ansi6", "5h": "ansi5", "7d": "ansi2" };
const infoDir = () => `${home()}/.local/state/vx-status`;
const isClaude = (pane) => Boolean(pane && (pane.app === "claude-code" || pane.program?.key === "claude"));

// "claude-opus-5-5[1m]" -> "Opus 5.5"
function modelName(id) {
  const m = /(opus|sonnet|haiku|fable)[-_ ]?(\d+)?(?:[-.](\d+))?/i.exec(id ?? "");
  if (!m) return id ?? "";
  return `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()}${m[2] ? ` ${m[2]}${m[3] ? `.${m[3]}` : ""}` : ""}`;
}
const windowLabel = (n) => (!n ? null : n >= 1e6 ? `${n / 1e6}M` : `${Math.round(n / 1000)}k`);
const find = (n, id) => (n?.id === id ? n : (n?.children ?? []).map((c) => find(c, id)).find(Boolean) ?? null);


class VxStatus extends View {
  init(given, cx) {
    const p = props() ?? given ?? {};
    if (p.confirm) {
      this.confirmSpec = p.confirm;
      this.confirmOverlay = p.overlay;
      this.confirmFocus = cx.focus_handle();
      this.confirmFocus.focus();
      return;
    }
    if (p.menu) {
      this.menu = p.menu;
      return;
    }
    this.style = p.style === "vscode" ? "vscode" : "pill";
    this.width = 1200;
    this.tops = new Map();
    this.g = null;
    this.info = null;
    if (checking()) return;
    cx.timer.every(FOLLOW_MS, (cx) => this.follow(cx));
    cx.timer.every(GIT_MS, (cx) => this.refresh(cx));
    this.watchInfo(cx);
  }

  follow(cx) {
    const c = ctx();
    const key = contextKey(c);
    if (key !== this.key || changedAt() !== this.seenChange) {
      this.key = key;
      this.seenChange = changedAt();
      this.refresh(cx);
    }
    const term = c.focus.terminal;
    if (term !== this.infoFor) {
      this.infoFor = term;
      this.readInfo(cx);
    }
  }

  refresh(cx) {
    const c = ctx();
    if (!c.cwd) {
      this.g = null;
      return;
    }
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    const key = contextKey(c);
    cx.spawn(async (cx) => {
      try {
        const top = await repoTop(this.tops, c.cwd, c.on);
        if (!top) {
          if (contextKey(ctx()) === key) this.g = { top: null, cwd: c.cwd, on: c.on };
          return;
        }
        const [st, stash] = await Promise.all([
          git(["status", "--porcelain=v1", "-z", "-b", "--no-renames", "--untracked-files=normal"], { cwd: top, on: c.on }),
          git(["rev-list", "--walk-reflogs", "--count", "refs/stash"], { cwd: top, on: c.on }).catch(() => null),
        ]);
        if (contextKey(ctx()) !== key || st.code !== 0) return;
        this.g = { ...parseStatus(st.stdout), stash: stash?.code === 0 ? Number(stash.stdout.trim()) || 0 : 0, top, cwd: c.cwd, on: c.on };
      } catch {
        this.g = null;
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

  // ── Claude, from our plugin ────────────────────────────────────────────────────────────
  watchInfo(cx) {
    cx.spawn(async (cx) => {
      await exec("mkdir", ["-p", infoDir()]).catch(() => {});
      for (;;) {
        try {
          await watchFolder(infoDir());
        } catch {
          return;
        }
        this.readInfo(cx);
      }
    });
  }

  readInfo(cx) {
    const { focus } = ctx();
    if (!focus.terminal || focus.terminal.includes("/") || !isClaude(focus.pane)) {
      if (this.info) {
        this.info = null;
        cx.notify();
      }
      return;
    }
    const term = focus.terminal;
    cx.spawn(async (cx) => {
      let info = null;
      try {
        info = JSON.parse((await readTextFile(`${infoDir()}/${term}.json`)) ?? "null");
      } catch {}
      if (ctx().focus.terminal !== term) return;
      this.info = info;
      cx.notify();
    });
  }

  // ── actions ────────────────────────────────────────────────────────────────────────────
  openGitMenu() {
    const g = this.g;
    const rows = 1 + (g.ahead ? 1 : 0) + (g.behind ? 1 : 0);
    openOverlay({ mod: MOD, kind: "popup", width: 270, height: rows * 44 + 12, props: { menu: { g } } });
  }

  ask(g, verb) {
    const up = g.upstream ?? "its upstream";
    const name = baseName(g.top);
    const specs = {
      fetch: { title: `Fetch ${name}?`, detail: "Downloads new commits from the remote. Nothing local changes.", label: "Fetch", args: ["fetch", "--prune"], doing: "Fetching", done: `Fetched ${name}` },
      pull: { title: `Pull ${g.behind} commit${g.behind === 1 ? "" : "s"} into ${g.branch}?`, detail: `Fast-forward only from ${up}. Stops instead of merging if your branch has diverged.`, label: "Pull", args: ["pull", "--ff-only"], doing: "Pulling", done: `Pulled ${name}` },
      push: { title: `Push ${g.ahead} commit${g.ahead === 1 ? "" : "s"} from ${g.branch}?`, detail: `To ${up}. Other people will see these commits.`, label: "Push", args: ["push"], doing: "Pushing", done: `Pushed ${name}`, danger: true },
    };
    const s = specs[verb];
    askConfirm(MOD, { title: s.title, detail: s.detail, label: s.label, danger: s.danger, action: { cmd: "git", args: s.args, cwd: g.top, on: g.on, doing: s.doing, done: s.done, root: g.top } });
  }

  // The layout's Changes panel (vx-changes or Herdr's), shown and selected.
  showChanges() {
    const root = layout();
    if (find(root, "sidebar-views") && find(root, "scm")) {
      run("layout.select", { stack: "sidebar-views", child: "scm" });
      return run("layout.show", { id: "sidebar" });
    }
    if (!find(root, "changes")) return notify({ title: "No Changes panel in this layout" });
    run("layout.select", { stack: "panel-body", child: "changes" });
    run("layout.show", { id: "panel" });
  }

  showCi() {
    const root = layout();
    if (find(root, "sidebar-views") && find(root, "ci")) {
      run("layout.select", { stack: "sidebar-views", child: "ci" });
      return run("layout.show", { id: "sidebar" });
    }
    if (!find(root, "ci")) return notify({ title: "No CI panel in this layout" });
    run("layout.select", { stack: "panel-body", child: "ci" });
    run("layout.show", { id: "panel" });
  }

  // ── drawing ────────────────────────────────────────────────────────────────────────────
  chip(t, id, { icon, color, tip, onClick }, ...kids) {
    const vs = this.style === "vscode";
    return h_flex().id(id).h(20).px(6).gap(5).flex_none().items_center().rounded(5).text_size(vs ? 12 : 11.5).text_color(color ?? t.muted)
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .when(Boolean(onClick), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { onClick(cx); cx.notify(); }))
      .when(Boolean(icon), (el) => el.child(Icon(icon, vs ? 14 : 11).text_color(color ?? t.dim)))
      .children(kids.filter((k) => k !== null && k !== undefined && k !== ""));
  }

  meterColor(t, label, pct) {
    return pct >= 95 ? t.ansi1 : pct >= 80 ? t.ansi3 : t[METER[label]] ?? t.accent;
  }

  track(t, pct, color) {
    return div().w(44).h(4).flex_none().rounded(2).bg(t.raised).child(div().h_full().rounded(2).w(Math.max(pct > 0 ? 2 : 0, 0.44 * pct)).bg(color));
  }

  renderMenu() {
    const t = theme();
    const { g } = this.menu;
    const item = (id, label, sub, verb) =>
      v_flex().id(id).px(10).py(6).gap(1).rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click(() => { closeOverlay(props()?.overlay); this.ask(g, verb); })
        .child(div().text_size(12.5).text_color(t.foreground).child(label))
        .child(div().text_size(11).text_color(t.dim).child(sub));
    const up = g.upstream ?? "its upstream";
    return v_flex().id("vx-status-menu").size_full().p(6).bg(t.popover ?? t.surface)
      .when(Boolean(g.ahead), (el) => el.child(item("push", `Push ${g.ahead} commit${g.ahead === 1 ? "" : "s"}…`, `to ${up}`, "push")))
      .when(Boolean(g.behind), (el) => el.child(item("pull", `Pull ${g.behind} commit${g.behind === 1 ? "" : "s"}…`, `from ${up}, fast-forward only`, "pull")))
      .child(item("fetch", "Fetch…", "update ↑ ↓ from the remote", "fetch"));
  }

  render() {
    if (this.confirmSpec) return ConfirmView(this);
    if (this.menu) return this.renderMenu();
    const vs = this.style === "vscode";
    // props { style: "vscode" }: the current VS Code bar: plain chrome, a remote chip first, the
    // repo's pipeline and the workspace on the right.
    const base = theme();
    const t = base;
    const c = ctx();
    const g = this.g;
    const wide = this.width >= 900;
    const mid = this.width >= 620;
    const viaWorkspace = c.source === "active" || c.source === "picked";
    const folder = g?.top ? baseName(g.top) : c.cwd ? (c.cwd === home() ? "~" : baseName(c.cwd)) : null;
    const left = [
      vs ? this.chip(t, "st-remote", { icon: "remote", color: t.muted, tip: c.on ? `On ${c.on}` : "This machine" }, c.on ?? null) : null,
      viaWorkspace
        ? this.chip(t, "st-ws", { icon: "layers", color: t.accent, tip: `Showing the repo picked in Workspace (${c.root?.name ?? folder}). Focus a terminal inside a repo to follow it instead.` }, div().max_w(200).truncate().child(folder ?? ""))
        : folder ? this.chip(t, "st-folder", { icon: "folder", color: t.muted, tip: g?.top ?? c.cwd ?? "" }, div().max_w(200).truncate().child(folder)) : null,
      g?.branch || g?.detached
        ? this.chip(t, "st-branch", { icon: "branch", color: t.foreground, tip: `${g.upstream ? `Tracks ${g.upstream} · ` : ""}Click to copy`, onClick: (cx) => { cx.write_to_clipboard(g.branch ?? "HEAD"); notify({ title: "Copied", body: g.branch ?? "HEAD", timeout: 1500 }); } },
          div().max_w(wide ? 260 : 150).truncate().child(g.detached ? "detached" : g.branch))
        : null,
      g?.top ? this.chip(t, "st-sync", { icon: g.ahead ? "arrow-up" : g.behind ? "arrow-down" : "refresh", color: g.ahead ? t.ansi6 : g.behind ? t.ansi4 : t.dim, tip: g.upstream ? `↑${g.ahead} to push · ↓${g.behind} to pull · click for fetch / pull / push` : "No upstream · click to fetch", onClick: () => this.openGitMenu() },
        g.ahead || g.behind ? `${g.ahead ? `↑${g.ahead}` : ""}${g.ahead && g.behind ? " " : ""}${g.behind ? `↓${g.behind}` : ""}` : "") : null,
      g?.changed ? this.chip(t, "st-changed", { icon: "pencil", color: t.ansi3, tip: `${g.changed} changed (${g.untracked} new) · open Changes`, onClick: () => this.showChanges() }, String(g.changed)) : null,
      g?.staged && mid ? this.chip(t, "st-staged", { icon: "plus", color: t.ansi2, tip: `${g.staged} staged` }, String(g.staged)) : null,
      g?.conflicts ? this.chip(t, "st-conflicts", { icon: "alert", color: t.ansi1, tip: `${g.conflicts} with conflicts · open Changes`, onClick: () => this.showChanges() }, String(g.conflicts)) : null,
      g?.stash && mid ? this.chip(t, "st-stash", { icon: "archive", color: t.dim, tip: `${g.stash} stash${g.stash === 1 ? "" : "es"}` }, String(g.stash)) : null,
      g && g.top && !g.changed && mid ? div().text_size(11).text_color(t.dim).child("clean") : null,
    ].filter(Boolean);
    const i = this.info && isClaude(c.focus.pane) ? this.info : null;
    const meters = (i?.meters ?? []).filter((m) => wide || m.label === "ctx");
    const right = i
      ? [
        this.chip(t, "st-model", { icon: "sparkles", color: t.foreground, tip: i.model },
          div().child(modelName(i.model)),
          mid ? div().text_color(t.dim).child([i.effort, wide ? windowLabel(i.window) : null].filter(Boolean).join(" · ")) : null),
        ...meters.map((m) => this.chip(t, `st-m-${m.label}`, { tip: `${m.label}: ${m.percent}% used` },
          div().text_color(t.dim).child(m.label), this.track(t, m.percent, this.meterColor(t, m.label, m.percent)), div().child(`${m.percent}%`))),
      ]
      : [];
    if (vs) {
      // ✕ errors ⚠ warnings (workspace + Run checks) and listening ports: open the panel there.
      const pc = countProblems(workspaceProblems(workspace()?.roots ?? [], shared("vx.git") ?? {}, shared("vx.ci.summary") ?? {}), shared("vx.checks") ?? {});
      const openPanel = (view) => { setShared("vx.panel", { ...(shared("vx.panel") ?? {}), view }); run("layout.show", { id: "bottom" }); };
      left.push(this.chip(t, "st-problems", { color: pc.errors ? t.ansi1 : t.muted, tip: `${pc.errors} errors, ${pc.warnings} warnings · open Problems`, onClick: () => openPanel("problems") },
        div().child(`✕ ${pc.errors}`), div().text_color(pc.warnings ? t.ansi3 : t.muted).child(`⚠ ${pc.warnings}`)));
      const ports = shared("vx.ports");
      if (ports && mid) left.push(this.chip(t, "st-ports", { icon: "plug", color: t.muted, tip: `${ports} listening port${ports === 1 ? "" : "s"} · open Ports`, onClick: () => openPanel("ports") }, String(ports)));
      // The repo's latest pipeline (vx-ci publishes it) and the workspace's name.
      const ci = g?.top ? shared("vx.ci.summary")?.[g.top] : null;
      if (ci) {
        const look = stateLook(ci.kind, base);
        const word = { success: "passed", failure: "failed", running: "running", queued: "queued", manual: "manual", canceled: "canceled", skipped: "skipped", warning: "warning" }[ci.kind] ?? ci.kind;
        right.push(this.chip(t, "st-ci", { icon: "ci", color: look.color, tip: `CI: ${ci.label ?? word}${ci.number ? ` #${ci.number}` : ""} · open CI / CD`, onClick: () => this.showCi() },
          div().child(`${look.glyph} ${word}`)));
      }
      const ws = workspace();
      if (ws?.name && mid) right.push(this.chip(t, "st-wsname", { icon: "layers", color: t.muted, tip: ws.file ?? ws.name }, ws.name));
    }
    return h_flex().id(MOD).size_full().px(vs ? 6 : 10).gap(vs ? 2 : 4).items_center().overflow_hidden().bg(vs ? t.canvas ?? t.chrome : t.chrome).when(!vs, (el) => el.border_t(1).border_color(t.border))
      .text_size(TEXT.small).text_color(t.muted)
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 8) { this.width = size.width; cx.notify(); } })
      .children(left)
      .child(div().flex_1().min_w(8))
      .children(right);
  }
}

Object.assign(VxStatus.prototype, confirmMethods);
export default VxStatus;
