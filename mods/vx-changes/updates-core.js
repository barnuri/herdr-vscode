// Auto-update rules shared by vx-updates (which acts) and vx-titlebar (which shows the versions).
// Ported from herdr-auto-update (lib/config.js, lib/semver.js, decideUpdate in lib/updater.js),
// with two app keys: autoUpdateApp and autoUpdateCore. Pure.
export const UPDATE_CONFIG_FILE = ".config/herdr/plugins/config/barnuri.auto-update/config.json";
export const UPDATES_VIEW = "ext-updates";
export const UPDATE_DEFAULTS = {
  autoUpdateMajors: true,
  autoUpdateMinors: true,
  autoUpdatePatches: true,
  checkIntervalMinutes: 360,
  autoUpdateApp: true,
  autoUpdateCore: true,
};
export const UPDATE_TOGGLES = ["autoUpdateApp", "autoUpdateCore", "autoUpdatePatches", "autoUpdateMinors", "autoUpdateMajors"];
export const MIN_CHECK_INTERVAL_MINUTES = 15;
const BUSY_STATUSES = new Set(["working", "blocked"]);
const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)/;
const KIND_KEYS = { major: "autoUpdateMajors", minor: "autoUpdateMinors", patch: "autoUpdatePatches" };
const MS_PER_MINUTE = 60000;
const MS_PER_SECOND = 1000;

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// The config file's text as { raw, config, error }: unknown keys stay in raw for writing back.
export function readUpdateConfig(text) {
  let raw = {};
  let error = null;
  if (text && String(text).trim()) {
    try {
      const parsed = JSON.parse(text);
      raw = isObject(parsed) ? parsed : {};
      error = isObject(parsed) ? null : "not a JSON object";
    } catch (parseError) {
      error = parseError.message;
    }
  }
  const config = { ...UPDATE_DEFAULTS };
  for (const key of UPDATE_TOGGLES) {
    config[key] = typeof raw[key] === "boolean" ? raw[key] : UPDATE_DEFAULTS[key];
  }
  const interval = Number(raw.checkIntervalMinutes ?? UPDATE_DEFAULTS.checkIntervalMinutes);
  config.checkIntervalMinutes = Number.isFinite(interval) ? Math.max(MIN_CHECK_INTERVAL_MINUTES, interval) : UPDATE_DEFAULTS.checkIntervalMinutes;
  return { raw, config, error };
}

// The raw config with `patch` applied; every other key (logLevel, updateWithHandoff...) is kept.
export function withUpdateConfig(raw, patch) {
  return { ...(isObject(raw) ? raw : {}), ...patch };
}

export function parseVersion(text) {
  const match = typeof text === "string" ? VERSION_PATTERN.exec(text.trim()) : null;
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : null;
}

// "major" | "minor" | "patch" for a strictly newer latest, else null (equal, older, unparseable).
export function updateKind(current, latest) {
  const from = parseVersion(current);
  const to = parseVersion(latest);
  if (!from || !to) {
    return null;
  }
  for (const part of ["major", "minor", "patch"]) {
    if (to[part] !== from[part]) {
      return to[part] > from[part] ? part : null;
    }
  }
  return null;
}

// { action: "none" | "skip" | "update", kind } for current -> ready under this config.
export function decideUpdate(config, current, ready) {
  const kind = updateKind(current, ready);
  if (!kind) {
    return { action: "none", kind: null };
  }
  return { action: config[KIND_KEYS[kind]] ? "update" : "skip", kind };
}

export const busyAgents = (agents) => agents.filter((agent) => BUSY_STATUSES.has(agent.status));

// What to do about a downloaded app update: none, skip (off or kind not allowed), wait (an agent
// is working or blocked), or update (restart into it).
export function appPlan(info, config, agents) {
  if (!info?.app?.updates || !info.app.ready) {
    return { action: "none", kind: null, busy: 0 };
  }
  const decision = decideUpdate(config, info.app.version, info.app.ready);
  if (decision.action !== "update" || !config.autoUpdateApp) {
    return { ...decision, action: decision.action === "none" ? "none" : "skip", busy: 0 };
  }
  const busy = busyAgents(agents).length;
  return { ...decision, action: busy > 0 ? "wait" : "update", busy };
}

// What to do about a newer core: none, managed (a package manager owns it), busy (updating now),
// skip, or update.
export function corePlan(info, config) {
  const core = info?.core;
  if (!core?.ready) {
    return { action: "none", kind: null };
  }
  if (core.managed) {
    return { action: "managed", kind: null };
  }
  if (core.updating) {
    return { action: "busy", kind: null };
  }
  const decision = decideUpdate(config, core.version, core.ready);
  if (decision.action === "update" && !config.autoUpdateCore) {
    return { ...decision, action: "skip" };
  }
  return decision;
}

// A check is due when the last one (ours or the app's own) is older than the interval.
export function checkDue(config, lastAttemptMs, checkedSeconds, nowMs) {
  const last = Math.max(lastAttemptMs ?? 0, (checkedSeconds ?? 0) * MS_PER_SECOND);
  return nowMs - last >= config.checkIntervalMinutes * MS_PER_MINUTE;
}

// One copy acts at a time: it holds the lease while it renews it within `ttlMs`.
export function canAct(lease, owner, nowMs, ttlMs) {
  return !lease || lease.owner === owner || nowMs - (lease.at ?? 0) > ttlMs;
}

// The title bar text: "app 1.2.3 · core 0.9.1", and the version waiting, if any.
export function versionsLabel(info) {
  if (!info?.app) {
    return null;
  }
  const parts = [`app ${info.app.version}`];
  if (info.core?.version) {
    parts.push(`core ${info.core.version}`);
  }
  const waiting = info.app.ready ?? (info.core?.managed ? null : info.core?.ready) ?? null;
  return { text: parts.join(" · "), waiting };
}

// Release notes of the versions newer than the running app, newest first.
export function waitingNotes(info) {
  const current = info?.app?.version;
  return (info?.notes ?? []).filter((note) => updateKind(current, note.version) !== null);
}
