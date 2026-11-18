// Finds the activity-bar extensions installed in the app's mods folder (the rules are in
// extensions-core.js). vx-activity scans and publishes them in shared("vx.extensions").
import { exec, appHome, readTextFile, shared, setShared } from "herdr";
import { MANIFEST_FILE, parseManifest } from "./extensions-core.js";

const EXTENSIONS_KEY = "vx.extensions";
const SCRIPT_NAME = "vx-ext";
// Prints the folder name of every mods/<folder>/vx-extension.json.
const LIST_SCRIPT = 'for f in "$1"/*/"$2"; do [ -f "$f" ] && basename "$(dirname "$f")"; done; exit 0';

export const modsDir = () => `${appHome()}/mods`;

export async function scanExtensions() {
  const listing = await exec("sh", ["-c", LIST_SCRIPT, SCRIPT_NAME, modsDir(), MANIFEST_FILE]).catch(() => null);
  const folders = (listing?.stdout ?? "").split("\n").filter(Boolean);
  const manifests = [];
  const errors = [];
  for (const folder of folders) {
    const source = await readTextFile(`${modsDir()}/${folder}/${MANIFEST_FILE}`).catch(() => null);
    const parsed = parseManifest(source ?? "", folder);
    if (parsed.manifest) {
      manifests.push(parsed.manifest);
    } else {
      errors.push(parsed.error);
    }
  }
  return { manifests, errors };
}

export const extensions = () => shared(EXTENSIONS_KEY)?.manifests ?? [];

// Returns true when the published list changed.
export function publishExtensions(found) {
  const before = JSON.stringify(shared(EXTENSIONS_KEY) ?? null);
  if (before === JSON.stringify(found)) {
    return false;
  }
  setShared(EXTENSIONS_KEY, found);
  return true;
}
