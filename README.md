# herdr-vx

A VS Code-style workspace for [Herdr Desktop](https://herdr.dev): a multi-root Explorer, GitLens-style
git, GitLab and GitHub CI, a commit graph and a package-script runner, all following the repo you're
working in.

![herdr-vx](preview.png)

Herdr's own panels follow the focused terminal's folder, so a terminal sitting in a folder of several
repos shows nothing useful. herdr-vx reads your `*.code-workspace` (or a folder of repos) and keeps
one **active repo** that every panel follows: the one you pick, else the repo your terminal is in.

Two layouts:

- **`vx-code`**: the whole window laid out like the current VS Code: title bar with a command
  center (Go to File), activity bar, side bar, editor and bottom panel as rounded cards, and a status
  bar. Ships the **One Monokai** theme. See [vx-code/RECIPE.md](vx-code/RECIPE.md).
- **`vx`**: Herdr's own window with the vx panels on the right.

![vx-code](vx-code/preview.png)

## What's in it

| Mod | Where | What |
|---|---|---|
| **vx-workspace** | Files panel | The Explorer: every root of the workspace with its file tree, git colours, ignored folders dimmed and a filter across all roots. Add / remove / rename / drag-reorder roots (written to the `.code-workspace` the way VS Code writes it); Open, Recent, New, Save As and Close workspace. |
| **vx-changes** | Changes panel | Staged / unstaged / conflicts, stage and unstage, commit and amend, plus GitLens-style Commits (expand for files), Branches, Remotes, Stashes, Tags, and Search & Compare. |
| **vx-ci** | CI panel (⌘⌥C) | GitLab pipelines (via `glab`) and GitHub Actions runs (via `gh`): runs, jobs by stage, retry, cancel, run a pipeline or dispatch a workflow, download artifacts. |
| **vx-graph** | centre tab | Commit Graph: branch lanes, branch and tag labels, commit details and their diffs. |
| **vx-files** | centre tab | File preview: syntax colours, Markdown, images, GitLens blame with an age heatmap, file and line history, and **Edit** (Herdr's code editor, ⌘S saves). Also the Timeline side-bar section. |
| **vx-tabs** | tab bar | Tabs with icons and repo context, italic preview tabs (double-click keeps one), pinned tabs, all-tabs list and ⌘E switcher, the package-script runner; in vx-code also the breadcrumbs. |
| **vx-scripts** | popup | Every `package.json` script (workspace packages too), run in a new tab or beside you, with npm / pnpm / yarn / bun detected and switchable. Also the NPM Scripts side-bar section. |
| **vx-status** | bottom bar | Repo, branch, ↑↓ with fetch / pull / push, changes; with the Claude Code plugin, the model and context / usage meters. |
| **vx-search** | side bar (vx-code) | Search across every repo of the workspace (`git grep`): Match Case, Whole Word, Regex, files to include; a match opens the file at its line. |
| **vx-panel** | bottom panel (vx-code) | Problems (conflicts, failing pipelines, branches behind, and **Run checks**: the repo's typecheck / lint scripts as file:line rows), Terminal (shells that never become tabs), Ports (listening programs: open, or stop after asking). |
| **vx-activity** | activity bar (vx-code) | Explorer, Search, Source Control, CI, Spaces, Agents with badges; Graph and Settings. Also the side bar's title. |
| **vx-titlebar** | title bar (vx-code) | Workspace name, ← → through visited tabs, the command center (Go to File, `>` for commands), layout toggles. |
| **vx-icons** | assets | [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) icons (MIT) and the UI icons. |

Changes, CI and Graph each have a `repo ▾` switcher in their header.

![Changes and a diff](docs/changes.png)

## Install

Paste this into your agent inside Herdr:

```text
Read ~/.config/herdr-app/AGENTS.md, then add this layout: https://github.com/sardar099/herdr-vx
```

For the VS Code layout: `... then add this layout: https://github.com/sardar099/herdr-vx/tree/main/vx-code`.

Or by hand, from a clone:

```sh
./sync.sh --layout vx-code      # every mod, the themes, and the layout (or --layout vx)
herdr-app do layout.switch '{"name":"vx-code"}'
```

vx-code's keys are in [vx-code/keys.json](vx-code/keys.json) (merge its `layout:vx-code` section
into `~/.config/herdr-app/keys.json`): ⌘P Go to File, ⌘⇧F Search, ⌘⇧E Explorer, ⌘⇧G Source
Control, ⌘J or `` ctrl-` `` the panel, ⌘E switch tab, ⌘\ split, ⌘S save the edited file. One Monokai is
in the theme picker once `themes/one-monokai.json` is in `~/.config/herdr-app/themes/`.

**Just one piece?** Each folder at the top of this repo is its own gallery entry with its own
recipe: `vx-workspace/` (Explorer + preview tab), `vx-changes/` (+ Commit Graph), `vx-ci/`,
`vx-tabs/` (+ script runner), `vx-status/`, and `vx-icons/` (the icon pack every vx mod needs).
`vx-code/` is the VS Code layout with every mod it uses.

Your own layout stays as it was; `ctrl-shift-l` (⌘⇧L on macOS) switches back. Optional key for CI
(add to `~/.config/herdr-app/keys.json`): `"cmd-alt-c": "mod.open:vx-ci"`.

The Claude Code plugin that fills the status bar's model and usage meters:

```sh
claude plugin marketplace add sardar099/herdr-vx
claude plugin install vx-status@vx
```

## Needs

- **git**. **glab** (logged in) for GitLab CI, **gh** (logged in) for GitHub CI. SSH host aliases in
  `~/.ssh/config` (e.g. `Host work-github`) are resolved to their real host.
- macOS is tested. Folder listings use `sh`, so Linux should work; Windows isn't supported.

## Safety

Reads use `git --no-optional-locks -c core.fsmonitor=false`, so nothing writes under `.git` behind
your back. Programs get argument lists, never shell strings built from file names or API data.
Anything that changes a repo or CI asks first: push, pull, fetch, retry, cancel, run pipeline,
dispatch, switch branch, apply stash. Stage and unstage touch only the index; commit is a button.
Nothing here deletes files or discards changes.

What vx-code adds: **Edit** writes the file you're editing only when you press Save (⌘S), and
refuses if the file changed on disk since you opened it. **Run checks** runs the repo's own
`typecheck` / `lint` scripts from `package.json` when you click it. **Ports** lists listening
programs with `lsof`; Stop sends SIGTERM and asks first. Search is read-only (`git grep`).

## Development

`shared/` holds the code every mod uses; `tools/build.mjs` copies it into each mod folder (a Herdr mod
can only import from its own folder, and people install a mod by copying it). `*-core.js` files are
pure and tested under node.

```sh
npm test       # node --test tests/
./sync.sh      # build, herdr-app check, install mods + themes + our installed layouts (atomic; unchanged skipped)
```

How it's put together, for an agent rebuilding it: [RECIPE.md](RECIPE.md).

## Licence

MIT, see [LICENSE](LICENSE). The Material Icon Theme icons in `mods/vx-icons/icons/` are MIT,
copyright Material Extensions; their licence is in `mods/vx-icons/LICENSE-material-icon-theme.txt`.
