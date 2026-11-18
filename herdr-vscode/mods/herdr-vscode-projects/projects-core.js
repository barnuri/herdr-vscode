// Pure logic of the Projects view, ported from herdr-project-manager (lib/config.js, discover.js,
// fuzzy.js, cache.js): the config and cache it shares with that plugin, glob discovery results,
// merging, fuzzy filtering, and which projects are open as spaces.
const GIT_DIR = "/.git";
const GLOB_CHARS = /[*?[{]/;
const REGEX_SPECIALS = /[.+^$()|\\]/;
const BASE_MATCH_SCORE = 1;
const CONSECUTIVE_MATCH_BONUS = 5;
const WORD_START_BONUS = 10;
const GAP_PENALTY_PER_CHAR = 1;
const WORD_SEPARATORS = new Set(["/", "-", "_", " ", "."]);

export const CONFIG_FILE = ".config/herdr/plugins/config/barnuri.project-manager/projects.json";
// herdr gives the plugin these folders (HERDR_PLUGIN_CONFIG_DIR, HERDR_PLUGIN_STATE_DIR).
export const CACHE_FILE = ".config/herdr/plugins/state/barnuri.project-manager/projects-cache.json";
// The plugin's own defaultConfig(), written only when the file is missing.
export const DEFAULT_CONFIG = { globs: [], excludes: [], projects: [], autoOpen: true };
const GIT_NAME = ".git";
const PRUNED_NAMES = [".*", "node_modules"];
const INSIDE_ANY = /^\*\*\/([^*?[{]+)\/\*\*$/;
export const MANUAL = "manual";
export const GLOB = "glob";

const trimSlash = (path) => (path.length > 1 ? path.replace(/\/+$/, "") : path);

export function baseName(path) {
  return String(path).split("/").filter(Boolean).pop() ?? path;
}

function parentOf(path) {
  return trimSlash(path).replace(/\/[^/]*$/, "") || "/";
}

// projects.json as { raw, error }: a missing file is the empty config, broken JSON an error.
export function parseConfigText(text) {
  if (text === null || text === undefined || !String(text).trim()) {
    return { raw: null, error: null };
  }
  try {
    const raw = JSON.parse(text);
    return raw && typeof raw === "object" && !Array.isArray(raw) ? { raw, error: null } : { raw: null, error: "not a JSON object" };
  } catch (error) {
    return { raw: null, error: error.message };
  }
}

export function expandHome(path, home) {
  if (path === "~") {
    return home;
  }
  return path.startsWith("~/") ? `${home}/${path.slice(2)}` : path;
}

const strings = (list) => (Array.isArray(list) ? list.filter((item) => typeof item === "string") : []);

export function normalizeConfig(raw, home) {
  const config = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const projects = [];
  for (const entry of Array.isArray(config.projects) ? config.projects : []) {
    if (!entry || typeof entry !== "object" || typeof entry.path !== "string") {
      continue;
    }
    const path = trimSlash(expandHome(entry.path, home));
    projects.push({ name: typeof entry.name === "string" && entry.name ? entry.name : baseName(path), path });
  }
  const autoOpen = typeof config.autoOpen === "boolean" ? config.autoOpen : DEFAULT_CONFIG.autoOpen;
  return { globs: strings(config.globs), excludes: strings(config.excludes), projects, autoOpen };
}

// The raw config without the manual project at `path`; every other key is kept.
export function removeManualProject(raw, path) {
  const config = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : DEFAULT_CONFIG;
  const projects = Array.isArray(config.projects) ? config.projects : [];
  return { ...config, projects: projects.filter((entry) => trimSlash(String(entry?.path ?? "")) !== trimSlash(path)) };
}

// Alphabetical and case-insensitive, like the plugin's localeCompare in Node (the app's
// runtime compares uppercase first, so case is folded here).
export function byName(left, right) {
  const folded = left.name.toLowerCase().localeCompare(right.name.toLowerCase());
  return folded || left.name.localeCompare(right.name);
}

export function sortProjects(projects) {
  return [...projects].sort(byName);
}

function literalRoot(pattern) {
  const segments = pattern.split("/");
  const firstGlob = segments.findIndex((segment) => GLOB_CHARS.test(segment));
  return segments.slice(0, firstGlob).join("/") || "/";
}

// How to expand each glob fast. A glob ending in /.git becomes one `find` from its literal root
// that prints .git entries (checked first, so a pruned folder's own .git still counts) and
// never walks hidden folders (Node's ** skips them too), node_modules, a plain-path exclude, or
// the inside of a "**/<name>/**" exclude; its matches are then checked against the glob.
// Any other glob is left to the shell.
export function discoveryPlan(globs, excludes, home) {
  const expanded = strings(excludes).map((pattern) => trimSlash(expandHome(pattern.trim(), home)));
  // "**/out/**" excludes only what is inside an out folder, so find may skip its contents.
  const insideAny = expanded.map((pattern) => INSIDE_ANY.exec(pattern)?.[1]).filter(Boolean).map((literal) => `*/${literal}/*`);
  const prunes = [...expanded.filter((path) => path.startsWith("/") && !GLOB_CHARS.test(path)), ...insideAny];
  const finds = [];
  const shell = [];
  for (const glob of globs.filter((pattern) => pattern.trim())) {
    const expanded = expandHome(glob, home);
    if (baseName(expanded) === GIT_NAME && GLOB_CHARS.test(expanded)) {
      finds.push({ glob: expanded, root: literalRoot(expanded) });
    } else {
      shell.push(expanded);
    }
  }
  return { finds, shell, prunes };
}

export function findArgs(root, prunes) {
  const pruned = [...PRUNED_NAMES.flatMap((name) => ["-name", name]), ...prunes.flatMap((path) => ["-path", path])];
  const either = pruned.flatMap((part, index) => (index > 0 && index % 2 === 0 ? ["-o", part] : [part]));
  return [root, "-mindepth", "1", "(", "-name", GIT_NAME, "-print", "-prune", ")", "-o", "(", ...either, ")", "-prune"];
}

export function findMatches(stdout, glob) {
  const pattern = globToRegExp(glob);
  return String(stdout ?? "").split("\n").filter((line) => line && pattern.test(line));
}

// The raw config with `path` pinned as a manual project (unchanged when already there).
export function addManualProject(raw, path, name) {
  const config = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : { globs: [], projects: [] };
  const projects = Array.isArray(config.projects) ? config.projects : [];
  if (projects.some((entry) => trimSlash(String(entry?.path ?? "")) === trimSlash(path))) {
    return config;
  }
  return { ...config, projects: [...projects, { name: name ?? baseName(path), path }] };
}

export function pickCache(parsed) {
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((entry) => entry && typeof entry === "object" && typeof entry.path === "string" && typeof entry.name === "string");
}

function braceAlternatives(pattern, start) {
  const end = pattern.indexOf("}", start);
  if (end === -1) {
    return null;
  }
  const options = pattern.slice(start + 1, end).split(",").map((option) => option.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&"));
  return { source: `(?:${options.join("|")})`, end };
}

function globToken(pattern, index) {
  const char = pattern[index];
  if (pattern.startsWith("**/", index)) {
    return { source: "(?:.*/)?", next: index + 3 };
  }
  if (pattern.startsWith("**", index)) {
    return { source: ".*", next: index + 2 };
  }
  const simple = { "*": "[^/]*", "?": "[^/]" };
  if (char in simple) {
    return { source: simple[char], next: index + 1 };
  }
  if (char === "{") {
    const brace = braceAlternatives(pattern, index);
    return brace ? { source: brace.source, next: brace.end + 1 } : { source: "\\{", next: index + 1 };
  }
  if (char === "[") {
    const close = pattern.indexOf("]", index + 1);
    return close === -1 ? { source: "\\[", next: index + 1 } : { source: pattern.slice(index, close + 1).replace("[!", "[^"), next: close + 1 };
  }
  return { source: REGEX_SPECIALS.test(char) || char === "]" || char === "}" ? `\\${char}` : char, next: index + 1 };
}

// A glob (*, ?, **, [abc], {a,b}) as an anchored RegExp, for path.matchesGlob-like matching.
export function globToRegExp(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length;) {
    const token = globToken(pattern, index);
    source += token.source;
    index = token.next;
  }
  return new RegExp(`^${source}$`);
}

// An exclude beats every glob: a glob match, or a plain path that covers the project's tree.
export function isExcluded(path, excludes, home) {
  return strings(excludes).some((pattern) => {
    if (!pattern.trim()) {
      return false;
    }
    const expanded = trimSlash(expandHome(pattern, home));
    if (GLOB_CHARS.test(expanded) && globToRegExp(expanded).test(path)) {
      return true;
    }
    return path === expanded || path.startsWith(`${expanded}/`);
  });
}

// A match on ".git" registers its parent folder as the project.
export function projectDirOf(match) {
  const path = trimSlash(match);
  return path.endsWith(GIT_DIR) ? parentOf(path) : path;
}

export function discovered(matches, excludes, home) {
  const byPath = new Map();
  for (const match of matches) {
    const path = projectDirOf(match);
    if (path && !byPath.has(path) && !isExcluded(path, excludes, home)) {
      byPath.set(path, { name: baseName(path), path, source: GLOB });
    }
  }
  return [...byPath.values()];
}

function suffixesAt(parents, depth) {
  return parents.map((segments) => segments.slice(-depth).join("/"));
}

// Same-named projects get as much of their parent path as tells them apart: "api (work)".
function disambiguate(projects) {
  const groups = new Map();
  for (const project of projects) {
    groups.set(project.name, [...(groups.get(project.name) ?? []), project]);
  }
  const renamed = new Map();
  for (const group of [...groups.values()].filter((list) => list.length > 1)) {
    const parents = group.map((project) => parentOf(project.path).split("/").filter(Boolean));
    const deepest = Math.max(...parents.map((segments) => segments.length));
    let depth = 1;
    let suffixes = suffixesAt(parents, depth);
    while (new Set(suffixes).size < suffixes.length && depth < deepest) {
      depth++;
      suffixes = suffixesAt(parents, depth);
    }
    group.forEach((project, index) => renamed.set(project, `${project.name} (${suffixes[index]})`));
  }
  return projects.map((project) => (renamed.has(project) ? { ...project, name: renamed.get(project) } : project));
}

// Manual projects win over discovered ones at the same path; sorted by name.
export function mergeProjects(manual, found) {
  const byPath = new Map();
  for (const project of manual) {
    byPath.set(trimSlash(project.path), { ...project, source: MANUAL });
  }
  for (const project of found) {
    if (!byPath.has(trimSlash(project.path))) {
      byPath.set(trimSlash(project.path), project);
    }
  }
  return disambiguate([...byPath.values()].sort(byName));
}

const isWordStart = (text, index) => index === 0 || WORD_SEPARATORS.has(text[index - 1]);

// Greedy subsequence score (higher is better), or null when the query doesn't match.
export function fuzzyScore(text, query) {
  if (!query) {
    return 0;
  }
  const lower = text.toLowerCase();
  let score = 0;
  let previous = -1;
  for (const char of query.toLowerCase()) {
    const index = lower.indexOf(char, previous + 1);
    if (index === -1) {
      return null;
    }
    score += BASE_MATCH_SCORE;
    score += previous !== -1 && index === previous + 1 ? CONSECUTIVE_MATCH_BONUS : 0;
    score += isWordStart(lower, index) ? WORD_START_BONUS : 0;
    score -= (index - previous - 1) * GAP_PENALTY_PER_CHAR;
    previous = index;
  }
  return score;
}

export function fuzzyFilter(projects, query) {
  const text = String(query ?? "").trim();
  if (!text) {
    return projects;
  }
  return projects
    .map((project) => ({ project, score: fuzzyScore(project.name, text) }))
    .filter((entry) => entry.score !== null)
    .sort((left, right) => right.score - left.score || byName(left.project, right.project))
    .map((entry) => entry.project);
}

// The space working in this project: its folder is the project, on this computer.
export function spaceFor(project, spaces) {
  const path = trimSlash(project.path);
  return spaces.find((space) => !space.machine && trimSlash(space.folder ?? "") === path) ?? null;
}

// Projects some terminal works in (its folder is the project or inside it).
export function busyPaths(projects, panes) {
  const cwds = panes.map((pane) => pane.cwd).filter(Boolean);
  return new Set(projects.map((project) => trimSlash(project.path)).filter((path) => cwds.some((cwd) => cwd === path || cwd.startsWith(`${path}/`))));
}
