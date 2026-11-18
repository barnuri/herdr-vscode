// A small lexer for colouring code rows, with no grammar: block comments and multi-line strings
// carry from one line to the next. kinds: comment string number keyword type fn constant key tag

import { VSCODE_SYNTAX } from "./vscode-syntax-core.js";

const words = (list) => new Set(list.split(" "));
const KEYWORDS = {
  js: words("abstract as async await break case catch class const continue debugger default delete do else enum export extends finally for from function get if implements import in instanceof interface is keyof let namespace new of private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield"),
  py: words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda match case nonlocal not or pass raise return self try while with yield"),
  go: words("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var"),
  rs: words("as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while"),
  sh: words("case do done elif else esac exit export fi for function if in local readonly return select then until while"),
  c: words("auto break case char class const continue default delete do double else enum extern final float for friend fun func goto if import inline int interface let long namespace new override package private protected public return short signed sizeof static struct switch template this throw try typedef union unsigned using val var virtual void volatile while"),
  sql: words("select from where and or not null insert into values update set delete create table alter drop index join left right inner outer on as group by order having limit offset union distinct case when then else end returning primary key references default"),
  docker: words("FROM RUN CMD LABEL EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL HEALTHCHECK SHELL AS"),
  none: new Set(),
};
const CONSTANTS = words("true false null undefined nil None True False NaN Infinity");
const C_BLOCK = ["/*", "*/"];
const SPECS = {
  js: { line: "//", block: C_BLOCK, tpl: "`", kw: KEYWORDS.js },
  py: { line: "#", triple: true, kw: KEYWORDS.py },
  go: { line: "//", block: C_BLOCK, tpl: "`", kw: KEYWORDS.go },
  rs: { line: "//", block: C_BLOCK, kw: KEYWORDS.rs },
  c: { line: "//", block: C_BLOCK, kw: KEYWORDS.c },
  sh: { line: "#", kw: KEYWORDS.sh, wordComment: true },
  sql: { line: "--", block: C_BLOCK, kw: KEYWORDS.sql, anyCase: true },
  css: { block: C_BLOCK, kw: KEYWORDS.none, keys: true },
  json: { kw: KEYWORDS.none, keys: true, data: true },
  yaml: { line: "#", kw: KEYWORDS.none, keys: true, data: true },
  toml: { line: "#", kw: KEYWORDS.none, keys: true, data: true },
  html: { block: ["<!--", "-->"], kw: KEYWORDS.none, markup: true },
  docker: { line: "#", kw: KEYWORDS.docker },
  md: { md: true },
  txt: { plain: true },
};
const LANGUAGE_BY_EXTENSION = {
  js: "js", mjs: "js", cjs: "js", jsx: "js", ts: "js", tsx: "js", mts: "js", cts: "js", vue: "js", svelte: "js",
  py: "py", go: "go", rs: "rs", sh: "sh", bash: "sh", zsh: "sh", fish: "sh", env: "sh",
  c: "c", h: "c", cc: "c", cpp: "c", hpp: "c", java: "c", kt: "c", kts: "c", swift: "c", cs: "c", php: "c", dart: "c", scala: "c", m: "c",
  sql: "sql", css: "css", scss: "css", less: "css", json: "json", jsonc: "json", json5: "json",
  yml: "yaml", yaml: "yaml", toml: "toml", ini: "toml", conf: "toml",
  html: "html", htm: "html", xml: "html", svg: "html", md: "md", markdown: "md",
  txt: "txt", log: "txt", csv: "txt", lock: "txt",
};
const LANGUAGE_BY_NAME = { dockerfile: "docker", makefile: "sh", ".env": "sh", ".gitignore": "sh", ".dockerignore": "sh", "jenkinsfile": "c", ".gitlab-ci.yml": "yaml" };
const MAX_LEXED_LINE = 2000;
const TRIPLE_QUOTES = ['"""', "'''"];
const KEY_PATTERN = /^(\s*(?:-\s+)?)(["']?[\w.@/$-]+["']?)(?=\s*[:=](\s|$))/;
const NUMBER_PATTERN = /^(0[xXbBoO][\da-fA-F_]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?)/;
const WORD_PATTERN = /^[@A-Za-z_$][\w$]*/;
const TAG_PATTERN = /^<\/?[A-Za-z][\w.:-]*/;
const IDENTIFIER_CHAR = /[\w$]/;

export function languageOf(path) {
  const name = String(path ?? "").split("/").pop().toLowerCase();
  if (LANGUAGE_BY_NAME[name]) {
    return LANGUAGE_BY_NAME[name];
  }
  if (name.startsWith(".env")) {
    return "sh";
  }
  if (name.startsWith("dockerfile")) {
    return "docker";
  }
  const extension = name.includes(".") ? name.split(".").pop() : "";
  return LANGUAGE_BY_EXTENSION[extension] ?? "txt";
}

function closeAt(line, from, quote) {
  for (let i = from; i < line.length; i++) {
    if (line[i] === "\\") {
      i++;
    } else if (line.startsWith(quote, i)) {
      return i + quote.length;
    }
  }
  return -1;
}

const singleRun = (text, kind) => ({ runs: [{ text, kind }], state: null });

function lexMarkdown(line) {
  if (/^#{1,6}\s/.test(line)) {
    return singleRun(line, "keyword");
  }
  if (/^\s*(```|~~~)/.test(line)) {
    return singleRun(line, "comment");
  }
  return singleRun(line, null);
}

function createCursor(line) {
  const cursor = { line, at: 0, plain: 0, runs: [] };
  cursor.push = (end, kind) => {
    if (cursor.at > cursor.plain) {
      cursor.runs.push({ text: line.slice(cursor.plain, cursor.at), kind: null });
    }
    cursor.runs.push({ text: line.slice(cursor.at, end), kind });
    cursor.at = end;
    cursor.plain = end;
  };
  return cursor;
}

const CONSUMED = { stop: false };
const stopWith = (state) => ({ stop: true, state });

// An opening that may not close on this line: a block comment, a triple or template string.
function scanOpen(cursor, closeEnd, kind, until) {
  if (closeEnd < 0) {
    cursor.push(cursor.line.length, kind);
    return stopWith({ kind, until });
  }
  cursor.push(closeEnd, kind);
  return CONSUMED;
}

function scanLineComment(cursor, spec) {
  const { line, at } = cursor;
  const previous = line[at - 1] ?? "";
  if (!spec.line || !line.startsWith(spec.line, at)) {
    return null;
  }
  // "//" right after ":" is a URL, not a comment.
  if (spec.line === "//" && previous === ":") {
    return null;
  }
  if (spec.wordComment && at !== 0 && !/\s/.test(previous)) {
    return null;
  }
  cursor.push(line.length, "comment");
  return stopWith(null);
}

function scanBlockComment(cursor, spec) {
  if (!spec.block || !cursor.line.startsWith(spec.block[0], cursor.at)) {
    return null;
  }
  const [open, close] = spec.block;
  const end = cursor.line.indexOf(close, cursor.at + open.length);
  return scanOpen(cursor, end < 0 ? end : end + close.length, "comment", close);
}

function scanTripleString(cursor, spec) {
  const quote = spec.triple && TRIPLE_QUOTES.find((candidate) => cursor.line.startsWith(candidate, cursor.at));
  if (!quote) {
    return null;
  }
  return scanOpen(cursor, closeAt(cursor.line, cursor.at + quote.length, quote), "string", quote);
}

function scanTemplateString(cursor, spec) {
  const char = cursor.line[cursor.at];
  if (!spec.tpl || char !== spec.tpl) {
    return null;
  }
  return scanOpen(cursor, closeAt(cursor.line, cursor.at + 1, char), "string", char);
}

function scanQuotedString(cursor, spec) {
  const char = cursor.line[cursor.at];
  if (char !== '"' && char !== "'") {
    return null;
  }
  const end = closeAt(cursor.line, cursor.at + 1, char);
  if (end <= 0) {
    return null;
  }
  const isKey = spec.keys && /^\s*:/.test(cursor.line.slice(end));
  cursor.push(end, isKey ? "key" : "string");
  return CONSUMED;
}

function scanTag(cursor, spec) {
  const { line, at } = cursor;
  if (!spec.markup || line[at] !== "<" || !/[A-Za-z/!]/.test(line[at + 1] ?? "")) {
    return null;
  }
  const tag = TAG_PATTERN.exec(line.slice(at));
  if (!tag) {
    return null;
  }
  cursor.push(at + tag[0].length, "tag");
  return CONSUMED;
}

function scanNumber(cursor) {
  const { line, at } = cursor;
  if (!/\d/.test(line[at]) || IDENTIFIER_CHAR.test(line[at - 1] ?? "")) {
    return null;
  }
  cursor.push(at + NUMBER_PATTERN.exec(line.slice(at))[0].length, "number");
  return CONSUMED;
}

const isTypeName = (word) => /^[A-Z][a-z]\w*[a-z]\w*$/.test(word) || (/^[A-Z][A-Za-z]+$/.test(word) && word.length > 2 && /[a-z]/.test(word));

function wordKind(word, after, spec) {
  if (spec.anyCase ? spec.kw.has(word.toLowerCase()) : spec.kw.has(word)) {
    return "keyword";
  }
  if (CONSTANTS.has(word)) {
    return "constant";
  }
  if (spec.data) {
    return null;
  }
  if (word.startsWith("@")) {
    return "fn";
  }
  if (/^\s*\(/.test(after)) {
    return /^[A-Z]/.test(word) ? "type" : "fn";
  }
  if (isTypeName(word)) {
    return "type";
  }
  return /^[A-Z][A-Z\d_]{2,}$/.test(word) ? "constant" : null;
}

function scanWord(cursor, spec) {
  const { line, at } = cursor;
  const char = line[at];
  const startsWord = /[A-Za-z_$]/.test(char) || (char === "@" && /[A-Za-z_]/.test(line[at + 1] ?? ""));
  if (!startsWord || IDENTIFIER_CHAR.test(line[at - 1] ?? "")) {
    return null;
  }
  const word = WORD_PATTERN.exec(line.slice(at))[0];
  const kind = wordKind(word, line.slice(at + word.length), spec);
  if (kind) {
    cursor.push(at + word.length, kind);
  } else {
    cursor.at += word.length;
  }
  return CONSUMED;
}

const SCANNERS = [scanLineComment, scanBlockComment, scanTripleString, scanTemplateString, scanQuotedString, scanTag, scanNumber, scanWord];

function scanLine(cursor, spec) {
  while (cursor.at < cursor.line.length) {
    let result = null;
    for (const scan of SCANNERS) {
      result = scan(cursor, spec);
      if (result) {
        break;
      }
    }
    if (result?.stop) {
      return result.state;
    }
    if (!result) {
      cursor.at++;
    }
  }
  return null;
}

// Closes the comment or string carried in from the previous line; false when it stays open.
function resumeState(cursor, state) {
  const isComment = state.kind === "comment";
  const end = isComment ? cursor.line.indexOf(state.until) : closeAt(cursor.line, 0, state.until);
  if (end < 0) {
    return false;
  }
  cursor.push(isComment ? end + state.until.length : end, state.kind);
  return true;
}

function scanKey(cursor) {
  const key = KEY_PATTERN.exec(cursor.line);
  if (!key) {
    return;
  }
  cursor.at = key[1].length;
  cursor.push(cursor.at + key[2].length, "key");
}

// One line -> { runs: [{text, kind}], state } ; state carries an open comment or string.
export function lexLine(line, lang, state = null) {
  const spec = SPECS[lang] ?? SPECS.txt;
  if (spec.plain || line.length > MAX_LEXED_LINE) {
    return { runs: [{ text: line, kind: null }], state: spec.plain ? null : state };
  }
  if (spec.md) {
    return lexMarkdown(line);
  }
  const cursor = createCursor(line);
  if (state && !resumeState(cursor, state)) {
    return { runs: [{ text: line, kind: state.kind }], state };
  }
  if (spec.keys && cursor.plain === 0) {
    scanKey(cursor);
  }
  const nextState = scanLine(cursor, spec);
  if (cursor.plain < line.length) {
    cursor.runs.push({ text: line.slice(cursor.plain), kind: null });
  }
  return { runs: cursor.runs.length ? cursor.runs : [{ text: "", kind: null }], state: nextState };
}

export function lexLines(lines, lang) {
  let state = null;
  return lines.map((line) => {
    const result = lexLine(line, lang, state);
    state = result.state;
    return result.runs;
  });
}

// A herdr-vscode-* theme shows VS Code's own token colors; any other theme maps to its ANSI colors.
export const syntaxColors = (t) => ({
  comment: t.dim, string: t.ansi2, number: t.ansi1, keyword: t.ansi5, type: t.ansi3,
  fn: t.ansi4, constant: t.ansi6, key: t.ansi1, tag: t.ansi1,
  ...(VSCODE_SYNTAX[String(t.background ?? "").toLowerCase()] ?? {}),
});
