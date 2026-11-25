// Find and replace over plain text, for the file viewer's find bar and the Search view.
// Offsets are UTF-16 code units, the same as the editor's selected_range().

const MAX_MATCHES = 20000;
const ESCAPE = /[.*+?^${}()|[\]\\]/g;

export const escapeRegex = (text) => text.replace(ESCAPE, "\\$&");

// A global RegExp for the query and options, or { error } for an invalid regular expression.
export function buildPattern(query, { caseSensitive = false, word = false, regex = false } = {}) {
  if (!query) {
    return { pattern: null, error: null };
  }
  const source = regex ? query : escapeRegex(query);
  try {
    return { pattern: new RegExp(word ? `\\b(?:${source})\\b` : source, `gm${caseSensitive ? "" : "i"}`), error: null };
  } catch (error) {
    return { pattern: null, error: String(error?.message ?? error) };
  }
}

// Every match as { start, end }, in order. A zero-length match is skipped.
export function findMatches(text, pattern, limit = MAX_MATCHES) {
  const matches = [];
  if (!pattern) {
    return matches;
  }
  const search = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  for (let found = search.exec(text); found && matches.length < limit; found = search.exec(text)) {
    if (found[0].length === 0) {
      search.lastIndex++;
      continue;
    }
    matches.push({ start: found.index, end: found.index + found[0].length });
  }
  return matches;
}

// The match to select next: the first at or after `from` (or the last at or before it going back), wrapping.
export function nextMatchIndex(matches, from, backward = false) {
  if (!matches.length) {
    return -1;
  }
  if (backward) {
    for (let index = matches.length - 1; index >= 0; index--) {
      if (matches[index].end <= from) {
        return index;
      }
    }
    return matches.length - 1;
  }
  const index = matches.findIndex((match) => match.start >= from);
  return index === -1 ? 0 : index;
}

// The match covering exactly [start, end), or -1.
export const matchIndexAt = (matches, start, end) => matches.findIndex((match) => match.start === start && match.end === end);

// $1, $&, $$ and $<name> in a regular-expression replacement.
export function expandTemplate(template, found) {
  return template.replace(/\$(\d{1,2}|&|\$|<([^>]+)>)/g, (all, token, name) => {
    if (token === "$") {
      return "$";
    }
    if (token === "&") {
      return found[0];
    }
    if (name) {
      return found.groups?.[name] ?? "";
    }
    return found[Number(token)] ?? "";
  });
}

// The replacement for the match starting at `start`: a literal, or the template expanded in regex mode.
export function replacementAt(text, pattern, start, replacement, regex) {
  if (!regex) {
    return replacement;
  }
  const sticky = new RegExp(pattern.source, pattern.flags.replace("g", "") + "y");
  sticky.lastIndex = start;
  const found = sticky.exec(text);
  return found ? expandTemplate(replacement, found) : replacement;
}

// The text with every match replaced, and how many were.
export function replaceAll(text, pattern, replacement, regex) {
  const matches = findMatches(text, pattern);
  if (!matches.length) {
    return { text, count: 0 };
  }
  let out = "";
  let last = 0;
  for (const match of matches) {
    out += text.slice(last, match.start) + replacementAt(text, pattern, match.start, replacement, regex);
    last = match.end;
  }
  return { text: out + text.slice(last), count: matches.length };
}

// The text with only the match starting at `start` replaced.
export function replaceOne(text, pattern, start, end, replacement, regex) {
  return text.slice(0, start) + replacementAt(text, pattern, start, replacement, regex) + text.slice(end);
}
