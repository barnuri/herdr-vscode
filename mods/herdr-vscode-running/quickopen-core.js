// Quick Open (⌘P): a word matches a path when its letters appear in order; a contiguous hit in the
// file name ranks first, then in the path, then scattered ones. All words must match (or the repo name).

const NAME_HIT_SCORE = 10000;
const NAME_NOT_AT_START_PENALTY = 500;
const PATH_HIT_SCORE = 5000;
const SCATTERED_SCORE = 1000;
const SCATTERED_NAME_HIT_BONUS = 10;
const SCATTERED_GAP_PENALTY = 25;
const NAME_LENGTH_DIVISOR = 100;
const SCATTERED_LENGTH_DIVISOR = 10;
const REPO_NAME_SCORE = 500;
const DEFAULT_FILE_LIMIT = 60;
const DEFAULT_SYMBOL_LIMIT = 2000;
const NO_MATCH = -1;

const QUERY_PREFIXES = { ">": "commands", "@": "symbols", "%": "text" };

// Symbols of a source file, the way an outline would list them.
const SYMBOL_PATTERNS = [
  [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, "class"],
  [/^\s*(?:export\s+)?(?:default\s+)?interface\s+([A-Za-z_$][\w$]*)/, "interface"],
  [/^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, "enum"],
  [/^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/, "type"],
  [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, "function"],
  [/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/, "function"],
  [/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, "variable"],
  [/^\s+(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|override\s+|async\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)?\s*(?::\s*[^={;]+)?\{\s*$/, "method"],
  [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, "function"],
  [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, "function"],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, "function"],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|trait|impl)\s+([A-Za-z_]\w*)/, "class"],
  [/^#{1,6}\s+(.+?)\s*#*\s*$/, "heading"],
];
const NOT_METHODS = new Set(["if", "for", "while", "switch", "catch", "return", "function", "else", "do", "with"]);

const KEY_GLYPHS = { left: "←", right: "→", up: "↑", down: "↓", enter: "↵", escape: "⎋", backspace: "⌫", tab: "⇥", space: "Space" };
const MAC_MODIFIERS = [["ctrl", "⌃"], ["alt", "⌥"], ["shift", "⇧"], ["cmd", "⌘"]];

const range = (from, count) => Array.from({ length: count }, (_, i) => from + i);

const countGaps = (indexes) => indexes.filter((index, i) => i > 0 && index !== indexes[i - 1] + 1).length;

// The tail of the query matched from the end of the file name -> { tail, rest } (rest: query index left).
function matchNameTail(path, query, slash) {
  const tail = [];
  let end = path.length;
  let rest = query.length - 1;
  for (; rest >= 0 && end > slash + 1; rest--) {
    const hit = path.lastIndexOf(query[rest], end - 1);
    if (hit <= slash) {
      break;
    }
    tail.unshift(hit);
    end = hit;
  }
  return { tail, rest };
}

function matchHead(path, query, last, limit) {
  const head = [];
  let previous = -1;
  for (let i = 0; i <= last; i++) {
    const hit = path.indexOf(query[i], previous + 1);
    if (hit < 0 || hit >= limit) {
      return null;
    }
    head.push(hit);
    previous = hit;
  }
  return head;
}

// One word against a lowercased path -> { score, at: [indexes in path] } or null.
function matchWord(path, query) {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const inName = name.indexOf(query);
  if (inName >= 0) {
    const startPenalty = inName === 0 ? 0 : NAME_NOT_AT_START_PENALTY;
    return { score: NAME_HIT_SCORE - startPenalty - name.length - path.length / NAME_LENGTH_DIVISOR, at: range(slash + 1 + inName, query.length) };
  }
  const inPath = path.indexOf(query);
  if (inPath >= 0) {
    return { score: PATH_HIT_SCORE - path.length, at: range(inPath, query.length) };
  }
  const { tail, rest } = matchNameTail(path, query, slash);
  const head = matchHead(path, query, rest, tail[0] ?? path.length);
  if (!head) {
    return null;
  }
  const all = [...head, ...tail];
  const score = SCATTERED_SCORE + tail.length * SCATTERED_NAME_HIT_BONUS - countGaps(all) * SCATTERED_GAP_PENALTY - path.length / SCATTERED_LENGTH_DIVISOR;
  return { score, at: all };
}

