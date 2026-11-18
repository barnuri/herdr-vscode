// File paths in text, like VS Code's terminal and editor link detection: absolute, ~/, ./ and
// ../, repo-relative (a/b.ts) and bare file names (README.md), with an optional :line[:col],
// #Lline[Ccol] or " (line N)". URLs are not paths. Only paths that exist get linked (links.js).

import { resolvePath, parentOf } from "./ws-core.js";

const PATH_CHARS = "[^\\s#:\"'`()<>\\[\\]{},;|*?]";
const PATH = new RegExp(
  `(?:~|\\.{1,2})?\\/${PATH_CHARS}+` + // ~/a, ./a, ../a, /abs
  `|${PATH_CHARS}+\\/${PATH_CHARS}+` + // a/b
  `|[\\w.-]*\\w\\.[A-Za-z][\\w]{0,9}`, // name.ext
  "g",
);
const POSITION = /^(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?|,? \(?line (\d+)(?:, col(?:umn)? (\d+))?\)?)/;
const TRAILING = /[.,;:!?'")\]}>]+$/;
const URL_BEFORE = /[A-Za-z][\w+.-]*:\/\/\S*$|\bwww\.\S*$|[\w-]@\S*$/;
const URL_TARGET = /^(?:[A-Za-z][\w+.-]*:|\/\/|#|mailto:)/;
const BEFORE_PATH = /[\w~./@$%-]/;
const HAS_LETTER = /[A-Za-z]/;

const position = (text, end) => {
  const match = POSITION.exec(text.slice(end, end + 32));
  if (!match) {
    return { end, line: null, col: null };
  }
  const line = Number(match[1] ?? match[3] ?? match[5]);
  const col = match[2] ?? match[4] ?? match[6];
  return { end: end + match[0].length, line, col: col ? Number(col) : null };
};

// Path candidates in `text`: [{ start, end, path, line, col }], end covering the position too.
export function findPathLinks(text) {
  const out = [];
  const source = String(text ?? "");
  PATH.lastIndex = 0;
  for (let match = PATH.exec(source); match; match = PATH.exec(source)) {
    const start = match.index;
    if (start > 0 && BEFORE_PATH.test(source[start - 1])) {
      continue;
    }
    if (URL_BEFORE.test(source.slice(Math.max(0, start - 200), start + match[0].length))) {
      continue;
    }
    const path = match[0].replace(TRAILING, "");
    if (!path || path === "/" || path === "~" || /^\.+\/?$/.test(path) || !HAS_LETTER.test(path)) {
      continue;
    }
    const at = position(source, start + path.length);
    out.push({ start, end: at.end, path, line: at.line, col: at.col });
  }
  return out;
}

// A markdown link target to a local file: { path, line, col }, or null for URLs and #anchors.
export function parseLinkTarget(target) {
  const raw = decodeURI(String(target ?? "").trim().replace(/^<|>$/g, ""));
  if (!raw || URL_TARGET.test(raw) && !raw.startsWith("file://")) {
    return null;
  }
  const value = raw.replace(/^file:\/\//, "");
  const hash = /#L(\d+)(?:C(\d+))?$|#.*$/.exec(value);
  const base = hash ? value.slice(0, hash.index) : value;
  const colon = /:(\d+)(?::(\d+))?$/.exec(base);
  const path = colon ? base.slice(0, colon.index) : base;
  const line = Number(hash?.[1] ?? colon?.[1]) || null;
  const col = Number(hash?.[2] ?? colon?.[2]) || null;
  return path ? { path, line, col } : null;
}

// Where `path` may be, most likely first: ~ is home, ./ and ../ the file's folder, a bare
// path the file's folder and then the repo root.
export function pathCandidates(path, { fileDir = null, root = null, home = null } = {}) {
  if (path.startsWith("/")) {
    return [resolvePath("/", path)];
  }
  if (path === "~" || path.startsWith("~/")) {
    return home ? [resolvePath(home, path.slice(2))] : [];
  }
  const bases = path.startsWith("./") || path.startsWith("../") ? [fileDir ?? root] : [fileDir, root];
  return [...new Set(bases.filter(Boolean).map((base) => resolvePath(base, path)))];
}

// An absolute file as { root, rel } under the longest matching root, else its own folder.
export function splitRoot(abs, roots = []) {
  const root = roots
    .filter((candidate) => candidate && (abs === candidate || abs.startsWith(`${candidate.replace(/\/$/, "")}/`)))
    .sort((a, b) => b.length - a.length)[0];
  if (root) {
    return { root, rel: abs.slice(root.replace(/\/$/, "").length + 1) };
  }
  return { root: parentOf(abs), rel: abs.slice(parentOf(abs).replace(/\/$/, "").length + 1) };
}

// The folders the Explorer must expand to show `rel`: "a/b/c.ts" -> ["a", "a/b"].
export function parentDirs(rel) {
  const parts = String(rel ?? "").split("/").slice(0, -1);
  return parts.map((_part, index) => parts.slice(0, index + 1).join("/"));
}

// `runs` ([{text, kind}]) cut at the link edges; link parts carry `link`.
export function splitRunsAtLinks(runs, links) {
  if (!links.length) {
    return runs;
  }
  const out = [];
  let at = 0;
  for (const run of runs) {
    let from = 0;
    const end = at + run.text.length;
    for (const link of links) {
      if (link.end <= at + from || link.start >= end) {
        continue;
      }
      const linkFrom = Math.max(link.start - at, from);
      const linkTo = Math.min(link.end - at, run.text.length);
      if (linkFrom > from) {
        out.push({ text: run.text.slice(from, linkFrom), kind: run.kind });
      }
      out.push({ text: run.text.slice(linkFrom, linkTo), kind: run.kind, link });
      from = linkTo;
    }
    if (from < run.text.length) {
      out.push({ text: run.text.slice(from), kind: run.kind });
    }
    at = end;
  }
  return out;
}
