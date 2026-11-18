# Activity-bar extensions

Any mod can add a view to the vx-code activity bar, the way a VS Code extension contributes a
view container. Put a `vx-extension.json` file in the mod's folder
(`~/.config/herdr-app/mods/<folder>/`). vx-activity finds it, shows its icon after the built-in
views, and shows its view in the side bar when you click the icon.

## The manifest

```json
{
  "id": "hello",
  "name": "Hello",
  "title": "Hello extension",
  "icon": "mods/hello-extension/icon.svg",
  "view": { "mod": "hello-extension", "props": { "greeting": "Hi" } },
  "badge": "hello.count"
}
```

| Key | Required | Meaning |
|---|---|---|
| `id` | yes | Letters, digits, `-` and `_` (up to 64). The view's id is `ext-<id>`. |
| `name` | no (`id`) | The side bar title and the name in the visibility menu. |
| `title` | no (`name`) | The icon's tooltip. |
| `icon` | no (`mods/<folder>/icon.svg`) | An svg path in the app home, drawn in the theme colour (use `stroke="currentColor"`). A plain name such as `"layers"` picks a vx-icons icon. |
| `view.mod` | no (`<folder>`) | The mod the side bar shows. |
| `view.props` | no (`{}`) | Its props (`props()` in that mod). |
| `badge` | no | A `shared()` key. A string or a number above 0 shows on the icon (`999+` at most). |

A broken manifest is skipped. vx-activity logs the reason with `console.log`. An id that is
already in use is skipped too.

## What vx-activity does with it

- **Discovery.** It lists `mods/*/vx-extension.json` when it starts, when the mods folder changes
  (`watchFolder`), and every 30 s. The list is published in `shared("vx.extensions")`, so the
  side bar title and the visibility menu see it too.
- **Showing the view.** The first time you click the icon, vx-activity adds a child
  `{ id: "ext-<id>", type: "block", content: { mod, props } }` to the `sidebar-views` stack of the
  shown layout (`layout.set`). Then it selects that child. When the manifest's `view` changes,
  the child's content is brought up to date on the next click.
- **Order and visibility.** Extension icons can be dragged and hidden like the built-in ones
  (right-click the activity bar). The menu is sized to its real rows.
- **Keys.** `vx-activity.ext-<id>` shows the view. Bind it in `keys.json`, for example
  `"cmd-shift-u": "vx-activity.ext-updates"`.

## Example

`examples/hello-extension/` is a complete extension: `mod.json`, `main.js`, `icon.svg` and
`vx-extension.json`. Copy it into the app's mods folder to try it:

```sh
cp -R examples/hello-extension ~/.config/herdr-app/mods/
```

`mods/vx-updates` is a real extension that ships with this repo.