// -> { score, at } or null; `alsoName` (a repo name) can satisfy a word on its own.
export function matchPath(path, query, alsoName = "") {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) {
    return { score: 0, at: [] };
  }
  const lowerPath = path.toLowerCase();
  const repoName = alsoName.toLowerCase();
  let score = 0;
  const at = new Set();
  for (const word of words) {
    const match = matchWord(lowerPath, word);
    if (match) {
      score += match.score;
      match.at.forEach((index) => at.add(index));
    } else if (repoName && repoName.includes(word)) {
      score += REPO_NAME_SCORE;
    } else {
      return null;
    }
  }
  return { score, at: [...at].sort((a, b) => a - b) };
}

export function scorePath(path, query) {
  return matchPath(path, query)?.score ?? NO_MATCH;
}

// Paths are lowercased once here, every file gets a cheap score (no positions), and only the
// best `limit` get their matched letters (matchPath).
export function prepareFiles(items) {
  return items.map((item) => {
    const path = item.rel.toLowerCase();
    return { it: item, p: path, slash: path.lastIndexOf("/"), root: (item.root?.name ?? "").toLowerCase() };
  });
}

function scatteredScore(path, slash, query) {
  let previous = -1;
  let gaps = 0;
  let nameHits = 0;
  for (let i = 0; i < query.length; i++) {
    const hit = path.indexOf(query[i], previous + 1);
    if (hit < 0) {
      return NO_MATCH;
    }
    if (i > 0 && hit !== previous + 1) {
      gaps++;
    }
    if (hit > slash) {
      nameHits++;
    }
    previous = hit;
  }
  return SCATTERED_SCORE + nameHits * SCATTERED_NAME_HIT_BONUS - gaps * SCATTERED_GAP_PENALTY - path.length / SCATTERED_LENGTH_DIVISOR;
}

function quickWord(path, slash, query) {
  const inName = path.indexOf(query, slash + 1);
  if (inName >= 0) {
    const startPenalty = inName === slash + 1 ? 0 : NAME_NOT_AT_START_PENALTY;
    return NAME_HIT_SCORE - startPenalty - (path.length - slash - 1) - path.length / NAME_LENGTH_DIVISOR;
  }
  if (path.indexOf(query) >= 0) {
    return PATH_HIT_SCORE - path.length;
  }
  return scatteredScore(path, slash, query);
}

export const queryWords = (query) => String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);

function quickScore(entry, words) {
  let score = 0;
  for (const word of words) {
    const wordScore = quickWord(entry.p, entry.slash, word);
    if (wordScore >= 0) {
      score += wordScore;
    } else if (entry.root && entry.root.includes(word)) {
      score += REPO_NAME_SCORE;
    } else {
      return NO_MATCH;
    }
  }
  return score;
}

// Scores prepared[from..to) into `out` as [score, index]; call it in slices to stay responsive.
export function scoreSlice(prepared, words, from, to, out) {
  for (let i = from; i < to; i++) {
    const score = quickScore(prepared[i], words);
    if (score >= 0) {
      out.push([score, i]);
    }
  }
  return out;
}

// The scored [score, index] pairs -> the best `limit` items, each with `score` and `at`.
export function topFiles(prepared, scored, query, limit = DEFAULT_FILE_LIMIT) {
  scored.sort((a, b) => b[0] - a[0] || prepared[a[1]].p.length - prepared[b[1]].p.length);
  return scored.slice(0, limit).map(([score, index]) => {
    const item = prepared[index].it;
    return { ...item, score, at: matchPath(item.rel, query, item.root?.name ?? "")?.at ?? [] };
  });
}

// items: [{ root, rel }] -> best `limit` matches, highest score first, each with `at`.
export function rankFiles(items, query, limit = DEFAULT_FILE_LIMIT) {
  const prepared = prepareFiles(items);
  return topFiles(prepared, scoreSlice(prepared, queryWords(query), 0, prepared.length, []), query, limit);
}

// Split a label into runs for drawing: [{ text, hit }], `at` being indexes into it.
export function runsOf(text, at = [], offset = 0) {
  const hits = new Set(at.map((index) => index - offset).filter((index) => index >= 0 && index < text.length));
  const runs = [];
  for (let i = 0; i < text.length; i++) {
    const hit = hits.has(i);
    const last = runs[runs.length - 1];
    if (last && last.hit === hit) {
      last.text += text[i];
    } else {
      runs.push({ text: text[i], hit });
    }
  }
  return runs;
}

// A typed path: absolute (/x), home (~/x), dot-relative (./x, ../x) or any path with a slash.
export const isPathQuery = (text) => /^(~\/?|\/|\.{1,2}\/)/.test(text) || text.includes("/");

