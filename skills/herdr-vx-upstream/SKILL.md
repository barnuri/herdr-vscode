---
name: herdr-vx-upstream
description: Learn from and pull changes out of sardar099/herdr-vx, the upstream this repo was copied from, and from other community herdr-app mods. Use when asked to check upstream, sync herdr-vx changes, or find how another herdr-app mod solves a problem. Triggers: "check upstream", "what changed in herdr-vx", "sync from herdr-vx", "how do other mods do X".
---

# herdr-vx upstream

This repo (`herdr-vscode`) started as a copy of https://github.com/sardar099/herdr-vx (MIT) with
its full history. The git remote `upstream` points to it. Our code then diverges: it follows the
shared dev guidelines, uses vscode-icons, and adds mods herdr-vx does not have.

## Step 1: Fetch and list new upstream commits

```sh
git fetch upstream
git log --oneline "$(cat skills/herdr-vx-upstream/last-synced)"..upstream/main
```

`last-synced` holds the upstream commit that was last reviewed.

## Step 2: Review each commit

For each commit, read `git show <sha> --stat` and then the diff of the files that matter. Sort
each commit into one of three groups:

| Group | Action |
|---|---|
| Bug fix in a mod we kept | Port it by hand into our version. Do not cherry-pick: our files differ. |
| New feature we want | Add a task in `agent-spec/<slug>/tasks.md`, then build it in our style. |
| Not relevant (Material icons, CI providers we dropped) | Skip it. |

Never merge `upstream/main` into `master`. Our refactors make a merge a conflict storm.

## Step 3: Record the review

Write the newest reviewed upstream sha to `skills/herdr-vx-upstream/last-synced`. Commit it
together with the ports.

## Other references

Clone into a temp folder with `git clone --depth 1`. Read their `RECIPE.md` first.

| Repo | What to learn |
|---|---|
| `kidoln/herdr_desktop_mods` | Source Control panel, side-by-side diff, in-place edit |
| `napalmpapalam/herdr-find-in-files` | ripgrep search with a hit list and preview |
| `aBER0724/herdr-git-changes` | Zed-style git panel with checkboxes |
| `rabeeh-ta/herdr-git-graph` | Commit graph lanes, checkout on double-click |
| `riyhs/herdr-tool-rail` | Activity rail that opens panels in a side dock |
| `amster93/herdr-file-icons` | Generator that maps an icon theme into a mod |
| `Mantiq-com/herdr-telescope` | Find files by name or content with preview |
| `ship-it-mind/herdr-ports` | VS Code-style Ports view |

Search for more: `ghx search repos --topic herdr-mod` and `--topic herdr-layout`.
