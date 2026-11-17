# vx-tabs

A tab bar for Herdr with the package-script runner built in and Files · Changes · CI · Graph on the right. Scripts come from `package.json` (workspace packages too) with npm / pnpm / yarn / bun detected and switchable.

![vx-tabs](preview.png)

## What you see

Tab pills as in Herdr (agent icon, spinner, status dot, ×), `+`, then `[pm logo] script ▾ │ ▶`, a divider, and Files · Changes · CI · Graph right-aligned (the open panel highlighted). ▾ opens the script list (vx-scripts): project name, the installed package managers (the detected one ✓), a filter, Recent, every script with its command, ⧉ run beside and ▶ run in a new tab.

## How it behaves

Double-click a tab to rename, drag to reorder, right-click for Herdr's tab menu, wheel to switch; each space remembers its open panel. Scripts follow the active repo (vx-workspace) or the focused folder, looking up to 6 folders for `package.json`; the package manager comes from `packageManager`, else the lockfile, else npm, and the list's choice is kept per project. ▶ runs `<pm> run <script>` in a new tab in the package's folder. Graph opens the Commit Graph (vx-graph) of the active repo. `mod.open:vx-scripts` opens the list.

## Built from

`mods/vx-tabs` and `mods/vx-scripts`. Block: `{ "id": "tabs", "type": "block", "size": { "px": 42 }, "window_drag": true, "content": { "mod": "vx-tabs" } }`. Panel buttons appear for `files`, `changes`, `ci` children of a `panel-body` stack in a `panel` column.

**Install:** copy `mods/*` from this folder into `~/.config/herdr-app/mods/`, and also copy
`vx-icons/mods/vx-icons` from this repo (every vx mod draws its icons from it). Then put the
block in a layout you own (below). The whole set as a ready layout: the repo root (`layouts/vx.json`).

## Watch out

Every vx mod needs `vx-icons` next to it (icons go blank without it). The mods share state through Herdr's `shared()` keys `vx.*`, so they work alone but follow each other when installed together. Only one copy of each panel mod per layout.

## Done when

- In a JS project the control shows the detected package manager and `dev`.
- ▶ starts the script in a new tab in the project folder.
- Files · Changes · CI · Graph sit at the right edge and toggle their panels.
- `herdr-app check` passes for every mod in this folder.
