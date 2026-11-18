// Every user setting of the herdr-vscode mods lives in ~/.config/herdr-vscode/settings.json, one
// section per feature. Reads are synchronous from a shared() cache that loadSettings() fills;
// setSetting() updates the cache and writes the file (read-modify-write, so other keys stay).
import { shared, setShared, home, exec, readTextFile, writeTextFile, checking, watchFolder } from "herdr";
import { logError } from "./log.js";
import { parseSettings, readSetting, withSettings, formatSettings } from "./settings-core.js";

const MOD = "herdr-vscode-settings";
const CACHE_KEY = "herdr-vscode.settings";
const SETTINGS_DIR = ".config/herdr-vscode";
const SETTINGS_FILE = "settings.json";
const MKDIR_TIMEOUT_MS = 5000;

let loading = null;
let writing = Promise.resolve();

export const settingsDir = () => `${home()}/${SETTINGS_DIR}`;
export const settingsPath = () => `${settingsDir()}/${SETTINGS_FILE}`;

async function readSettingsFile() {
  const text = await readTextFile(settingsPath()).catch(() => null);
  const { settings, error } = parseSettings(text);
  if (error) {
    logError(MOD, "settings.json is not valid JSON", error);
  }
  return { text, settings, error };
}

// Fills the cache from the file once; `force` re-reads it (the activity mod does at startup).
export function loadSettings({ force = false } = {}) {
  const cached = shared(CACHE_KEY);
  if (cached && !force) {
    return Promise.resolve(cached);
  }
  loading ??= readSettingsFile()
    .then(({ settings }) => {
      setShared(CACHE_KEY, settings);
      return settings;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

// For a view's init: loads the settings, then runs `apply` (to copy settings into the view) and re-renders.
export function whenSettings(cx, apply = () => {}) {
  if (checking()) {
    return;
  }
  cx.spawn(async (cx) => {
    await loadSettings();
    apply(cx);
    cx.notify();
  });
}

export const settingsLoaded = () => Boolean(shared(CACHE_KEY));

export const getSetting = (section, key, fallback) => readSetting(shared(CACHE_KEY), section, key, fallback);

async function writeSettings(section, values) {
  try {
    const { text, settings, error } = await readSettingsFile();
    if (error) {
      return;
    }
    await exec("mkdir", ["-p", settingsDir()], { timeout: MKDIR_TIMEOUT_MS });
    await writeTextFile(settingsPath(), formatSettings(withSettings(settings, section, values)), text);
  } catch (error) {
    logError(MOD, "could not save settings.json", String(error?.message ?? error));
  }
}

export function setSettings(section, values) {
  const loaded = settingsLoaded();
  setShared(CACHE_KEY, withSettings(shared(CACHE_KEY) ?? {}, section, values));
  if (checking()) {
    return Promise.resolve();
  }
  writing = writing.then(() => writeSettings(section, values));
  if (!loaded) {
    // The cache held only this change: refill it with the rest of the file.
    writing = writing.then(() => loadSettings({ force: true }));
  }
  return writing;
}

export const setSetting = (section, key, value) => setSettings(section, { [key]: value });

// Re-reads settings.json when it changes on disk (a hand edit, the VS Code importer), so every
// view that reads getSetting() at render follows at once. One mod (activity) runs this.
export function watchSettings(cx) {
  if (checking()) {
    return;
  }
  cx.spawn(async () => {
    await exec("mkdir", ["-p", settingsDir()], { timeout: MKDIR_TIMEOUT_MS }).catch(() => null);
    for (;;) {
      try {
        await watchFolder(settingsDir());
      } catch {
        return;
      }
      await loadSettings({ force: true });
    }
  });
}
