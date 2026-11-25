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

// One comma-separated pattern as pathspecs: a glob, or a folder or file name (matched at any depth
// unless it names a path), like VS Code's "files to include" and "files to exclude".
function patternSpecs(pattern, magic) {
  const clean = pattern.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!clean) {
    return [];
  }
  const anchored = clean.startsWith("**/") || clean.startsWith("/") ? clean.replace(/^\//, "") : clean.includes("/") ? clean : `**/${clean}`;
  return [`:(${magic})${anchored}`, `:(${magic})${anchored}/**`];
}

export const splitPatterns = (text) => String(text ?? "").split(",").map((part) => part.trim()).filter(Boolean);

// The UTF-16 index of a UTF-8 byte offset into the text (git grep columns count bytes).
export function byteToIndex(text, byteOffset) {
  let bytes = 0;
  let index = 0;
  while (index < text.length && bytes < byteOffset) {
    const code = text.codePointAt(index);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    index += code > 0xffff ? 2 : 1;
  }
  return index;
}

// Regular expressions use -P (Perl-compatible, like JavaScript's) unless perl is false (a git
// built without PCRE), then -E.
export function grepArgs(query, { caseSensitive = false, word = false, regex = false, include = "", exclude = "", ignoreFiles = true, perl = true } = {}) {
  const args = [...BASE_GREP_ARGS];
  if (!ignoreFiles) {
    args.push("--no-exclude-standard");
  }
  if (!caseSensitive) {
    args.push("-i");
  }
  if (word) {
    args.push("-w");
  }
  args.push(patternFlag(regex, perl), "-e", query, "--");
  const included = splitPatterns(include).flatMap((pattern) => patternSpecs(pattern, "glob"));
  const excluded = splitPatterns(exclude).flatMap((pattern) => patternSpecs(pattern, "exclude,glob"));
  return [...args, ...included, ...excluded];
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
  const lead = text.slice(from, start).match(/^\s*/)[0].length;
  const head = (from > 0 ? ELLIPSIS : "") + text.slice(from + lead, start);
  const hit = text.slice(start, start + length);
  const tail = text.slice(start + length, start + length + width);
  // Text offsets of the parts, to colour them with the line's syntax runs.
  return { head, hit, tail, ellipsis: from > 0, headFrom: from + lead, start, end: start + length, tailEnd: start + length + width };
}
