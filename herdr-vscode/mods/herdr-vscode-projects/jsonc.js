// JSON with comments and trailing commas (VS Code's .code-workspace, settings.json).

function stringEnd(text, openQuote) {
  let index = openQuote + 1;
  while (index < text.length && text[index] !== '"') {
    index += text[index] === "\\" ? 2 : 1;
  }
  return index;
}

function stripComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const char = src[i];
    const next = src[i + 1];
    if (char === '"') {
      const end = stringEnd(src, i);
      out += src.slice(i, end + 1);
      i = end + 1;
    } else if (char === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") {
        i++;
      }
    } else if (char === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
    } else {
      out += char;
      i++;
    }
  }
  return out;
}

function closesContainer(text, commaAt) {
  let index = commaAt + 1;
  while (index < text.length && /\s/.test(text[index])) {
    index++;
  }
  return text[index] === "}" || text[index] === "]";
}

function stripTrailingCommas(text) {
  let clean = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      const end = stringEnd(text, i);
      clean += text.slice(i, end + 1);
      i = end;
      continue;
    }
    if (char === "," && closesContainer(text, i)) {
      continue;
    }
    clean += char;
  }
  return clean;
}

export function stripJsonc(text) {
  return stripTrailingCommas(stripComments(String(text ?? "")));
}

export function parseJsonc(text) {
  return JSON.parse(stripJsonc(text));
}
