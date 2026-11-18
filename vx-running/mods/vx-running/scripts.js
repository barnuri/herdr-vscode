// package.json scripts for a repo: the project and its workspace packages, the package manager
// (packageManager, else the lockfile, else npm; switchable per project), and running a script.
import { readTextFile, exec, run, shared, setShared, home, spaces } from "herdr";
import { baseName } from "./ws.js";

const MOD = "vx-scripts";
const STORE_KEY = "vx.scripts";
const MAX_LEVELS_UP = 6;
const MAX_WORKSPACE_PACKAGES = 60;
const MAX_RECENT = 3;
const DEFAULT_PM = "npm";
const PREFERRED_SCRIPTS = ["dev", "start", "serve"];
export const PMS = ["npm", "pnpm", "bun", "yarn"];
export const PM_ICON = (pm) => `mods/vx-icons/icons/${pm}.svg`;
const DECLARED_PM = /^(npm|pnpm|yarn|bun)@/;
const LOCKFILE_SCRIPT = 'for f in bun.lock bun.lockb pnpm-lock.yaml yarn.lock package-lock.json; do [ -e "$1/$f" ] && { printf "%s" "$f"; exit 0; }; done; exit 0';
const PM_BY_LOCKFILE = { "bun.lock": "bun", "bun.lockb": "bun", "pnpm-lock.yaml": "pnpm", "yarn.lock": "yarn", "package-lock.json": "npm" };
const INSTALLED_SCRIPT = 'for p in npm pnpm bun yarn; do command -v "$p" >/dev/null 2>&1 && printf "%s\\n" "$p"; done; exit 0';
// Workspace package folders: each pattern's matches that hold a package.json ($1 root, then patterns).
const EXPAND_SCRIPT = 'cd -- "$1" && shift && for pat in "$@"; do for d in $pat; do [ -f "$d/package.json" ] && printf "%s\\n" "$d"; done; done; exit 0';
const PNPM_PACKAGE_LINE = /^\s*-\s*['"]?([^'"\n#]+?)['"]?\s*$/gm;

export const store = () => shared(STORE_KEY) ?? { chosen: {}, recent: {}, pm: {} };
export const save = (patch) => setShared(STORE_KEY, { ...store(), ...patch });

async function readPackage(dir, on) {
  const text = await readTextFile(`${dir}/package.json`, { on }).catch(() => null);
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const scriptsOf = (pkg) => Object.entries(pkg?.scripts ?? {}).map(([name, cmd]) => ({ name, cmd: String(cmd) }));

const execQuiet = (args, on) => exec("sh", args, { on }).catch(() => null);

async function detectPackageManager(pkg, dir, on) {
  const declared = DECLARED_PM.exec(pkg.packageManager ?? "")?.[1] ?? null;
  const lock = await execQuiet(["-c", LOCKFILE_SCRIPT, MOD, dir], on);
  const detected = declared ?? PM_BY_LOCKFILE[lock?.stdout?.trim()] ?? DEFAULT_PM;
  const installedRun = await execQuiet(["-lc", INSTALLED_SCRIPT], on);
  const installed = (installedRun?.stdout ?? "").split("\n").filter((pm) => PMS.includes(pm));
  return { detected, declared: Boolean(declared), installed: installed.length ? installed : [detected] };
}

// npm / yarn / bun "workspaces", else pnpm-workspace.yaml "packages".
async function workspacePatterns(pkg, dir, on) {
  const patterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages ?? [];
  if (patterns.length) {
    return patterns;
  }
  const yaml = await readTextFile(`${dir}/pnpm-workspace.yaml`, { on }).catch(() => null);
  return [...(yaml ?? "").matchAll(PNPM_PACKAGE_LINE)].map((match) => match[1]);
}

async function workspaceGroups(pkg, dir, on) {
  const patterns = await workspacePatterns(pkg, dir, on);
  if (!patterns.length) {
    return [];
  }
  const globs = patterns.map((pattern) => pattern.replace(/\/\*\*$/, "/*"));
  const expanded = await execQuiet(["-c", EXPAND_SCRIPT, MOD, dir, ...globs], on);
  const folders = [...new Set((expanded?.stdout ?? "").split("\n").filter(Boolean))].slice(0, MAX_WORKSPACE_PACKAGES);
  const groups = [];
  for (const rel of folders) {
    const sub = await readPackage(`${dir}/${rel}`, on);
    if (scriptsOf(sub).length) {
      groups.push({ name: sub.name ?? rel, dir: `${dir}/${rel}`, rel, scripts: scriptsOf(sub) });
    }
  }
  return groups;
}

async function projectAt(pkg, dir, on) {
  const pm = await detectPackageManager(pkg, dir, on);
  const groups = [{ name: pkg.name ?? baseName(dir), dir, scripts: scriptsOf(pkg) }, ...(await workspaceGroups(pkg, dir, on))];
  if (!groups.some((group) => group.scripts.length)) {
    return null;
  }
  return { root: dir, on, name: groups[0].name, ...pm, groups };
}

export async function findProject(start, on) {
  let dir = start;
  for (let level = 0; dir && level <= MAX_LEVELS_UP; level++) {
    const pkg = await readPackage(dir, on);
    if (pkg && (scriptsOf(pkg).length || pkg.workspaces)) {
      return projectAt(pkg, dir, on);
    }
    if (dir === home() || dir === "/") {
      break;
    }
    dir = dir.replace(/\/[^/]+\/?$/, "") || "/";
  }
  return null;
}

export const pmOf = (project) => {
  const pick = store().pm?.[project.root];
  return pick && project.installed.includes(pick) ? pick : project.detected;
};
export const keyOf = (group, script) => `${group.rel ?? ""}::${script.name}`;
export const allScripts = (project) => project.groups.flatMap((group) => group.scripts.map((script) => ({ g: group, s: script, key: keyOf(group, script) })));

export function chosenOf(project) {
  const all = allScripts(project);
  const pick = store().chosen?.[project.root];
  const preferred = PREFERRED_SCRIPTS.map((name) => all.find((entry) => !entry.g.rel && entry.s.name === name)).find(Boolean);
  return all.find((entry) => entry.key === pick) ?? preferred ?? all[0];
}

export function runScript(project, entry, beside = false) {
  const saved = store();
  const recent = [entry.key, ...(saved.recent?.[project.root] ?? []).filter((key) => key !== entry.key)].slice(0, MAX_RECENT);
  save({ chosen: { ...saved.chosen, [project.root]: entry.key }, recent: { ...saved.recent, [project.root]: recent } });
  const argv = [pmOf(project), "run", entry.s.name];
  if (beside) {
    run("pane.split", { direction: "right", argv, folder: entry.g.dir });
    return;
  }
  const name = entry.g.rel ? `${baseName(entry.g.rel)}:${entry.s.name}` : entry.s.name;
  run("tab.new", { name, folder: entry.g.dir, argv, space: spaces().find((space) => space.active)?.id });
}
