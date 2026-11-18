// Shares ~/.local/state/herdr-folders/state.json with herdr-folders, so a setting changed in one
// shows in the other. Only keys of the right type are read; every other key is kept on write.
import { home, readTextFile, writeTextFile } from "herdr";
import { pickPrefs, DEFAULT_PREFS } from "./running-core.js";
import { logError } from "./log.js";

export { DEFAULT_PREFS };

const STATE_FILE = ".local/state/herdr-folders/state.json";
const SAVE_ATTEMPTS = 3;
const statePath = () => `${home()}/${STATE_FILE}`;

export async function loadPrefs() {
  try {
    const text = await readTextFile(statePath());
    return pickPrefs(text ? JSON.parse(text) : null);
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

// The write is refused when the file changed since it was read; the next attempt reads again.
export async function savePrefs(patch) {
  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
    try {
      const text = await readTextFile(statePath());
      const next = { ...(text ? JSON.parse(text) : {}), ...patch };
      await writeTextFile(statePath(), `${JSON.stringify(next, null, 2)}\n`, text);
      return true;
    } catch (error) {
      logError("herdr-vscode-running", "saving state.json failed", String(error?.message ?? error));
    }
  }
  return false;
}
