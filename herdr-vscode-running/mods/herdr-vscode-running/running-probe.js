// What the Running view reads on a timer: the git line of the repo folders it shows, and the
// orch work of idle agents. Both notify only when a value changes, never per tick.
import { exec, hc, home } from "herdr";
import { git } from "./ws.js";
import { parseStatus } from "./git-core.js";
import { gitCounts, formatGitLine, parseActivity, parseOrchJobs, orchLookup } from "./running-core.js";

class RunningProbe {
  static GIT_REFRESH_MS = 4000;
  static ORCH_REFRESH_MS = 3000;
  static GIT_TIMEOUT_MS = 8000;
  static ORCH_TIMEOUT_MS = 5000;
  static STATUS_ARGS = ["status", "--porcelain=v1", "-z", "-b", "--no-renames", "--untracked-files=all"];
  static JOBS_ARGS = ["ls", "--json", "--all", "--label", "orch=1"];
  static ACTIVITY_DIR = ".harness-orch/activity";
  // Fresh records only (orch drops a record after 120 s): each printed on its own line.
  static ACTIVITY_SCRIPT = 'find "$1" -maxdepth 1 -name "*.json" -mmin -3 -size -9k -print0 2>/dev/null | xargs -0 -n1 sh -c \'cat "$0"; echo\'';

  constructor() {
    this.lines = new Map();
    this.wanted = [];
    this.activity = new Map();
    this.jobs = new Map();
    this.signature = "";
  }

  start(cx) {
    cx.timer.every(RunningProbe.GIT_REFRESH_MS, (cx) => this.refreshGit(cx));
    cx.timer.every(RunningProbe.ORCH_REFRESH_MS, (cx) => this.refreshOrch(cx));
    this.refreshOrch(cx);
  }

  // The repo folders on screen: [{ path, on }], set while rendering.
  want(repos) {
    this.wanted = repos;
  }

  // Reads the repos shown since the last tick without waiting for it.
  kick(cx) {
    if (this.wanted.some((repo) => !this.lines.has(repo.path))) {
      this.refreshGit(cx);
    }
  }

  lineOf(path) {
    return this.lines.get(path) ?? null;
  }

  orchOf() {
    return orchLookup({ activity: this.activity, jobs: this.jobs });
  }

  refreshGit(cx) {
    if (this.busy || this.wanted.length === 0) {
      return;
    }
    this.busy = true;
    const repos = this.wanted;
    cx.spawn(async (cx) => {
      let changed = false;
      for (const repo of repos) {
        const result = await git(RunningProbe.STATUS_ARGS, { cwd: repo.path, on: repo.on, timeout: RunningProbe.GIT_TIMEOUT_MS }).catch(() => null);
        const line = result?.code === 0 ? formatGitLine(gitCounts(parseStatus(result.stdout))) : null;
        changed ||= this.lines.get(repo.path) !== line;
        this.lines.set(repo.path, line);
      }
      this.busy = false;
      if (changed) {
        cx.notify();
      }
    });
  }

  refreshOrch(cx) {
    cx.spawn(async (cx) => {
      const [activity, jobs] = await Promise.all([
        exec("sh", ["-c", RunningProbe.ACTIVITY_SCRIPT, "herdr-vscode-orch", `${home()}/${RunningProbe.ACTIVITY_DIR}`], { timeout: RunningProbe.ORCH_TIMEOUT_MS }).catch(() => null),
        hc(RunningProbe.JOBS_ARGS).catch(() => null),
      ]);
      this.activity = parseActivity(activity?.stdout ?? "", Date.now());
      this.jobs = parseOrchJobs(jobs?.code === 0 ? jobs.stdout : "");
      const signature = JSON.stringify([[...this.activity], [...this.jobs]]);
      if (signature !== this.signature) {
        this.signature = signature;
        cx.notify();
      }
    });
  }
}

export default RunningProbe;
