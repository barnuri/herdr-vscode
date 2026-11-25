// What the Running view reads on a timer: the git line of the repo folders it shows, and the
// orch work of idle agents. Both notify only when a value changes, never per tick.
import { exec, hc, home, window } from "herdr";
import { git } from "./ws.js";
import { parseStatus } from "./git-core.js";
import { PollPacer, stalest } from "./poll-core.js";
import { gitCounts, formatGitLine, parseActivity, parseOrchJobs, orchLookup } from "./running-core.js";

class RunningProbe {
  static GIT_REFRESH_MS = 4000;
  // Idle repos back off to this; a slow git call (a loaded machine) stretches it further.
  static GIT_MAX_MS = 30000;
  // Repos read per pass, so many repos cannot start many git processes at once.
  static GIT_REPOS_PER_PASS = 3;
  // A repo read less than this long ago is not read again by the timer.
  static GIT_MIN_AGE_MS = 3000;
  static ORCH_REFRESH_MS = 3000;
  static ORCH_MAX_MS = 10000;
  static GIT_TIMEOUT_MS = 8000;
  static ORCH_TIMEOUT_MS = 5000;
  // "normal" lists an untracked folder as one entry: "all" walks and lists every file in it.
  static STATUS_ARGS = ["status", "--porcelain=v1", "-z", "-b", "--no-renames", "--untracked-files=normal"];
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
    this.fetchedAt = new Map();
    this.pacer = new PollPacer({ baseMs: RunningProbe.GIT_REFRESH_MS, maxMs: RunningProbe.GIT_MAX_MS });
    this.orchPacer = new PollPacer({ baseMs: RunningProbe.ORCH_REFRESH_MS, maxMs: RunningProbe.ORCH_MAX_MS });
  }

  start(cx) {
    this.scheduleGit(cx, RunningProbe.GIT_REFRESH_MS);
    this.refreshOrch(cx, () => this.scheduleOrch(cx, this.orchPacer.nextMs()));
  }

  // The repo folders on screen: [{ path, on }], set while rendering.
  want(repos) {
    this.wanted = repos;
  }

  // Reads the repos shown since the last tick without waiting for it.
  kick(cx) {
    if (this.wanted.some((repo) => !this.lines.has(repo.path))) {
      this.pacer.reset();
      this.refreshGit(cx);
    }
  }

  lineOf(path) {
    return this.lines.get(path) ?? null;
  }

  orchOf() {
    return orchLookup({ activity: this.activity, jobs: this.jobs });
  }

  // One timer chain, not a fixed interval: the next read waits for the last one to finish and
  // backs off while nothing changes or git is slow. A hidden window reads nothing.
  scheduleGit(cx, delayMs) {
    cx.timer.after(delayMs, (cx) => {
      if (window()?.visible === false) {
        this.scheduleGit(cx, RunningProbe.GIT_REFRESH_MS);
        return;
      }
      this.refreshGit(cx, () => this.scheduleGit(cx, this.pacer.nextMs()));
    });
  }

  refreshGit(cx, done = () => {}) {
    if (this.busy || this.wanted.length === 0) {
      done();
      return;
    }
    this.busy = true;
    const startedAt = Date.now();
    const shown = this.wanted;
    const due = stalest(shown.map((repo) => repo.path), this.fetchedAt, startedAt, RunningProbe.GIT_REPOS_PER_PASS, RunningProbe.GIT_MIN_AGE_MS);
    const repos = shown.filter((repo) => due.includes(repo.path));
    cx.spawn(async (cx) => {
      let changed = false;
      try {
        for (const repo of repos) {
          const result = await git(RunningProbe.STATUS_ARGS, { cwd: repo.path, on: repo.on, timeout: RunningProbe.GIT_TIMEOUT_MS }).catch(() => null);
          const line = result?.code === 0 ? formatGitLine(gitCounts(parseStatus(result.stdout))) : null;
          changed ||= this.lines.get(repo.path) !== line;
          this.lines.set(repo.path, line);
          this.fetchedAt.set(repo.path, Date.now());
        }
      } finally {
        this.busy = false;
        this.pacer.note({ changed, tookMs: repos.length ? (Date.now() - startedAt) / repos.length : 0 });
        done();
      }
      if (changed) {
        cx.notify();
      }
    });
  }

  scheduleOrch(cx, delayMs) {
    cx.timer.after(delayMs, (cx) => {
      if (window()?.visible === false) {
        this.scheduleOrch(cx, RunningProbe.ORCH_REFRESH_MS);
        return;
      }
      this.refreshOrch(cx, () => this.scheduleOrch(cx, this.orchPacer.nextMs()));
    });
  }

  refreshOrch(cx, done = () => {}) {
    const startedAt = Date.now();
    cx.spawn(async (cx) => {
      let changed = false;
      try {
        const [activity, jobs] = await Promise.all([
          exec("sh", ["-c", RunningProbe.ACTIVITY_SCRIPT, "herdr-vscode-orch", `${home()}/${RunningProbe.ACTIVITY_DIR}`], { timeout: RunningProbe.ORCH_TIMEOUT_MS }).catch(() => null),
          hc(RunningProbe.JOBS_ARGS).catch(() => null),
        ]);
        this.activity = parseActivity(activity?.stdout ?? "", Date.now());
        this.jobs = parseOrchJobs(jobs?.code === 0 ? jobs.stdout : "");
        const signature = JSON.stringify([[...this.activity], [...this.jobs]]);
        changed = signature !== this.signature;
        this.signature = signature;
      } finally {
        this.orchPacer.note({ changed, tookMs: Date.now() - startedAt });
        done();
      }
      if (changed) {
        cx.notify();
      }
    });
  }
}

export default RunningProbe;
