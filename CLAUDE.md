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
| `explorer.indentGuides` | `"always"` | Tree indent guides: `"always"`, `"onHover"` or `"none"` |
| `search.caseSensitive` | `false` | Search: match case |
| `search.word` | `false` | Search: whole word |
| `search.regex` | `false` | Search: regular expression |
| `graph.allBranches` | `true` | Git History: all branches (`false`: current branch) |
| `ci.filter` | `"all"` | CI / CD: run filter |
| `ci.mine` | `true` | CI / CD: only my runs |
| `panel.view` | `"terminal"` | Bottom panel tab: `"problems"`, `"terminal"` or `"ports"` |
| `pending.auditScript` | `""` (bundled script) | Pending Repos audit script; falls back to its mod.json `settings` |
| `pending.root` | `""` (`~/code`) | Pending Repos folder to scan; falls back to its mod.json `settings` |

## Exceptions: shared configs

These settings stay in files that the Herdr plugins share, so one config drives both:

- Running view settings (sort, grouping, spacing, confirm kill, ...):
  `~/.local/state/herdr-folders/state.json` (herdr-folders).
- Projects: `~/.config/herdr/plugins/config/barnuri.project-manager/projects.json`.
- Updates: `~/.config/herdr/plugins/config/barnuri.auto-update/config.json`.

## Rules

- Follow `~/.config/opencode/skills/dev-guidelines/references/coding-principles.md`.
- Never restart herdr-app. Never stash, reset or checkout. Move files to the trash, never `rm`.
