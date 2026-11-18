# herdr-vscode

VS Code-style mods for the Herdr desktop app, in plain JavaScript (gpui-kit). The Herdr API is in
`~/.config/herdr-app/AGENTS.md` and `herdr.d.ts`.

## Build

- Edit shared code in `shared/*.js`, then run `node tools/build.mjs`. It copies `shared/` into every
  mod. Never edit a copy in `mods/*/`.
- Check with `npm test`, `herdr-app check mods/<mod>/` for every mod, `./sync.sh`, then
  `herdr-app status` (errors must be `[]`).

## User settings

Every user-facing setting, preference or toggle is stored with `shared/settings.js` in
`~/.config/herdr-vscode/settings.json`, one section per feature.

- Read with `getSetting(section, key, default)`. It is synchronous and reads a cache.
- Write with `setSetting(section, key, value)` or `setSettings(section, values)`. They update the
  cache and write the file. They do not write during `herdr-app check`.
- In a view's `init`, call `whenSettings(cx, (cx) => ...)` to apply the values once the file is read.
- Never keep a setting only in `shared()`, `localStorage` or layout state. Those are for runtime
  state: badges, leases, clipboard, MRU, command channels, dirty flags, open folders, caches.
- When you add a setting, add it to the table below and to the README "Settings" section.

| Section.key | Default | What |
| --- | --- | --- |
| `activity.order` | `[]` (built-in order) | Activity bar icon order |
| `activity.hidden` | `[]` | Hidden activity bar icons |
| `activity.explorerSections` | layout default | Explorer sections shown (`timeline`, `npm`) |
| `scm.view` | `"flat"` | Source Control "View as List" (`"flat"`) or "View as Tree" (`"tree"`) |
| `scm.diffLayout` | `"inline"` | Diff layout: `"split"` (side by side) or `"inline"` |
| `files.autoSave` | `"afterDelay"` | Auto Save: `"afterDelay"` or `"off"` |
| `files.blame` | `false` | Blame column in the file viewer |
| `explorer.showHidden` | `true` | Show hidden (dot) files in the Explorer and Files trees |
| `explorer.indent` | `16` | Tree indent per level in px (0–40), Explorer, Files and Source Control trees |
| `explorer.restoreWorkspace` | `false` | Reopen the last opened workspace after a restart; off = one-folder mode (the focused repo) |
| `explorer.indentGuides` | `"always"` | Tree indent guides: `"always"`, `"onHover"` or `"none"` |
| `editor.fontFamily` | Herdr's font | Code view font (preview, editor, diff, blame, hashes) |
| `editor.fontSize` | Herdr's size | Code view font size |
| `editor.lineHeight` | `1.55` | Code row height as a multiple of the font size |
| `editor.tabSize` | `4` | Spaces per tab in previews and diffs |
| `editor.wordWrap` | `false` | Soft wrap in the file editor |
| `editor.fontLigatures`, `editor.renderWhitespace`, `editor.cursorStyle`, `editor.cursorBlink`, `editor.minimap` | VS Code's | Imported from VS Code; not applied (gpui's editor has no such options) |
| `tabs.sizing`, `tabs.wrap`, `tabs.preview` | VS Code's | Imported from VS Code; not applied yet |
| `search.caseSensitive` | `false` | Search: match case |
| `search.word` | `false` | Search: whole word |
| `search.regex` | `false` | Search: regular expression |
| `graph.allBranches` | `true` | Git History: all branches (`false`: current branch) |
| `ci.filter` | `"all"` | CI / CD: run filter |
| `ci.mine` | `true` | CI / CD: only my runs |
| `panel.view` | `"terminal"` | Bottom panel tab: `"problems"`, `"terminal"` or `"ports"` |
| `panel.visible` | `true` | Bottom panel shown (⌘J / ⌃` toggle it) |
| `panel.height` | `260` | Bottom panel height in px (drag its top edge) |
| `terminal.tabs.location` | `"left"` | Side of the panel's terminal list (shown with 2+ terminals): `"left"` or `"right"` |
| `terminal.tabs.width` | `170` | Width of that list in px (drag its edge; narrow shows icons only) |
| `pending.auditScript` | `""` (bundled script) | Pending Repos audit script; falls back to its mod.json `settings` |
| `pending.root` | `""` (`~/code`) | Pending Repos folder to scan; falls back to its mod.json `settings` |

`node tools/import-vscode-settings.mjs` fills `editor`, `tabs`, `scm`, `files` and `explorer` from
the user's VS Code settings (`--herdr`: also Herdr's terminal `font`). Settings change live: the
activity mod watches the file.

## Exceptions: shared configs

These settings stay in files that the Herdr plugins share, so one config drives both:

- Running view settings (sort, grouping, spacing, confirm kill, ...):
  `~/.local/state/herdr-folders/state.json` (herdr-folders).
- Projects: `~/.config/herdr/plugins/config/barnuri.project-manager/projects.json`.
- Updates: `~/.config/herdr/plugins/config/barnuri.auto-update/config.json`.
- Terminal font, size and line height: Herdr's own `~/.config/herdr-app/settings.json`.
- Theme: the layout's root `theme` (the theme picker changes it); `themes/herdr-vscode-*.json` come
  from `node tools/build-vscode-themes.mjs`.

## Rules

- Follow `~/.config/opencode/skills/dev-guidelines/references/coding-principles.md`.
- Never restart herdr-app. Never stash, reset or checkout. Move files to the trash, never `rm`.
