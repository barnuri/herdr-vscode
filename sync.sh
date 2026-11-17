#!/bin/sh
# Installs the vx mods into the Herdr app, which hot-reloads them.
#
#   ./sync.sh              every mod in mods/
#   ./sync.sh vx-status    just these
#
# Each mod is put together in a hidden staging folder (Herdr doesn't watch hidden folders) with
# its mod.json and a copy of shared/ (a mod can only import files from its own folder), checked
# with `herdr-app check`, then swapped in with one rename. So Herdr never sees a half-copied mod
# (a folder seen without its mod.json gets docked into the layout), and an unchanged mod is not
# touched at all (every reload keeps the old build's code for the app's life).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
home_dir=${HERDR_APP_HOME:-"$HOME/.config/herdr-app"}
stage="$home_dir/mods/.vx-stage"
[ -d "$home_dir/mods" ] || { echo "no Herdr app home at $home_dir" >&2; exit 1; }

node "$here/tools/build.mjs"
if [ $# -gt 0 ]; then names="$*"; else names=$(cd "$here/mods" && ls -d vx-* | tr '\n' ' '); fi
rm -rf "$stage" && mkdir -p "$stage"
trap 'rm -rf "$stage"' EXIT
status=0
for name in $names; do
  src="$here/mods/$name"
  [ -f "$src/mod.json" ] || { echo "skip   $name (no mod.json)"; continue; }
  dst="$stage/$name"
  mkdir -p "$dst"
  cp "$src/mod.json" "$dst/mod.json"
  # Settings saved in the app (a mod's settings dialog writes its installed mod.json) win
  # over the source's, so a sync never resets them.
  if [ -f "$home_dir/mods/$name/mod.json" ]; then
    node -e '
      const fs = require("fs");
      const [src, inst] = process.argv.slice(1).map((p) => JSON.parse(fs.readFileSync(p, "utf8")));
      if (inst.settings && Object.keys(inst.settings).length) {
        src.settings = { ...(src.settings ?? {}), ...inst.settings };
        fs.writeFileSync(process.argv[1], JSON.stringify(src, null, 2) + "\n");
      }' "$dst/mod.json" "$home_dir/mods/$name/mod.json" || true
  fi
  (cd "$src" && tar cf - --exclude mod.json --exclude jsconfig.json --exclude '*.d.ts' --exclude .DS_Store .) | (cd "$dst" && tar xf -)
  if ! herdr-app check "$dst" >/dev/null 2>"$stage/$name.err"; then
    echo "FAIL   $name: herdr-app check"; sed 's/^/       /' "$stage/$name.err" | tail -20; status=1; continue
  fi
  target="$home_dir/mods/$name"
  if [ -d "$target" ] && diff -rq -x jsconfig.json -x '*.d.ts' -x '.*' -x cache "$dst" "$target" >/dev/null 2>&1; then
    echo "same   $name"; continue
  fi
  if [ -d "$target" ]; then mv "$target" "$stage/.old-$name"; fi
  mv "$dst" "$target"
  echo "synced $name"
done
exit $status
