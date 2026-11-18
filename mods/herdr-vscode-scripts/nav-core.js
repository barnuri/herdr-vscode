// A history is { list: [tab ids], at }: visiting a tab drops anything after `at` (like a
// browser), moves the tab to the end, and caps the list.

export const NAV_MAX = 50;
export const emptyNav = () => ({ list: [], at: -1 });

export function navVisit(history, tab) {
  if (history.list[history.at] === tab) {
    return history;
  }
  const list = [...history.list.slice(0, history.at + 1).filter((id) => id !== tab), tab].slice(-NAV_MAX);
  return { list, at: list.length - 1 };
}

// The next place `step` (-1 back, +1 forward) away whose tab still exists, or null.
export function navStep(history, step, live) {
  const inRange = (index) => index >= 0 && index < history.list.length;
  let at = history.at + step;
  while (inRange(at) && !live.has(history.list[at])) {
    at += step;
  }
  return inRange(at) ? { list: history.list, at } : null;
}
