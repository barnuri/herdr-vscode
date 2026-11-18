// The auto-update worker. herdr-vscode-titlebar (always on screen in herdr-vscode) and the herdr-vscode-updates view both
// start one; the shared lease lets only one of them check and install (rules in updates-core.js).
import { checking, updates, agents, run, shared, setShared, home, exec, readTextFile, writeTextFile } from "herdr";
import { logInfo, toast } from "./log.js";
import { UPDATE_CONFIG_FILE, readUpdateConfig, withUpdateConfig, appPlan, corePlan, checkDue, canAct } from "./updates-core.js";

class UpdatesWorker {
  static TICK_MS = 60000;
  static FIRST_TICK_MS = 5000;
  static LEASE_KEY = "herdr-vscode.updates.lease";
  static LEASE_TTL_MS = 180000;
  static ATTEMPT_KEY = "herdr-vscode.updates.lastAttempt";
  static STATUS_KEY = "herdr-vscode.updates.status";
  static BADGE_KEY = "herdr-vscode.updates.badge";
  // While this file exists in the app home, nothing is installed or restarted, only reported.

  static configPath() {
    return `${home()}/${UPDATE_CONFIG_FILE}`;
  }

  static async readConfigFile() {
    const text = await readTextFile(UpdatesWorker.configPath()).catch(() => null);
    return { text, ...readUpdateConfig(text) };
  }

  // Flips one key in the shared config.json, keeping every other key.
  static async toggle(key) {
    const current = await UpdatesWorker.readConfigFile();
    if (current.error) {
      toast("herdr-vscode-updates", { title: "config.json is not valid JSON", body: current.error, level: "error" });
      return;
    }
    const next = withUpdateConfig(current.raw, { [key]: !current.config[key] });
    try {
      await exec("mkdir", ["-p", UpdatesWorker.configPath().replace(/\/[^/]*$/, "")]);
      await writeTextFile(UpdatesWorker.configPath(), `${JSON.stringify(next, null, 2)}\n`, current.text);
    } catch (error) {
      toast("herdr-vscode-updates", { title: "Couldn't save config.json", body: String(error?.message ?? error), level: "error" });
    }
  }

  // Tests set this; a live app never dry-runs and never leaves a marker file behind.
  static testDryRun = false;

  static async dryRun() {
    return UpdatesWorker.testDryRun || checking();
  }

  // What the acting copy last decided: { text, dryRun, at }.
  static status() {
    return shared(UpdatesWorker.STATUS_KEY) ?? { text: "", dryRun: false };
  }

  static checkNow() {
    setShared(UpdatesWorker.ATTEMPT_KEY, Date.now());
    run("app.check_updates");
  }

  static async act(command, what) {
    const dryRun = await UpdatesWorker.dryRun();
    if (dryRun) {
      UpdatesWorker.report(`Dry run: would run ${command} for ${what}.`, true);
      return;
    }
    logInfo("herdr-vscode-updates", `${command} for ${what}`);
    run(command);
  }

  static report(text, dryRun) {
    const before = UpdatesWorker.status();
    if (before.text !== text || before.dryRun !== dryRun) {
      setShared(UpdatesWorker.STATUS_KEY, { text, dryRun, at: Date.now() });
    }
  }

  constructor() {
    this.owner = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.coreTried = null;
  }

  start(cx) {
    cx.timer.after(UpdatesWorker.FIRST_TICK_MS, (cx) => this.tick(cx));
    cx.timer.every(UpdatesWorker.TICK_MS, (cx) => this.tick(cx));
  }

  holdLease() {
    const now = Date.now();
    if (!canAct(shared(UpdatesWorker.LEASE_KEY), this.owner, now, UpdatesWorker.LEASE_TTL_MS)) {
      return false;
    }
    setShared(UpdatesWorker.LEASE_KEY, { owner: this.owner, at: now });
    return true;
  }

  tick(cx) {
    if (!this.holdLease()) {
      return;
    }
    cx.spawn(async () => {
      const { config } = await UpdatesWorker.readConfigFile();
      const dryRun = await UpdatesWorker.dryRun();
      const info = updates();
      if (info.checks && !info.checking && checkDue(config, shared(UpdatesWorker.ATTEMPT_KEY), info.checked, Date.now())) {
        UpdatesWorker.checkNow();
      }
      this.publishBadge(info);
      const coreText = await this.applyCore(info, config);
      const appText = await this.applyApp(info, config);
      if (!dryRun || !(coreText || appText)) {
        UpdatesWorker.report([coreText, appText].filter(Boolean).join(" "), dryRun);
      }
    });
  }

  async applyCore(info, config) {
    const plan = corePlan(info, config);
    if (plan.action !== "update" || this.coreTried === info.core.ready) {
      return "";
    }
    this.coreTried = info.core.ready;
    await UpdatesWorker.act("app.update_core", `core ${info.core.ready}`);
    return `Installing core ${info.core.ready}.`;
  }

  async applyApp(info, config) {
    const plan = appPlan(info, config, agents() ?? []);
    if (plan.action === "wait") {
      return `App ${info.app.ready} is ready: waiting for ${plan.busy} agent${plan.busy === 1 ? "" : "s"} to finish.`;
    }
    if (plan.action === "update") {
      await UpdatesWorker.act("app.update", `app ${info.app.ready}`);
      return `Restarting into app ${info.app.ready}.`;
    }
    return "";
  }

  publishBadge(info) {
    const ready = [info.app?.ready, info.core?.managed ? null : info.core?.ready].filter(Boolean).length;
    const badge = ready > 0 ? ready : null;
    if (shared(UpdatesWorker.BADGE_KEY) !== badge) {
      setShared(UpdatesWorker.BADGE_KEY, badge);
    }
  }
}

export default UpdatesWorker;
