// Source Control decisions as plain data: what the Commit button does, what Discard touches, one
// diff hunk as a patch git can apply.

const STAT_BLOCK_COUNT = 5;
const SUBJECT_SOFT_LIMIT = 50;
const SUBJECT_HARD_LIMIT = 72;
const PATCH_HEADER = /^(diff --git |index |--- |\+\+\+ |old mode |new mode )/;
const INVALID_BRANCH = /\.\.|[~^:?*[\\]|@\{|\/\/|\/$|^\/|\.lock$|\.$|^-/;
const NEED_MESSAGE = "Type a message first";

const plural = (count, word) => `${word}${count === 1 ? "" : "s"}`;

// The big button under the message box, VS Code's way: Commit, or Commit All when nothing is
// staged, or, with nothing to commit, Sync Changes / Publish Branch.
// state = { amend, staged, unstaged, conflicts, ahead, behind, upstream, branch, head, message, busy }
export function primaryAction(state) {
  const hasMessage = Boolean(String(state.message ?? "").trim());
  if (state.conflicts) {
    return { kind: "commit", label: "Commit", enabled: false, tip: "Resolve the merge conflicts first" };
  }
  if (state.amend) {
    return { kind: "amend", label: "Amend Commit", enabled: Boolean(state.head && hasMessage && !state.busy), tip: "Rewrite the latest commit with the staged changes and this message" };
  }
  if (state.staged) {
    const tip = hasMessage ? `Commit ${state.staged} staged ${plural(state.staged, "file")}` : NEED_MESSAGE;
    return { kind: "commit", label: "Commit", enabled: hasMessage && !state.busy, tip };
  }
  if (state.unstaged) {
    const tip = hasMessage ? `Stage all ${state.unstaged} ${plural(state.unstaged, "change")}, then commit` : NEED_MESSAGE;
    return { kind: "commitAll", label: "Commit All", enabled: hasMessage && !state.busy, tip };
  }
  if (state.branch && state.head && !state.upstream) {
    return { kind: "publish", label: "Publish Branch", enabled: !state.busy, tip: `Push ${state.branch} to origin and track it` };
  }
  if (state.upstream && (state.ahead || state.behind)) {
    const tip = `Pull ${state.behind} and push ${state.ahead} with ${state.upstream}`;
    return { kind: "sync", label: "Sync Changes", enabled: !state.busy, tip, ahead: state.ahead, behind: state.behind };
  }
  return { kind: "commit", label: "Commit", enabled: false, tip: "Nothing to commit" };
}

// Discard for rows of Changes: tracked files go back to the index's copy (`git restore
// --worktree`), new files go to the Trash. Conflicted files are left alone.
export function discardPlan(files) {
  const candidates = (files ?? []).filter((file) => !file.conflict);
  return {
    restore: candidates.filter((file) => !file.untracked && file.unstaged).map((file) => file.path),
    trash: candidates.filter((file) => file.untracked).map((file) => file.path),
  };
}

// `git diff` output lines -> the header (diff --git, index, ---, +++) and its hunks.
export function splitHunks(lines) {
  const head = [];
  const hunks = [];
  for (const line of lines ?? []) {
    if (line.startsWith("@@")) {
      hunks.push([line]);
    } else if (hunks.length) {
      hunks[hunks.length - 1].push(line);
    } else {
      head.push(line);
    }
  }
  return { head, hunks };
}

// One hunk as a patch for `git apply --cached` (add --reverse to unstage a staged hunk).
export function hunkPatch(head, hunk) {
  const keep = head.filter((line) => PATCH_HEADER.test(line));
  return `${[...keep, ...hunk].join("\n")}\n`;
}

// "Maya Chen" -> "MC", "leo" -> "LE".
export function initials(name) {
  const words = String(name ?? "").replace(/[<(].*$/, "").trim().split(/[\s._-]+/).filter(Boolean);
  if (!words.length) {
    return "?";
  }
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

function plusBlocks(add, del, filled, total) {
  const rounded = Math.round((filled * add) / total);
  const plus = add && !rounded ? 1 : rounded;
  return del && plus === filled ? Math.max(add ? 1 : 0, filled - 1) : plus;
}

// GitHub's five little blocks for +add -del: ["+", "+", "-", " ", " "].
export function statBlocks(add, del, n = STAT_BLOCK_COUNT) {
  const total = (add ?? 0) + (del ?? 0);
  if (!total) {
    return Array(n).fill(" ");
  }
  const filled = Math.min(n, Math.max(add && del ? 2 : 1, Math.ceil(Math.log2(total + 1) / 2)));
  const plus = plusBlocks(add, del, filled, total);
  return [...Array(plus).fill("+"), ...Array(filled - plus).fill("-"), ...Array(n - filled).fill(" ")];
}

function subjectLevel(length) {
  if (length > SUBJECT_HARD_LIMIT) {
    return "over";
  }
  return length > SUBJECT_SOFT_LIMIT ? "long" : "ok";
}

// The subject line's length against the usual 50 / 72 limits.
export function subjectInfo(message) {
  const len = String(message ?? "").split("\n")[0].trim().length;
  return { len, level: subjectLevel(len) };
}

// A web link to a commit for GitHub / GitLab remotes, else null. remote = parseRemote(url) with
// its host already resolved from an SSH alias.
export function commitUrl(remote, sha) {
  if (!remote?.host || !sha) {
    return null;
  }
  const host = remote.host;
  if (/github/i.test(host)) {
    return `https://${host}/${remote.path}/commit/${sha}`;
  }
  if (/gitlab/i.test(host)) {
    return `https://${host}/${remote.path}/-/commit/${sha}`;
  }
  return null;
}

// A branch name git would accept (the common rules of `git check-ref-format --branch`).
export function badBranchName(name) {
  const text = String(name ?? "");
  if (!text.trim()) {
    return "Type a name";
  }
  if (/\s/.test(text)) {
    return "No spaces";
  }
  return INVALID_BRANCH.test(text) ? "Not a valid branch name" : null;
}
