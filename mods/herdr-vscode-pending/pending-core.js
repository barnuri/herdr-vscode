// Pure logic of the Pending Repos view: the repo-pending-audit skill's --json output, and its
// markers exactly as the skill prints them (↑ ahead, + new, ? untracked, ± modified, - deleted,
// ! conflicts, "no upstream"). Commits to pull are not local work at risk, so they never show.
export const MARKERS = [
  { key: "ahead", symbol: "↑", kind: "ahead" },
  { key: "new", symbol: "+", kind: "added" },
  { key: "untracked", symbol: "?", kind: "untracked" },
  { key: "modify", symbol: "±", kind: "modified" },
  { key: "deleted", symbol: "-", kind: "deleted" },
  { key: "merges", symbol: "!", kind: "conflict" },
];
export const NO_UPSTREAM = "no upstream";
export const NO_BRANCH = "no branch";

const count = (value) => (Number.isFinite(value) && value > 0 ? value : 0);

export function markersOf(status, headNeverPushed) {
  const markers = MARKERS.filter(({ key }) => count(status?.[key]) > 0)
    .map(({ key, symbol, kind }) => ({ kind, text: `${symbol}${count(status[key])}` }));
  return headNeverPushed ? [...markers, { kind: "noUpstream", text: NO_UPSTREAM }] : markers;
}

const FILE_KEYS = ["new", "untracked", "modify", "deleted", "merges"];

// A repo whose only pending work is commits gets one button: "push", or "pull" first when
// the remote also moved (plain git pull / git push, as the user's git config says).
// File changes, no remote or no upstream get none.
export function syncKindOf(entry) {
  const status = entry?.status ?? {};
  if (!entry?.has_remote || entry.head_never_pushed || !status.upstream || count(status.ahead) === 0) {
    return null;
  }
  if (FILE_KEYS.some((key) => count(status[key]) > 0)) {
    return null;
  }
  return count(status.behind) > 0 ? "pull" : "push";
}

export function relativeTo(path, root) {
  const base = String(root ?? "").replace(/\/+$/, "");
  return base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}

// The script's stdout as { root, scanned, repos } or { error }.
export function parseAudit(stdout) {
  let data = null;
  try {
    data = JSON.parse(stdout);
  } catch (error) {
    return { error: `repo-pending-audit printed no JSON: ${error.message}` };
  }
  if (!data || typeof data !== "object" || !Array.isArray(data.pending)) {
    return { error: "repo-pending-audit: no \"pending\" list in its output" };
  }
  const repos = data.pending.filter((entry) => typeof entry?.repo === "string").map((entry) => ({
    path: entry.repo,
    rel: relativeTo(entry.repo, data.root),
    branch: entry.status?.branch || NO_BRANCH,
    hasRemote: Boolean(entry.has_remote),
    markers: markersOf(entry.status, Boolean(entry.head_never_pushed)),
    sync: syncKindOf(entry),
  }));
  return { root: data.root ?? null, scanned: Number(data.scanned) || 0, repos };
}

// "3 of 70 repos pending".
export function summaryText(result) {
  return `${result.repos.length} of ${result.scanned} repo${result.scanned === 1 ? "" : "s"} pending`;
}
