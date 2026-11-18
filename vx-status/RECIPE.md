# vx-status

A bottom bar for Herdr: the repo and branch you're working in, ahead / behind with fetch, pull and push (each confirmed), and changed / staged / conflicts / stashes.

![vx-status](preview.png)

## What you see

`props { style: "vscode" }` (the vx-code layout): `canvas`, no border, 12px text and 14px icons, a remote glyph first, `✕ errors ⚠ warnings` (opens Problems) and the listening-port count (opens Ports) after the repo chips, and on the right the repo's last pipeline (CI icon in its state colour + `passed` / `failed` / …) and the workspace name.

Default: 28px, `chrome`, a top border: folder (an accent layers icon when it's the repo you picked rather than the terminal's), branch (click copies), ↑↓ (menu: Push…, Pull… `--ff-only`, Fetch…), ✎ changed `ansi3`, + staged `ansi2`, ⚠ conflicts `ansi1`, ▣ stashes `dim`, `clean`.

## How it behaves

Follows the active repo (vx-workspace) or the focused terminal; rereads on change and every 8 s. Fetch / pull / push run only after their confirm dialog. Changed and conflicts open the Changes panel.

## Built from

`mods/vx-status`. Block: `{ "id": "status", "type": "block", "size": { "px": 28 }, "content": { "mod": "vx-status" } }`. Runs `git`, `mkdir` (the state folder).

**Install:** copy `mods/*` from this folder into `~/.config/herdr-app/mods/`, and also copy
`vx-icons/mods/vx-icons` from this repo (every vx mod draws its icons from it). Then put the
block in a layout you own (below). The whole set as a ready layout: the repo root (`layouts/vx.json`).

## Watch out

Every vx mod needs `vx-icons` next to it (icons go blank without it). The mods share state through Herdr's `shared()` keys `vx.*`, so they work alone but follow each other when installed together. Only one copy of each panel mod per layout.

## Done when

- In a repo the bar shows branch, ↑↓ and change counts.
- Push asks first.
- `herdr-app check` passes for every mod in this folder.
