// The Search view (herdr-vscode-search): git grep arguments for a query, and its output parsed into files
// and matches.

const BASE_GREP_ARGS = ["grep", "-n", "-I", "--column", "--no-color", "--untracked", "--full-name"];
const GREP_LINE = /^(.*?):(\d+):(\d+):(.*)$/;
const DEFAULT_MAX_MATCHES = 2000;
const DEFAULT_SNIPPET_BEFORE = 30;
const DEFAULT_SNIPPET_WIDTH = 160;
const ELLIPSIS = "…";

function patternFlag(regex, perl) {
  if (!regex) {
    return "-F";
  }
  return perl ? "-P" : "-E";
}

function includePathspec(glob) {
  if (glob.startsWith("*")) {
    return `:(glob)**/${glob}`;
  }
  return glob.includes("/") ? `:(glob)${glob}` : `:(glob)**/${glob}`;
}

// Regular expressions use -P (Perl-compatible, like JavaScript's) unless perl is false (a git
// built without PCRE), then -E.
export function grepArgs(query, { caseSensitive = false, word = false, regex = false, include = "", perl = true } = {}) {
  const args = [...BASE_GREP_ARGS];
  if (!caseSensitive) {
    args.push("-i");
  }
  if (word) {
    args.push("-w");
  }
  args.push(patternFlag(regex, perl), "-e", query, "--");
  const globs = String(include ?? "").split(",").map((glob) => glob.trim()).filter(Boolean);
  return [...args, ...globs.map(includePathspec)];
}

// "path:line:col:text" lines -> [{ rel, matches: [{ line, col, text }] }] in output order.
export function parseGrep(stdout, { maxMatches = DEFAULT_MAX_MATCHES } = {}) {
  const files = new Map();
  let total = 0;
  for (const row of String(stdout ?? "").split("\n")) {
    const match = GREP_LINE.exec(row);
    if (!match) {
      continue;
    }
    if (total >= maxMatches) {
      return { files: [...files.values()], total, truncated: true };
    }
    const [, rel, line, col, text] = match;
    const file = files.get(rel) ?? { rel, matches: [] };
    file.matches.push({ line: Number(line), col: Number(col), text });
    files.set(rel, file);
    total++;
  }
  return { files: [...files.values()], total, truncated: false };
}

// The text before, in, and after the match, trimmed around it so long lines stay readable.
export function matchSnippet(text, col, length, { before = DEFAULT_SNIPPET_BEFORE, width = DEFAULT_SNIPPET_WIDTH } = {}) {
  const start = Math.max(0, col - 1);
  const from = Math.max(0, start - before);
  const head = (from > 0 ? ELLIPSIS : "") + text.slice(from, start).replace(/^\s+/, "");
  const hit = text.slice(start, start + length);
  const tail = text.slice(start + length, start + length + width);
  return { head, hit, tail };
}
