---
name: herdr-vscode-demo
description: Record the herdr-vscode README demo GIFs again, reproducibly, from fake git repos in a separate Herdr window, then check them. Use when the UI changed and the GIFs in docs/media/ are out of date, or a new feature needs a GIF. Triggers: "record the demo gifs", "update the readme gifs", "herdr-vscode-demo".
---

# herdr-vscode demo GIFs

`scripts/record.sh` makes every GIF in `docs/media/` (and a PNG of its first frame). It uses no real
data and leaves the person's window as it was.

## What the script does

1. Makes a temp folder `/tmp/hvd.XXXXXX` (short: the app's control socket lives there).
2. Makes an app home in it (`HERDR_APP_HOME`), marks the welcome tour as seen, and installs the mods,
   the `herdr-vscode` layout and the theme with `sync.sh`.
3. Makes two fake repos (`scripts/fake-repos.sh`): `acme-web` and `acme-api`, with commits by
   "Demo Dev", a merged branch, a tag, and uncommitted changes.
4. Opens a second Herdr window on that home and switches it to `herdr-vscode`.
5. Opens one space per repo. Each runs `/bin/sh` with an empty environment and the prompt `$ `, so
   no personal prompt, path or host shows.
6. For each scene, runs `herdr-app do <command>` steps and takes a `herdr-app shot` after each.
7. Joins the frames into `docs/media/<scene>.gif` with ffmpeg (palette, 960 px wide, 1.2 s per
   frame). Without ffmpeg it uses ImageMagick.
8. Closes the demo spaces, quits the demo window, and moves the temp folder to the Trash.

Spaces live in herdr-core, which both windows share: while the script runs, the demo spaces show in
the person's window too. They show in its Recent list afterwards.

## Run it

```sh
skills/herdr-vscode-demo/scripts/record.sh               # every scene
skills/herdr-vscode-demo/scripts/record.sh hero scm      # only these
```

Scenes: `hero`, `explorer`, `scm`, `quickopen`, `running`. To add one, add a `case` branch in
`record.sh` and reference `docs/media/<scene>.gif` in the README.

## Check the result

1. Read each `docs/media/<scene>.png` (the first frame). It must show the herdr-vscode layout with
   the fake repos, and no welcome dialog, personal path, host name or real repo.
2. Run `herdr-app status` in the person's window: `errors` must be `[]`, and no `acme-*` space may
   remain in `herdr-app ls`.

## Known limits

- A toast such as "Updated to <version>" can show in the first frames of a new app home.
- The CI view needs a real remote and network, so no scene shows it.
