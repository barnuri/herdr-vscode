// A small lexer for colouring code rows, with no grammar. Its token kinds stand for VS Code's
// TextMate scopes (tools/vscode-core.mjs SYNTAX_SCOPES), so a herdr-vscode-* theme shows the
// Dark+ / Modern token colors. Block comments, multi-line strings, Markdown code fences, YAML
// block scalars and Dockerfile RUN continuations carry from one line to the next in `state`.

import { VSCODE_SYNTAX } from "./vscode-syntax-core.js";

const words = (list) => new Set(list.split(" "));
const KEYWORDS = {
  js: words("abstract as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface is keyof let namespace new of override private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield"),
  py: words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda match case nonlocal not or pass raise return self cls try while with yield"),
  go: words("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var"),
  rs: words("as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while"),
  sh: words("case do done elif else esac exit export fi for function if in local readonly return select then until while declare typeset unset source alias"),
  c: words("auto break case char class const continue default delete do double else enum extern final float for friend fun func goto if import inline int interface let long namespace new override package private protected public return short signed sizeof static struct switch template this throw try typedef union unsigned using val var virtual void volatile while"),
  sql: words("select from where and or not null insert into values update set delete create table alter drop index join left right inner outer full cross on as group by order having limit offset union all distinct case when then else end returning primary key references default asc desc between exists like ilike in is with view if begin commit rollback grant foreign unique check constraint"),
  docker: words("FROM RUN CMD LABEL EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL HEALTHCHECK SHELL MAINTAINER"),
  none: new Set(),
};
// keyword.control: the purple keywords of Dark+ (flow, import/export).
const CONTROL = words("if else elif for while do switch case default break continue return throw try catch finally except raise await yield import export from goto fallthrough defer select loop match pass with as");
const SHELL_CONTROL = words("if then else elif fi for while until do done case esac select break continue return exit");
// Built-in types (support.type.primitive / entity.name.type.primitive).
const PRIMITIVES = {
  js: words("string number boolean any unknown never object symbol bigint void undefined"),
  py: words("int str float bool bytes list dict set tuple object type"),
  go: words("bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any"),
  rs: words("bool char str i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 String Vec Option Result Box"),
  c: words("bool char double float int long short void size_t String"),
};
const CONSTANTS = words("true false null undefined nil None True False NaN Infinity");
// After these words a name is declared: a type, or a function.
const DECLARES_TYPE = words("class interface struct enum trait type impl extends implements new namespace");
const DECLARES_FN = words("def function fn func");
const MAKE_DIRECTIVES = words("include -include sinclude ifeq ifneq ifdef ifndef else endif define endef export unexport override vpath");
const C_BLOCK = ["/*", "*/"];
const SPECS = {
  js: { line: "//", block: C_BLOCK, tpl: "`", kw: KEYWORDS.js, prim: PRIMITIVES.js, control: true, ids: true, escapes: true, regex: true, jsx: true, arrow: true },
  py: { line: "#", triple: true, kw: KEYWORDS.py, prim: PRIMITIVES.py, control: true, ids: true, escapes: true, prefixes: true },
  go: { line: "//", block: C_BLOCK, tpl: "`", kw: KEYWORDS.go, prim: PRIMITIVES.go, control: true, ids: true, escapes: true, pascalCalls: true },
  rs: { line: "//", block: C_BLOCK, kw: KEYWORDS.rs, prim: PRIMITIVES.rs, control: true, ids: true, escapes: true, lifetimes: true, macros: true },
  c: { line: "//", block: C_BLOCK, kw: KEYWORDS.c, prim: PRIMITIVES.c, control: true, ids: true, escapes: true, pascalCalls: true },
  sh: { line: "#", kw: KEYWORDS.sh, control: SHELL_CONTROL, wordComment: true, escapes: true, vars: true, commands: true },
  sql: { line: "--", block: C_BLOCK, kw: KEYWORDS.sql, anyCase: true },
  css: { css: true, block: C_BLOCK, escapes: true },
  json: { line: "//", block: C_BLOCK, kw: KEYWORDS.none, keys: true, data: true, escapes: true },
  yaml: { yaml: true },
  toml: { line: "#", kw: KEYWORDS.none, keys: true, keyEq: true, data: true, escapes: true, tables: true },
  html: { block: ["<!--", "-->"], kw: KEYWORDS.none, markup: true },
  docker: { docker: true, line: "#", kw: words("AS as"), data: true, escapes: true, vars: true },
  make: { make: true, line: "#", kw: KEYWORDS.none, data: true, vars: true, makeVars: true },
  md: { md: true },
  txt: { plain: true },
};
const LANGUAGE_BY_EXTENSION = {
  js: "js", mjs: "js", cjs: "js", jsx: "js", ts: "js", tsx: "js", mts: "js", cts: "js", vue: "js", svelte: "js",
  py: "py", pyi: "py", go: "go", rs: "rs", sh: "sh", bash: "sh", zsh: "sh", fish: "sh", env: "sh",
  c: "c", h: "c", cc: "c", cpp: "c", hpp: "c", java: "c", kt: "c", kts: "c", swift: "c", cs: "c", php: "c", dart: "c", scala: "c", m: "c",
  sql: "sql", css: "css", scss: "css", sass: "css", less: "css", json: "json", jsonc: "json", json5: "json",
  yml: "yaml", yaml: "yaml", toml: "toml", ini: "toml", conf: "toml",
  html: "html", htm: "html", xml: "html", svg: "html", md: "md", markdown: "md", mk: "make",
  txt: "txt", log: "txt", csv: "txt", lock: "txt",
};
const LANGUAGE_BY_NAME = { dockerfile: "docker", makefile: "make", gnumakefile: "make", ".env": "sh", ".gitignore": "sh", ".dockerignore": "sh", ".zshrc": "sh", ".bashrc": "sh", "jenkinsfile": "c", ".gitlab-ci.yml": "yaml" };
// Markdown fence info strings -> our languages.
const FENCE_LANGUAGES = {
  ts: "js", typescript: "js", tsx: "js", js: "js", javascript: "js", jsx: "js", json: "json", jsonc: "json",
  py: "py", python: "py", go: "go", golang: "go", rs: "rs", rust: "rs", sh: "sh", bash: "sh", zsh: "sh", shell: "sh", console: "sh",
  yaml: "yaml", yml: "yaml", toml: "toml", sql: "sql", css: "css", scss: "css", html: "html", xml: "html",
  dockerfile: "docker", docker: "docker", make: "make", makefile: "make", c: "c", cpp: "c", java: "c", kotlin: "c", md: "md", markdown: "md",
};
const MAX_LEXED_LINE = 2000;
const TRIPLE_QUOTES = ['"""', "'''"];
const NUMBER = /0[xXbBoO][\da-fA-F_]+n?|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?[nfuiL]?(?:8|16|32|64|128|size)?/y;
const WORD = /[@A-Za-z_$][\w$]*/y;
const MARKUP_NAME = /[A-Za-z_:@][\w:.-]*/y;
const IDENTIFIER_CHAR = /[\w$]/;
const STRING_PREFIX = /^[rRbBfFuU]{1,2}$/;
const ESCAPE = /\\(?:x[\da-fA-F]{2}|u\{[\da-fA-F]+\}|u[\da-fA-F]{4}|.)/y;
const SHELL_VAR = /\$(?:\{[^}]*\}|[A-Za-z_]\w*|[\d@#?*$!-])/y;
const MAKE_VAR = /\$(?:\([^)]*\)|\{[^}]*\}|[@<^?*%+|])/y;
const REGEX_BEFORE = /(?:^|[(,=:[!&|?{};]|\breturn|\btypeof)\s*$/;
const JSX_BEFORE = /(?:^|[(,=:?&|{}>]|\breturn)\s*$/;
const CSS_DECLARATION = /^\s*(?:--|\$)?[\w-]+\s*:(?!:)/;
const CSS_TOKEN = /[\w-]+%?/y;
const YAML_KEY = /^(\s*(?:-\s+)*)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s#'"[\]{},][^#]*?)(\s*:)(?=\s|$)/;
const YAML_LIST = /^(\s*)(-)(?=\s|$)/;
const YAML_NUMBER = /^[-+]?(?:\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?|0x[\da-fA-F]+|0o[0-7]+|\.inf|\.nan)$/;
const YAML_CONSTANT = /^(?:true|false|null|~|yes|no|on|off|True|False|Null|NULL|TRUE|FALSE)$/;
const TOML_TABLE = /^(\s*)(\[\[?)([^\]]*)(\]\]?)/;
const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)/;
const MD_INLINE = /(`+)(.+?)\1|\*\*(.+?)\*\*|__(.+?)__|!?\[([^\]]*)\]\(([^)\s]*)[^)]*\)|<(https?:\/\/[^>]+)>/g;
const MAKE_ASSIGN = /^(\s*(?:export\s+|override\s+)?)([\w.$()-]+)(\s*(?::{1,3}=|\?=|\+=|!=|=))/;
const MAKE_RULE = /^([^\s:#=][^:#=]*?)(:{1,2})(?!=)/;
const DOCKER_INSTRUCTION = /^(\s*)([A-Za-z]+)(?=\s|$)/;
const LINE_CONTINUES = /\\\s*$/;

export function languageOf(path) {
  const name = String(path ?? "").split("/").pop().toLowerCase();
  if (LANGUAGE_BY_NAME[name]) {
    return LANGUAGE_BY_NAME[name];
  }
  if (name.startsWith(".env")) {
    return "sh";
  }
  if (name.startsWith("dockerfile") || name.endsWith(".dockerfile")) {
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

// The `}` that closes the `{` at `open`, or -1.
function braceEnd(line, open, end) {
  let depth = 0;
  for (let i = open; i < end; i++) {
    if (line[i] === "{") {
      depth++;
    } else if (line[i] === "}" && --depth === 0) {
      return i;
    }
  }
  return -1;
}

const matchAt = (pattern, line, at) => {
  pattern.lastIndex = at;
  return pattern.exec(line)?.[0] ?? null;
};

function createCursor(line) {
  const cursor = { line, at: 0, plain: 0, runs: [], prevWord: "", inTag: false };
  const flush = () => {
    if (cursor.at > cursor.plain) {
      cursor.runs.push({ text: line.slice(cursor.plain, cursor.at), kind: null });
    }
  };
  // Plain text up to `at`, then [at, end) as `kind`.
  cursor.push = (end, kind) => {
    flush();
    if (end > cursor.at) {
      cursor.runs.push({ text: line.slice(cursor.at, end), kind });
    }
    cursor.at = end;
    cursor.plain = end;
  };
  // Runs lexed elsewhere (an interpolation, a sub-language) for [at, end).
  cursor.append = (runs, end) => {
    flush();
    cursor.runs.push(...runs.filter((run) => run.text));
    cursor.at = end;
    cursor.plain = end;
  };
  cursor.finish = () => {
    if (cursor.plain < line.length) {
      cursor.runs.push({ text: line.slice(cursor.plain), kind: null });
    }
    return cursor.runs.length ? cursor.runs : [{ text: "", kind: null }];
  };
  return cursor;
}

// [at, end) is a string: escapes, shell variables and interpolations get their own kinds.
// `interp`: "${" (JS templates) or "{" (Python f-strings), where an expression starts.
function pushString(cursor, end, spec, { interp = null, vars = false, kind = "string" } = {}) {
  const { line } = cursor;
  let i = cursor.at;
  while (i < end) {
    const char = line[i];
    if (char === "\\" && spec.escapes) {
      const escape = matchAt(ESCAPE, line, i);
      if (escape) {
        cursor.push(i, kind);
        cursor.push(Math.min(end, i + escape.length), "escape");
        i = cursor.at;
        continue;
      }
    }
    if (vars && char === "$") {
      const name = matchAt(spec.makeVars ? MAKE_VAR : SHELL_VAR, line, i) ?? matchAt(SHELL_VAR, line, i);
      if (name) {
        cursor.push(i, kind);
        cursor.push(Math.min(end, i + name.length), "variable");
        i = cursor.at;
        continue;
      }
    }
    if (interp && line.startsWith(interp, i) && !(interp === "{" && line[i + 1] === "{")) {
      const open = i + interp.length - 1;
      const close = braceEnd(line, open, end);
      if (close > 0) {
        cursor.push(i, kind);
        cursor.push(open + 1, "interp");
        cursor.append(lexLine(line.slice(open + 1, close), spec.lang).runs, close);
        cursor.push(close + 1, "interp");
        i = cursor.at;
        continue;
      }
    }
    i++;
  }
  cursor.push(end, kind);
}

const CONSUMED = { stop: false };
const stopWith = (state) => ({ stop: true, state });

// An opening that may not close on this line: a block comment, a triple or template string.
function scanOpen(cursor, spec, closeEnd, kind, until, extra = {}) {
  const end = closeEnd < 0 ? cursor.line.length : closeEnd;
  if (kind === "string") {
    pushString(cursor, end, spec, extra);
  } else {
    cursor.push(end, kind);
  }
  return closeEnd < 0 ? stopWith({ kind, until, ...extra }) : CONSUMED;
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
  return scanOpen(cursor, spec, end < 0 ? end : end + close.length, "comment", close);
}

function scanTripleString(cursor, spec) {
  const quote = spec.triple && TRIPLE_QUOTES.find((candidate) => cursor.line.startsWith(candidate, cursor.at));
  if (!quote) {
    return null;
  }
  return scanOpen(cursor, spec, closeAt(cursor.line, cursor.at + quote.length, quote), "string", quote);
}

function scanTemplateString(cursor, spec) {
  const char = cursor.line[cursor.at];
  if (!spec.tpl || char !== spec.tpl) {
    return null;
  }
  const extra = spec.lang === "js" ? { interp: "${" } : {};
  return scanOpen(cursor, spec, closeAt(cursor.line, cursor.at + 1, char), "string", char, extra);
}

// A Rust lifetime ('a, 'static) is not a char literal.
function scanLifetime(cursor, spec) {
  const { line, at } = cursor;
  if (!spec.lifetimes || line[at] !== "'" || !/[A-Za-z_]/.test(line[at + 1] ?? "")) {
    return null;
  }
  let end = at + 1;
  while (end < line.length && /\w/.test(line[end])) {
    end++;
  }
  if (line[end] === "'") {
    return null;
  }
  cursor.push(end, "keyword");
  return CONSUMED;
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
  if (spec.keys && /^\s*:/.test(cursor.line.slice(end, end + 8))) {
    cursor.push(end, "key");
    return CONSUMED;
  }
  const fString = cursor.stringPrefix?.toLowerCase().includes("f");
  cursor.stringPrefix = null;
  pushString(cursor, end, spec, { interp: fString ? "{" : null, vars: spec.vars && char === '"' });
  return CONSUMED;
}

function scanRegex(cursor, spec) {
  const { line, at } = cursor;
  if (!spec.regex || line[at] !== "/" || line[at + 1] === "/" || line[at + 1] === "*" || !REGEX_BEFORE.test(line.slice(0, at))) {
    return null;
  }
  let inClass = false;
  for (let i = at + 1; i < line.length; i++) {
    const char = line[i];
    if (char === "\\") {
      i++;
    } else if (char === "[") {
      inClass = true;
    } else if (char === "]") {
      inClass = false;
    } else if (char === "/" && !inClass) {
      let end = i + 1;
      while (/[dgimsuyv]/.test(line[end] ?? "")) {
        end++;
      }
      cursor.push(end, "regexp");
      return CONSUMED;
    }
  }
  return null;
}

// <Tag attr="x"> in HTML, and in JS (JSX) where an expression can start.
function scanTag(cursor, spec) {
  const { line, at } = cursor;
  const isMarkup = spec.markup || (spec.jsx && JSX_BEFORE.test(line.slice(0, at)));
  if (!isMarkup || line[at] !== "<" || !/[A-Za-z/!]/.test(line[at + 1] ?? "")) {
    return null;
  }
  const opener = line[at + 1] === "/" || line[at + 1] === "!" ? 2 : 1;
  const name = matchAt(MARKUP_NAME, line, at + opener);
  if (!name) {
    return null;
  }
  cursor.push(at + opener, "punct");
  cursor.push(cursor.at + name.length, spec.jsx && /^[A-Z]/.test(name) ? "component" : "tag");
  cursor.inTag = true;
  cursor.tagBraces = 0;
  return CONSUMED;
}

// Inside a tag: attribute names, and the closing > or />.
function scanInTag(cursor, spec) {
  if (!cursor.inTag) {
    return null;
  }
  const { line, at } = cursor;
  const char = line[at];
  if (char === "{") {
    cursor.tagBraces++;
  } else if (char === "}") {
    cursor.tagBraces--;
  }
  if (cursor.tagBraces > 0) {
    return null;
  }
  if (char === ">" || (char === "/" && line[at + 1] === ">")) {
    cursor.push(at + (char === ">" ? 1 : 2), "punct");
    cursor.inTag = false;
    return CONSUMED;
  }
  const name = /[A-Za-z_:@]/.test(char) && /[\s"'{]/.test(line[at - 1] ?? " ") ? matchAt(MARKUP_NAME, line, at) : null;
  if (!name) {
    return null;
  }
  cursor.push(at + name.length, "attr");
  return CONSUMED;
}

function scanEntity(cursor, spec) {
  const { line, at } = cursor;
  if (!spec.markup || line[at] !== "&") {
    return null;
  }
  const entity = /^&(?:#\d+|#x[\da-fA-F]+|\w+);/.exec(line.slice(at, at + 12));
  if (!entity) {
    return null;
  }
  cursor.push(at + entity[0].length, "entity");
  return CONSUMED;
}

function scanVariable(cursor, spec) {
  const { line, at } = cursor;
  if (!spec.vars || line[at] !== "$") {
    return null;
  }
  const name = (spec.makeVars ? matchAt(MAKE_VAR, line, at) : null) ?? matchAt(SHELL_VAR, line, at);
  if (!name) {
    return null;
  }
  cursor.push(at + name.length, "variable");
  return CONSUMED;
}

function scanArrow(cursor, spec) {
  if (!spec.arrow || !cursor.line.startsWith("=>", cursor.at)) {
    return null;
  }
  cursor.push(cursor.at + 2, "arrow");
  return CONSUMED;
}

function scanNumber(cursor) {
  const { line, at } = cursor;
  if (!/\d/.test(line[at]) || IDENTIFIER_CHAR.test(line[at - 1] ?? "")) {
    return null;
  }
  cursor.push(at + matchAt(NUMBER, line, at).length, "number");
  return CONSUMED;
}

const isTypeName = (word) => /^[A-Z][a-z]\w*[a-z]\w*$/.test(word) || (/^[A-Z][A-Za-z]+$/.test(word) && word.length > 2 && /[a-z]/.test(word));

// The first word of a shell command: after the line start, a pipe, ;, &&, (, or then/do/else.
function atCommandStart(cursor) {
  const before = cursor.line.slice(0, cursor.at).trimEnd();
  return before === "" || /[|;&({]$|\$\($|`$/.test(before) || /(?:^|\s)(?:then|do|else|if|while|until|!|sudo|exec|time)$/.test(before);
}

function keywordKind(word, spec) {
  const control = spec.control instanceof Set ? spec.control : spec.control && CONTROL;
  if (control && control.has(word)) {
    return "control";
  }
  return "keyword";
}

function wordKind(word, after, spec, cursor) {
  if (spec.anyCase ? spec.kw.has(word.toLowerCase()) : spec.kw.has(word)) {
    return keywordKind(word, spec);
  }
  if (spec.commands) {
    if (/^=/.test(after)) {
      return "variable";
    }
    return atCommandStart(cursor) ? "fn" : null;
  }
  if (CONSTANTS.has(spec.anyCase ? word.toLowerCase() : word) || (spec.anyCase && CONSTANTS.has(word[0] + word.slice(1).toLowerCase()))) {
    return "constant";
  }
  if (spec.keyEq && /^\s*=/.test(after)) {
    return "key";
  }
  if (spec.data || spec.markup) {
    return null;
  }
  if (word.startsWith("@")) {
    return "fn";
  }
  if (spec.macros && after[0] === "!" && after[1] !== "=") {
    return "macro";
  }
  if (spec.prim?.has(word)) {
    return "type";
  }
  if (DECLARES_FN.has(cursor.prevWord)) {
    return "fn";
  }
  const call = /^\s*\(/.test(after);
  const member = cursor.line[cursor.at - 1] === ".";
  if (call) {
    return /^[A-Z]/.test(word) && !/^[A-Z][A-Z\d_]+$/.test(word) && !spec.pascalCalls && !member ? "type" : "fn";
  }
  if (member && spec.ids) {
    return /^[A-Z][A-Z\d_]+$/.test(word) ? "constvar" : "variable";
  }
  if (DECLARES_TYPE.has(cursor.prevWord) || isTypeName(word) || /^[A-Z]$/.test(word)) {
    return "type";
  }
  if (/^[A-Z][A-Z\d_]+$/.test(word)) {
    return spec.ids ? "constvar" : "constant";
  }
  return spec.ids ? "variable" : null;
}

function scanWord(cursor, spec) {
  const { line, at } = cursor;
  const char = line[at];
  const startsWord = /[A-Za-z_$]/.test(char) || (char === "@" && /[A-Za-z_]/.test(line[at + 1] ?? ""));
  if (!startsWord || IDENTIFIER_CHAR.test(line[at - 1] ?? "")) {
    return null;
  }
  const word = matchAt(WORD, line, at);
  const after = line.slice(at + word.length, at + word.length + 3);
  // Python's f"…", r'…', b"…": the prefix is storage.type.string.
  if (spec.prefixes && STRING_PREFIX.test(word) && (after[0] === '"' || after[0] === "'")) {
    cursor.push(at + word.length, "keyword");
    cursor.stringPrefix = word;
    return CONSUMED;
  }
  // Only a word right after `class`, `fn`, … is the name they declare.
  if (!/^\s*$/.test(line.slice(cursor.prevEnd ?? 0, at))) {
    cursor.prevWord = "";
  }
  const kind = wordKind(word, after, spec, cursor);
  cursor.prevWord = word;
  cursor.prevEnd = at + word.length;
  if (kind === "macro") {
    cursor.push(at + word.length + 1, "fn");
  } else if (kind) {
    cursor.push(at + word.length, kind);
  } else {
    cursor.at += word.length;
  }
  return CONSUMED;
}

const SCANNERS = [scanLineComment, scanBlockComment, scanTripleString, scanTemplateString, scanLifetime, scanQuotedString, scanRegex,
  scanInTag, scanTag, scanEntity, scanVariable, scanArrow, scanNumber, scanWord];

// Characters that start no token: skipped without asking every scanner.
const INERT = new Set([" ", "\t", ".", ",", ";", "(", ")", "]", "=", "+", "*", "%", "^", "~", ":", "?", "|"]);

function scanLine(cursor, spec) {
  const { line } = cursor;
  while (cursor.at < line.length) {
    if (INERT.has(line[cursor.at]) && !(spec.arrow && line[cursor.at] === "=") && !(spec.block && line[cursor.at] === "*")) {
      cursor.at++;
      continue;
    }
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
function resumeState(cursor, spec, state) {
  const isComment = state.kind === "comment";
  const end = isComment ? cursor.line.indexOf(state.until) : closeAt(cursor.line, 0, state.until);
  const stop = end < 0 ? cursor.line.length : isComment ? end + state.until.length : end;
  if (isComment) {
    cursor.push(stop, "comment");
  } else {
    pushString(cursor, stop, spec, { interp: state.interp });
  }
  return end >= 0;
}

function scanKey(cursor, spec) {
  const key = /^(\s*(?:-\s+)?)(["']?[\w.@/$-]+["']?)(?=\s*[:=](\s|$))/.exec(cursor.line);
  if (!key || !spec.keys) {
    return;
  }
  cursor.at = key[1].length;
  cursor.push(cursor.at + key[2].length, "key");
}

function lexCode(line, spec, state) {
  const cursor = createCursor(line);
  if (state?.kind && !resumeState(cursor, spec, state)) {
    return { runs: cursor.finish(), state };
  }
  if (spec.tables) {
    const table = TOML_TABLE.exec(line);
    if (table) {
      cursor.at = table[1].length;
      cursor.push(cursor.at + table[2].length, "punct");
      cursor.push(cursor.at + table[3].length, "type");
      cursor.push(cursor.at + table[4].length, "punct");
    }
  }
  if (spec.keys && cursor.plain === 0) {
    scanKey(cursor, spec);
  }
  const nextState = scanLine(cursor, spec);
  return { runs: cursor.finish(), state: nextState };
}

// Code inside a line: [from, line end) lexed as `lang`, appended to `cursor`.
function appendLexed(cursor, from, lang, state = null) {
  cursor.at = Math.max(cursor.at, from);
  const result = lexLine(cursor.line.slice(cursor.at), lang, state);
  cursor.append(result.runs, cursor.line.length);
  return result.state;
}

function lexMarkdownInline(cursor) {
  const { line } = cursor;
  MD_INLINE.lastIndex = cursor.at;
  for (let match = MD_INLINE.exec(line); match; match = MD_INLINE.exec(line)) {
    cursor.at = match.index;
    const end = match.index + match[0].length;
    if (match[1]) {
      cursor.push(end, "raw");
    } else if (match[3] !== undefined || match[4] !== undefined) {
      cursor.push(end, "bold");
    } else if (match[7]) {
      cursor.push(end, "link");
    } else {
      const textEnd = match.index + match[0].indexOf("](") + 1;
      cursor.push(textEnd, "string");
      cursor.push(end, "link");
    }
  }
}

function lexMarkdown(line, state) {
  const cursor = createCursor(line);
  const fence = FENCE.exec(line);
  if (state?.fence) {
    if (fence && fence[2][0] === state.fence[0] && fence[2].length >= state.fence.length && !fence[3]) {
      cursor.push(line.length, "punct");
      return { runs: cursor.finish(), state: null };
    }
    const inner = appendLexed(cursor, 0, state.lang, state.inner);
    return { runs: cursor.finish(), state: { ...state, inner } };
  }
  if (fence) {
    cursor.at = fence[1].length;
    cursor.push(cursor.at + fence[2].length, "punct");
    cursor.push(line.length, "string");
    return { runs: cursor.finish(), state: { fence: fence[2], lang: FENCE_LANGUAGES[fence[3].toLowerCase()] ?? "txt", inner: null } };
  }
  if (/^\s{0,3}#{1,6}(\s|$)/.test(line)) {
    cursor.push(line.length, "heading");
    return { runs: cursor.finish(), state: null };
  }
  const quote = /^\s*>/.exec(line);
  const list = /^\s*(?:[-*+]|\d+[.)])(?=\s)/.exec(line);
  if (quote) {
    cursor.push(quote[0].length, "quote");
  } else if (list) {
    cursor.at = list[0].length - list[0].trimStart().length;
    cursor.push(list[0].length, "list");
  }
  lexMarkdownInline(cursor);
  return { runs: cursor.finish(), state: null };
}

// A YAML value: quoted, number, constant, anchor/alias, tag, flow collection or a plain string.
function pushYamlValue(cursor, end) {
  const { line } = cursor;
  while (cursor.at < end && /\s/.test(line[cursor.at])) {
    cursor.at++;
  }
  const char = line[cursor.at];
  if (cursor.at >= end) {
    return;
  }
  if (char === "&" || char === "*" || char === "!") {
    const token = /^\S+/.exec(line.slice(cursor.at, end))[0];
    cursor.push(cursor.at + token.length, char === "!" ? "type" : "variable");
    pushYamlValue(cursor, end);
    return;
  }
  if (char === '"' || char === "'") {
    const close = closeAt(line, cursor.at + 1, char);
    pushString(cursor, close > 0 ? Math.min(close, end) : end, { escapes: char === '"' });
    return;
  }
  if (char === "[" || char === "{") {
    lexYamlFlow(cursor, end);
    return;
  }
  const text = line.slice(cursor.at, end).trimEnd();
  const kind = YAML_NUMBER.test(text) ? "number" : YAML_CONSTANT.test(text) ? "constant" : /^[|>][-+\d]*$/.test(text) ? "control" : "string";
  cursor.push(cursor.at + text.length, kind);
}

function lexYamlFlow(cursor, end) {
  const { line } = cursor;
  while (cursor.at < end) {
    const char = line[cursor.at];
    if ("[]{},".includes(char) || /\s/.test(char)) {
      cursor.at++;
      continue;
    }
    let stop = cursor.at;
    if (char === '"' || char === "'") {
      const close = closeAt(line, stop + 1, char);
      stop = close > 0 ? close : end;
    }
    while (stop < end && !",]}".includes(line[stop]) && !(line[stop] === ":" && /\s/.test(line[stop + 1] ?? " "))) {
      stop++;
    }
    if (line[stop] === ":") {
      cursor.push(stop, "yamlKey");
      cursor.at = stop + 1;
      continue;
    }
    const valueEnd = stop;
    pushYamlValue(cursor, valueEnd);
    cursor.at = Math.max(cursor.at, valueEnd);
  }
}

const yamlCommentAt = (line, from) => {
  let quote = null;
  for (let i = from; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (char === quote) {
        quote = null;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return i;
    }
  }
  return line.length;
};

function lexYaml(line, state) {
  const cursor = createCursor(line);
  const indent = line.length - line.trimStart().length;
  // A block scalar (key: | or >) goes on while lines are blank or indented deeper than its key.
  if (state?.block !== undefined && (line.trim() === "" || indent > state.block)) {
    cursor.push(line.length, "string");
    return { runs: cursor.finish(), state };
  }
  if (/^(---|\.\.\.)\s*$/.test(line) || /^%/.test(line)) {
    cursor.push(line.length, "punct");
    return { runs: cursor.finish(), state: null };
  }
  const comment = yamlCommentAt(line, 0);
  const key = YAML_KEY.exec(line.slice(0, comment));
  let nextState = null;
  if (key) {
    cursor.at = key[1].length;
    const quoted = key[2][0] === '"' || key[2][0] === "'";
    cursor.push(cursor.at + key[2].length, quoted ? "string" : "yamlKey");
    cursor.at += key[3].length;
    if (/^\s*[|>][-+\d]*\s*$/.test(line.slice(cursor.at, comment))) {
      nextState = { block: indent + (key[1].length - indent) };
    }
  } else {
    const item = YAML_LIST.exec(line);
    if (item) {
      cursor.at = item[0].length;
    }
  }
  pushYamlValue(cursor, comment);
  if (comment < line.length) {
    cursor.at = comment;
    cursor.push(line.length, "comment");
  }
  return { runs: cursor.finish(), state: nextState };
}

// CSS / SCSS / Less without a grammar: a line with { (or ending in ",") is a selector, a
// `name:` line is a declaration, and an @-line is an at-rule.
function lexCss(line, state) {
  const spec = SPECS.css;
  const cursor = createCursor(line);
  if (state?.kind && !resumeState(cursor, spec, state)) {
    return { runs: cursor.finish(), state };
  }
  const trimmed = line.trim();
  let mode = "value";
  if (trimmed.startsWith("@")) {
    mode = "at";
  } else if (line.includes("{") || trimmed.endsWith(",") || trimmed.startsWith("}") || !trimmed) {
    mode = CSS_DECLARATION.test(line) && !line.includes("{") ? "name" : "selector";
  } else if (CSS_DECLARATION.test(line)) {
    mode = "name";
  }
  while (cursor.at < line.length) {
    const { at } = cursor;
    const char = line[at];
    if (line.startsWith("/*", at)) {
      const close = line.indexOf("*/", at + 2);
      cursor.push(close < 0 ? line.length : close + 2, "comment");
      if (close < 0) {
        return { runs: cursor.finish(), state: { kind: "comment", until: "*/" } };
      }
      continue;
    }
    if (line.startsWith("//", at) && line[at - 1] !== ":") {
      cursor.push(line.length, "comment");
      break;
    }
    if (char === "{") {
      mode = "name";
    } else if (char === "}") {
      mode = "selector";
    } else if (char === ";") {
      mode = "name";
    } else if (char === ":" && mode === "name") {
      mode = "value";
    }
    if ("{};,()".includes(char) || (char === ":" && mode !== "selector") || /\s/.test(char)) {
      cursor.at++;
      continue;
    }
    if (char === '"' || char === "'") {
      const close = closeAt(line, at + 1, char);
      pushString(cursor, close > 0 ? close : line.length, spec);
      continue;
    }
    if (char === "$" || (char === "-" && line[at + 1] === "-") || (char === "@" && mode !== "at" && mode !== "selector")) {
      const name = /^[$@-][\w-]+/.exec(line.slice(at))?.[0] ?? char;
      cursor.push(at + name.length, "variable");
      continue;
    }
    if (mode === "at" && char === "@") {
      const name = /^@[\w-]+/.exec(line.slice(at))?.[0] ?? char;
      cursor.push(at + name.length, "atRule");
      mode = "value";
      continue;
    }
    if (mode === "selector") {
      const token = /^(?:::?|[.#%&])?[\w-]*(?:\([^)]*\))?/.exec(line.slice(at))[0];
      if (!token) {
        cursor.at++;
        continue;
      }
      cursor.push(at + token.length, char === "&" ? "punct" : "selector");
      continue;
    }
    if (mode === "name") {
      const name = /^[\w-]+/.exec(line.slice(at))?.[0] ?? char;
      cursor.push(at + name.length, "property");
      continue;
    }
    if (char === "#" && /[\da-fA-F]/.test(line[at + 1] ?? "")) {
      cursor.push(at + /^#[\da-fA-F]+/.exec(line.slice(at))[0].length, "value");
      continue;
    }
    if (char === "!") {
      cursor.push(at + (/^![\w]+/.exec(line.slice(at))?.[0].length ?? 1), "keyword");
      continue;
    }
    if (/[\d.]/.test(char) && /[\d]/.test(line[at] === "." ? line[at + 1] ?? "" : char)) {
      cursor.push(at + /^\.?\d[\d.]*(?:[a-zA-Z]+|%)?/.exec(line.slice(at))[0].length, "number");
      continue;
    }
    const token = matchAt(CSS_TOKEN, line, at);
    if (!token) {
      cursor.at++;
      continue;
    }
    cursor.push(at + token.length, line[at + token.length] === "(" ? "fn" : "value");
  }
  return { runs: cursor.finish(), state: null };
}

function lexDocker(line, state) {
  const spec = SPECS.docker;
  const cursor = createCursor(line);
  if (state?.run) {
    const inner = appendLexed(cursor, 0, "sh", state.inner);
    return { runs: cursor.finish(), state: LINE_CONTINUES.test(line) ? { run: true, inner } : null };
  }
  if (/^\s*#/.test(line)) {
    cursor.push(line.length, "comment");
    return { runs: cursor.finish(), state: null };
  }
  const instruction = DOCKER_INSTRUCTION.exec(line);
  if (!instruction || !KEYWORDS.docker.has(instruction[2].toUpperCase())) {
    return lexCode(line, spec, null);
  }
  cursor.at = instruction[1].length;
  cursor.push(cursor.at + instruction[2].length, "keyword");
  const name = instruction[2].toUpperCase();
  if (name === "RUN" && !/^\s*\[/.test(line.slice(cursor.at))) {
    const inner = appendLexed(cursor, cursor.at, "sh");
    return { runs: cursor.finish(), state: LINE_CONTINUES.test(line) ? { run: true, inner } : null };
  }
  if (name === "ENV" || name === "ARG" || name === "LABEL") {
    const rest = line.slice(cursor.at);
    const pairs = /([\w.-]+)(?==)/g;
    for (let match = pairs.exec(rest); match; match = pairs.exec(rest)) {
      cursor.at = instruction[0].length + match.index;
      cursor.push(cursor.at + match[1].length, "variable");
    }
  }
  const subState = scanLine(cursor, spec);
  return { runs: cursor.finish(), state: subState };
}

function lexMake(line, state) {
  const spec = SPECS.make;
  const recipe = { ...SPECS.sh, makeVars: true, lang: "sh" };
  const cursor = createCursor(line);
  if (line.startsWith("\t") || state?.recipe) {
    const result = lexCode(line, recipe, null);
    return { runs: result.runs, state: LINE_CONTINUES.test(line) ? { recipe: true } : null };
  }
  if (/^\s*#/.test(line)) {
    cursor.push(line.length, "comment");
    return { runs: cursor.finish(), state: null };
  }
  const directive = /^(\s*)([\w-]+)/.exec(line);
  const assign = MAKE_ASSIGN.exec(line);
  const rule = MAKE_RULE.exec(line);
  if (directive && MAKE_DIRECTIVES.has(directive[2]) && !assign) {
    cursor.at = directive[1].length;
    cursor.push(cursor.at + directive[2].length, "control");
  } else if (assign) {
    cursor.at = assign[1].length;
    cursor.push(cursor.at + assign[2].length, "variable");
    cursor.at += assign[3].length;
  } else if (rule) {
    cursor.push(rule[1].length, rule[1].startsWith(".") ? "keyword" : "fn");
    cursor.at += rule[2].length;
  }
  scanLine(cursor, spec);
  return { runs: cursor.finish(), state: null };
}

for (const [lang, spec] of Object.entries(SPECS)) {
  spec.lang = lang;
}

// One line -> { runs: [{text, kind}], state } ; state carries what is still open at its end.
export function lexLine(line, lang, state = null) {
  const spec = SPECS[lang] ?? SPECS.txt;
  if (spec.plain || line.length > MAX_LEXED_LINE) {
    return { runs: [{ text: line, kind: null }], state: spec.plain ? null : state };
  }
  if (spec.md) {
    return lexMarkdown(line, state);
  }
  if (spec.yaml) {
    return lexYaml(line, state);
  }
  if (spec.css) {
    return lexCss(line, state);
  }
  if (spec.docker) {
    return lexDocker(line, state);
  }
  if (spec.make) {
    return lexMake(line, state);
  }
  return lexCode(line, spec, state);
}

export function lexLines(lines, lang) {
  let state = null;
  return lines.map((line) => {
    const result = lexLine(line, lang, state);
    state = result.state;
    return result.runs;
  });
}

// A whole file, lexed lazily: only up to the last row asked for, each line once.
export class LexCache {
  constructor(lines, lang) {
    this.lines = lines;
    this.lang = lang;
    this.runs = [];
    this.state = null;
  }

  runsAt(index) {
    for (let i = this.runs.length; i <= index && i < this.lines.length; i++) {
      const result = lexLine(this.lines[i], this.lang, this.state);
      this.runs.push(result.runs);
      this.state = result.state;
    }
    return this.runs[index] ?? [{ text: this.lines[index] ?? "", kind: null }];
  }
}

const LINE_CACHE_LIMIT = 4000;
const lineCache = new Map();

// One line with no state (diff rows, search hits), cached by language and text.
export function lexCached(line, lang) {
  const key = `${lang}\0${line}`;
  let runs = lineCache.get(key);
  if (!runs) {
    if (lineCache.size >= LINE_CACHE_LIMIT) {
      lineCache.clear();
    }
    runs = lexLine(line, lang).runs;
    lineCache.set(key, runs);
  }
  return runs;
}

// The runs covering text [from, to).
export function sliceRuns(runs, from, to) {
  const out = [];
  let at = 0;
  for (const run of runs) {
    const end = at + run.text.length;
    if (end > from && at < to) {
      out.push({ text: run.text.slice(Math.max(0, from - at), Math.min(run.text.length, to - at)), kind: run.kind });
    }
    at = end;
  }
  return out;
}

// The built-in editor's semantic colors (EditorState `syntax`) from our token colors.
export const editorSyntax = (colors) => ({
  keyword: colors.keyword, string: colors.string, comment: colors.comment, function: colors.fn, type: colors.type,
  number: colors.number, constant: colors.constvar, boolean: colors.constant, variable: colors.variable,
  "string.escape": colors.escape, operator: colors.operator, punctuation: colors.operator,
});

// A herdr-vscode-* theme shows VS Code's own token colors; any other theme maps to its ANSI colors.
export const syntaxColors = (t) => ({
  comment: t.dim, string: t.ansi2, number: t.ansi1, keyword: t.ansi5, type: t.ansi3,
  fn: t.ansi4, constant: t.ansi6, key: t.ansi1, tag: t.ansi1,
  control: t.ansi5, variable: t.foreground, constvar: t.ansi6, regexp: t.ansi1, escape: t.ansi3, attr: t.ansi3,
  heading: t.ansi4, bold: t.ansi4, raw: t.ansi2, link: t.ansi4, list: t.ansi4, quote: t.dim,
  selector: t.ansi3, property: t.ansi6, value: t.ansi2, punct: t.dim, entity: t.ansi6, yamlKey: t.ansi4,
  component: t.ansi3, interp: t.ansi5, atRule: t.ansi5, operator: t.foreground, arrow: t.ansi5,
  ...(VSCODE_SYNTAX[String(t.background ?? "").toLowerCase()] ?? {}),
});
