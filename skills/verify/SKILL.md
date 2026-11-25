---
name: verify
description: Verify the herdr-vscode repository and its live native Herdr UI. Use this skill whenever the user asks to verify, smoke test, validate, test the UI, confirm that features work, or check previews, diffs, Quick Open, F1, keybindings, and mods. Trigger before declaring a UI change complete.
compatibility: Requires Node 18+, herdr-app, this repository, a running visible Herdr window, and macOS for Accessibility-driven interaction checks.
---

# Verify herdr-vscode

Verify code and the installed native Herdr UI. Playwright is not suitable because Herdr uses GPUI and has no DOM.

## Scope

Run both layers:

1. Deterministic repository checks.
2. Visible native UI smoke checks in the running Herdr window.

Never replace a native UI check with a headless browser check. Never restart `herdr-app`.

## Repository checks

Run from the repository root:

```sh
node tools/build.mjs
npm test
```

Run `herdr-app check` for every folder under `mods/` that contains `mod.json`:

```sh
find mods -name mod.json -exec dirname {} \;
```

Then run:

```sh
./sync.sh
herdr-app status
```

The status `errors` array must be empty.

## Native UI workflow

Use the running app visibly. Save screenshots under `agent-spec/<session>/verify/` or `.playwright-cli/` if the active workflow already owns that folder.

Use `herdr-app shot <path>` for evidence. Inspect each screenshot immediately.

Use `herdr-app do` and mod commands for state changes when possible. Use macOS Accessibility automation only for keyboard and click steps that have no Herdr command, such as typing into Quick Open.

## Required UI scenarios

### S1: Quick Open and F1

1. Confirm the shown layout is `herdr-vscode` with `herdr-app status`.
2. Press F1 through the visible macOS UI.
3. Confirm the VS Code-style Quick Open overlay opens with `>` in command mode.
4. Confirm the list contains both `herdr-vscode` mod commands and Herdr app commands, such as terminal, pane, tab, layout, and app actions.
5. Search for one Herdr command and one mod command.
6. Capture `quickopen-f1.png`.

### S2: File previews

Use disposable fixture files outside the repository or ignored test fixtures. Test:

- HTML: preview card appears and Open Preview launches the default app.
- Markdown: rendered view appears, then Code mode renders source.
- PNG, GIF, SVG: image draws inline without a loading or error message.
- Video: video preview card appears and Open Preview launches the default app.

Open files through Explorer or `herdr-app do` with `herdr-vscode-files` view props. Capture one screenshot per type.

### S3: Git diff views

Use a disposable repository fixture. Verify:

- Modified text file in inline diff.
- Modified text file in split diff.
- Added file.
- Deleted file.
- Untracked file.
- Binary file change reports a controlled message instead of a blank view.
- Hunk navigation does not leave an empty list.

Capture `diff-inline.png`, `diff-split.png`, and `diff-deleted.png`.

## Evidence

Write a concise `verification.md` beside the evidence images. Include:

- Commands run and exit codes.
- Herdr status errors.
- Every scenario ID with PASS or FAIL.
- Absolute screenshot paths.
- Exact failure and reproduction steps for each FAIL.

Do not report PASS from code inspection alone. A UI scenario passes only after visible evidence in the running app.

## Completion gate

Finish only when:

- `npm test` passes.
- Every `herdr-app check` passes.
- `./sync.sh` passes.
- `herdr-app status` has no errors.
- Every requested UI scenario has evidence and passes, or the report names the exact blocker.
