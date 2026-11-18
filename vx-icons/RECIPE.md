# vx-icons

The icon pack every vx mod draws from: the [vscode-icons](https://github.com/vscode-icons/vscode-icons) file and folder icons (v13.0.0: picks by file name, extension and folder name, light-theme variants, open folders) and the vx UI icons.

![vx-icons](preview.png)

## What you see

Nothing on its own. Shown in a layout anyway, it lists a few sample names with their icons.

## How it behaves

Other mods read `mods/vx-icons/icons.json` (name / extension / folder tables) and draw `mods/vx-icons/icons/<id>.svg` with `image()`, and `mods/vx-icons/ui/<name>.svg` with `svg()` (tinted by the theme). The lookup: a path rule beats a name, a name beats an extension, the longest extension wins; light themes use the light table first.

## Built from

`mods/vx-icons`: `icons/` (1,493 SVGs from vscode-icons v13.0.0, MIT, licence in `LICENSE-vscode-icons.txt`; ids like `f_typescript`, `fd_src`, `fd_src_open`, `folder`, `folder_open`, `root_folder`), `icons.json`, `ui/` (36 UI icons), a sample `main.js`. Rebuild with `node tools/build-icons.mjs <unpacked vscode-icons .vsix extension folder> <vscode-icons src/iconsManifest/languages.ts>`: it skips SVGs with active content (scripts, event handlers, `foreignObject`) and refuses a non-empty `icons/` folder. Install: copy `mods/vx-icons` into `~/.config/herdr-app/mods/`. The folder name must stay `vx-icons`.

## Watch out

Keep the folder name `vx-icons`: the other mods read it by path. A symlinked mod folder loads code but not images, so copy it.

## Done when

- `package.json` gets the Node icon, `src` the src folder icon, open folders their open icon.
- Every vx mod's buttons show their UI icons.
- `herdr-app check` passes for every mod in this folder.
