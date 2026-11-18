// Pure logic for ~/.config/herdr-vscode/settings.json: { <section>: { <key>: value } }.

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// A missing or empty file is no settings; a broken file reports its error and is not used.
export function parseSettings(text) {
  if (!text || !text.trim()) {
    return { settings: {}, error: null };
  }
  try {
    const parsed = JSON.parse(text);
    return isObject(parsed) ? { settings: parsed, error: null } : { settings: {}, error: "settings.json is not a JSON object" };
  } catch (error) {
    return { settings: {}, error: String(error?.message ?? error) };
  }
}

export function readSetting(settings, section, key, fallback) {
  const values = isObject(settings) ? settings[section] : undefined;
  if (!isObject(values) || values[key] === undefined) {
    return fallback;
  }
  return values[key];
}

export function withSettings(settings, section, values) {
  const base = isObject(settings) ? settings : {};
  const current = isObject(base[section]) ? base[section] : {};
  return { ...base, [section]: { ...current, ...values } };
}

export const withSetting = (settings, section, key, value) => withSettings(settings, section, { [key]: value });

export const formatSettings = (settings) => `${JSON.stringify(settings, null, 2)}\n`;
