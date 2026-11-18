// Finds the activity-bar extensions installed in the app's mods folder (the rules are in
// extensions-core.js). herdr-vscode-activity scans and publishes them in shared("herdr-vscode.extensions").
import { exec, appHome, readTextFile, shared, setShared } from "herdr";
import { MANIFEST_FILE, LEGACY_MANIFEST_FILE, parseManifest } from "./extensions-core.js";
import { logError } from "./log.js";

const EXTENSIONS_KEY = "herdr-vscode.extensions";
const SCRIPT_NAME = "herdr-vscode-ext";
// Prints "<folder>/<manifest>" for every mod folder with a manifest ($2, else the old name $3).
const LIST_SCRIPT = 'for d in "$1"/*/; do if [ -f "$d$2" ]; then echo "$(basename "$d")/$2"; elif [ -f "$d$3" ]; then echo "$(basename "$d")/$3"; fi; done; exit 0';

export const modsDir = () => `${appHome()}/mods`;

export async function scanExtensions() {
  const listing = await exec("sh", ["-c", LIST_SCRIPT, SCRIPT_NAME, modsDir(), MANIFEST_FILE, LEGACY_MANIFEST_FILE]).catch((error) => {
    logError("extensions", "extension scan failed", String(error?.message ?? error));
    return null;
  });
  const folders = (listing?.stdout ?? "").split("\n").filter(Boolean);
  const manifests = [];
  const errors = [];
  for (const entry of folders) {
    const folder = entry.split("/")[0];
    const source = await readTextFile(`${modsDir()}/${entry}`).catch(() => null);
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
