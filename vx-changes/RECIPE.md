# vx-changes

VS Code's Source Control with GitLens on top: a commit box with Commit & Push / Sync / Amend, staged and unstaged changes with stage / discard per file or hunk, and Commits (graph lanes), Branches, Remotes, Stashes, Tags and Search & Compare, with diffs in a centre tab and a Commit Graph.

![vx-changes](preview.png)

## What you see

- **Header** (34px): `[repo ▾]` switcher, then list / tree, refresh and ⋯ (Pull, Push or Publish, Sync, Fetch; Stash Changes, Stash Staged; New Branch, Commit Graph; View as List / Tree).
- **Branch strip**: a `ansi2`-tinted pill `⑂ branch ⌄` (New Branch… and the recent branches to switch to), then `↓n ↑n` (click: sync…) or `☁ Publish` for a branch with no upstream.
- **Commit card**: a message box that grows (2 to 10 rows; ⌘Enter commits), and the subject's length (`ansi3` past 50, `ansi1` past 72). Under it a 30px `accent` button: `Commit (n)`, `Commit All (n)` when nothing is staged, `Sync Changes n↓ n↑` or `Publish Branch` when there's nothing to commit, `Amend Commit` (`ansi3`) while amending; its ⌄ has Commit & Push, Commit & Sync and Amend Last Commit. Errors show in a dismissable `ansi1` box.
- **Merge Changes / Staged Changes / Changes**: a 26px header with a coloured icon and count pill (`ansi1` / `ansi2` / `ansi3`), Unstage All, Discard All, Stage All. Each 24px file row: vscode-icons icon, name in its git colour (struck through when deleted), folder in `dim`, five little `+`/`−` blocks, and a letter chip (`U` new, `M`, `D`, `A`, `!` conflict). On hover the blocks give way to Open File, Discard and Stage / Unstage. Click: diff; double-click: the file; right-click: Open Changes, Open File, Stage / Unstage, Discard, Reveal in Finder, Copy Path, Copy Relative Path.
- **Sections** (collapsible, a tinted icon tile and count pill each): Commits as a graph (lane lines and dots, hollow for merges and for commits not pushed yet, ↑ on those), author initials in a colour of their own, the commit's first ref as a pill (+n for more; a local branch level with its remote shows ☁), an `ansi4` "Incoming from origin/…" group when behind; hover: copy SHA, compare; right-click: Show Files, Compare HEAD with This, Commit Graph, Open on GitHub / GitLab, Copy SHA / Message / Link. Branches (click to switch; hover: compare, delete), Remotes (hover: compare, check out as a local branch), Stashes (hover: apply, pop, drop), Tags, Search & Compare.
- **Diff tab**: one per space, inline or side by side, syntax-coloured, `+`/`−` tinted `ansi2`/`ansi1`; for working files, a commit (vs first parent), a stash or a compare. Working and staged diffs have a hunk bar: `↑ 1/3 ↓` and Stage Hunk / Unstage Hunk; click a hunk's `@@` line to pick it.
- **Commit Graph tab** (vx-graph): lanes per branch, merge commits hollow, branch / tag / remote labels, author, age, hash; click a commit for its message and files.

## How it behaves

Stage and unstage touch only the index (`add`, `reset -q HEAD`, `rm --cached` before the first commit; a hunk with `git apply --cached [--reverse]`); conflicts are never staged by Stage all. Commit takes what's staged (Commit All stages every change first); Amend loads the last message and refuses if HEAD moved. Commit & Push / Sync commit, then ask before the push.

Everything else that changes something asks first, showing the commands it will run: Discard (`git restore --worktree` for edited files, macOS `trash` for new ones, so they're in the Trash; staged changes stay), Pull (`--ff-only`), Push, Publish (`push -u origin`), Sync (`pull --rebase` then `push`), Fetch, Switch branch, Check out a remote branch, Delete branch (`branch -d`, refuses unmerged work), Apply / Pop / Drop stash. New Branch and Stash are dialogs (name, switch to it; message, include new files, only staged), which are the ask.

Popups and dialogs are copies of the mod that post a command to the panel that opened them (shared `vx.changes.cmd`, addressed by a per-copy id).

## Built from

`mods/vx-changes` (panel.js, sections.js, scm-popups.js, diff.js; the decisions in `scm-core.js`, tested) and `mods/vx-graph`. Block: `{ "id": "changes", "type": "block", "content": { "mod": "vx-changes" } }`. Runs `git` only.

**Install:** copy `mods/*` from this folder into `~/.config/herdr-app/mods/`, and also copy
`vx-icons/mods/vx-icons` from this repo (every vx mod draws its icons from it). Then put the
block in a layout you own (below). The whole set as a ready layout: the repo root (`layouts/vx.json`).

## Watch out

Every vx mod needs `vx-icons` next to it (icons go blank without it). The mods share state through Herdr's `shared()` keys `vx.*`, so they work alone but follow each other when installed together. Only one copy of each panel mod per layout.

## Done when

- Staging a file moves it to Staged; Commit commits only it; with nothing staged the button reads Commit All.
- Stage Hunk in the diff tab stages just that hunk; Discard asks, then the file is back to its committed copy (a new file is in the Trash).
- A commit in Commits expands to its files and each opens its diff.
- The Commit Graph draws a merged branch as a second lane joining back.
- `herdr-app check` passes for every mod in this folder.