const optionalNumber = (text) => (text ? Number(text) : null);

// Prefixes as in VS Code: > commands, @ symbols, : line, % text, ? help.
export function parseQuery(raw) {
  const text = String(raw ?? "").trimStart();
  const prefixMode = QUERY_PREFIXES[text[0]];
  if (prefixMode) {
    return { mode: prefixMode, text: text.slice(1).trim() };
  }
  if (text.startsWith("?")) {
    return { mode: "help", text: "" };
  }
  if (text.startsWith(":")) {
    const position = /^:(\d+)?(?::(\d+))?/.exec(text);
    return { mode: "line", text: "", line: optionalNumber(position?.[1]), col: optionalNumber(position?.[2]) };
  }
  const withLine = /^(.*?)[:(](\d+)(?:[:,](\d+))?\)?\s*$/.exec(text);
  if (withLine && withLine[1].trim()) {
    return { mode: "files", text: withLine[1].trim(), line: Number(withLine[2]), col: optionalNumber(withLine[3]) };
  }
  return { mode: "files", text: text.trim() };
}

function lineSymbol(line, lineNumber) {
  for (const [pattern, kind] of SYMBOL_PATTERNS) {
    const match = pattern.exec(line);
    if (!match) {
      continue;
    }
    if (kind === "method" && NOT_METHODS.has(match[1])) {
      return null;
    }
    return { name: match[1], kind, line: lineNumber };
  }
  return null;
}

// -> [{ name, kind, line }]
export function symbolsOf(text, max = DEFAULT_SYMBOL_LIMIT) {
  const symbols = [];
  const lines = String(text ?? "").split("\n");
  for (let i = 0; i < lines.length && symbols.length < max; i++) {
    const symbol = lineSymbol(lines[i], i + 1);
    if (symbol) {
      symbols.push(symbol);
    }
  }
  return symbols;
}

const titleWords = (text) => text.replace(/[-_]/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());

// "tab.new" -> "Tab: New"; "layout.toggle:sidebar" -> "Layout: Toggle (sidebar)".
export function commandLabel(action) {
  const [name, arg] = String(action).split(/:(.*)/s);
  const parts = name.split(".");
  const label = parts.length > 1 ? `${titleWords(parts[0])}: ${titleWords(parts.slice(1).join(" "))}` : titleWords(name);
  return arg ? `${label} (${arg})` : label;
}

// "cmd--" is cmd + minus: the empty part after the last dash is the "-" key.
function keyParts(keys) {
  const parts = String(keys).split("-");
  return parts.flatMap((part, i) => {
    if (part === "" && i === parts.length - 1) {
      return ["-"];
    }
    return part === "" ? [] : [part];
  });
}

function keyGlyph(key) {
  if (KEY_GLYPHS[key]) {
    return KEY_GLYPHS[key];
  }
  return key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1);
}

// "cmd-shift-p" -> "⇧⌘P" (macOS order: ⌃ ⌥ ⇧ ⌘); other platforms "Ctrl+Shift+P".
export function keyLabel(keys, mac = true) {
  const parts = keyParts(keys);
  const key = parts.pop() ?? "";
  const modifiers = new Set(parts);
  const glyph = keyGlyph(key);
  if (mac) {
    return `${MAC_MODIFIERS.map(([modifier, symbol]) => (modifiers.has(modifier) ? symbol : "")).join("")}${glyph}`;
  }
  const ctrl = modifiers.has("ctrl") || modifiers.has("cmd") ? "Ctrl" : null;
  return [ctrl, modifiers.has("alt") ? "Alt" : null, modifiers.has("shift") ? "Shift" : null, glyph].filter(Boolean).join("+");
}

// A key action ("tab.select:3", "herdr-vscode-activity.search") -> run(name, args), using the command
// list (commands()) to name the argument. null for a command that needs more than it gets.
export function actionToRun(action, list = []) {
  const [name, arg] = String(action).split(/:(.*)/s);
  const command = list.find((candidate) => candidate.name === name);
  if (!command) {
    return name.includes(".") && !arg ? { name, args: undefined } : null;
  }
  const required = command.args.filter((argument) => argument.required);
  if (arg === undefined) {
    return required.length ? null : { name, args: undefined };
  }
  const target = required[0] ?? command.args[0];
  if (!target || required.length > 1) {
    return null;
  }
  return { name, args: { [target.name]: /^-?\d+$/.test(arg) ? Number(arg) : arg } };
}
