#!/bin/sh
# Installs the herdr-vscode mods into the Herdr app, which hot-reloads them.
#
#   ./sync.sh                     every mod in mods/, the themes, and our layouts you have
#   ./sync.sh herdr-vscode-status           just these mods (themes and layouts too)
#   ./sync.sh --layout herdr-vscode    also add that layout (layouts/herdr-vscode.json + .svg)
#
# An install from before the rename (mods/vx-*, layouts/vx-code) is migrated: the new layout is
# installed with the old one's clicks and keys, shown if the old one was, and then the old mods
# and layout go to the Trash.
#
# Themes (themes/*.json) are copied when they differ. A layout is copied when it's new (asked
# for with --layout) or when the repo's file changed since the last sync: Herdr keeps clicks
# (sizes, hidden) apart, but herdr-vscode-panel edits the installed layout itself (layout.set), so an
# unchanged source never overwrites it.
#
# Each mod is put together in a hidden staging folder (Herdr doesn't watch hidden folders) with
# its mod.json and a copy of shared/ (a mod can only import files from its own folder), checked
# with `herdr-app check`, then swapped in with one rename. So Herdr never sees a half-copied mod
# (a folder seen without its mod.json gets docked into the layout), and an unchanged mod is not
# touched at all (every reload keeps the old build's code for the app's life).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
home_dir=${HERDR_APP_HOME:-"$HOME/.config/herdr-app"}
stage="$home_dir/mods/.herdr-vscode-stage"
[ -d "$home_dir/mods" ] || { echo "no Herdr app home at $home_dir" >&2; exit 1; }

add_layouts=""
names=""
old_layout=vx-code
new_layout=herdr-vscode
migrate=0
if [ -f "$home_dir/layouts/$old_layout.json" ] && [ ! -f "$home_dir/layouts/$new_layout.json" ]; then
  migrate=1
  add_layouts=" $new_layout"
  # Clicks (sizes, hidden) are kept per layout name: start the new layout with the old one's.
  if [ -f "$home_dir/layouts/.state/$old_layout.json" ] && [ ! -f "$home_dir/layouts/.state/$new_layout.json" ]; then
    cp "$home_dir/layouts/.state/$old_layout.json" "$home_dir/layouts/.state/$new_layout.json"
  fi
fi
while [ $# -gt 0 ]; do
  case "$1" in
    --layout) add_layouts="$add_layouts $2"; shift 2 ;;
    *) names="$names $1"; shift ;;
  esac
done
node "$here/tools/build.mjs"
[ -n "$names" ] || names=$(cd "$here/mods" && ls -d herdr-vscode-* | tr '\n' ' ')
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

# Themes: copy when different (atomic: temp file, then rename).
mkdir -p "$home_dir/themes"
for f in "$here"/themes/*.json; do
  [ -f "$f" ] || continue
  n=$(basename "$f")
  if cmp -s "$f" "$home_dir/themes/$n"; then echo "same   theme $n"; continue; fi
  cp "$f" "$home_dir/themes/.$n.tmp" && mv "$home_dir/themes/.$n.tmp" "$home_dir/themes/$n" && echo "synced theme $n"
done

# Layouts: ours that are installed (or asked for), when the source changed since last sync.
seen="$home_dir/layouts/.herdr-vscode-synced"
mkdir -p "$seen"
for f in "$here"/layouts/*.json; do
  n=$(basename "$f" .json)
  installed="$home_dir/layouts/$n.json"
  asked=0
  for a in $add_layouts; do [ "$a" = "$n" ] && asked=1; done
  if [ ! -f "$installed" ] && [ $asked = 0 ]; then continue; fi
  if [ -f "$installed" ] && [ $asked = 0 ] && cmp -s "$f" "$seen/$n.json"; then echo "same   layout $n"; continue; fi
  [ -f "$here/layouts/$n.svg" ] && cp "$here/layouts/$n.svg" "$home_dir/layouts/$n.svg"
  cp "$f" "$home_dir/layouts/.$n.json.tmp" && mv "$home_dir/layouts/.$n.json.tmp" "$installed" && cp "$f" "$seen/$n.json"
  echo "synced layout $n"
done

if [ $migrate = 1 ] && [ $status = 0 ]; then
  # keys.json: the old layout's section becomes the new one's, its vx-* commands renamed.
  HOME_DIR="$home_dir" node -e '
    const fs = require("fs");
    const file = `${process.env.HOME_DIR}/keys.json`;
    let keys;
    try { keys = JSON.parse(fs.readFileSync(file, "utf8")); } catch { process.exit(0); }
    const old = keys["layout:vx-code"];
    if (!old || keys["layout:herdr-vscode"]) process.exit(0);
    const renamed = Object.fromEntries(Object.entries(old).map(([key, command]) => [key, String(command).replace(/^vx-/, "herdr-vscode-")]));
    keys["layout:herdr-vscode"] = renamed;
    delete keys["layout:vx-code"];
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(keys, null, 2) + "\n");
    fs.renameSync(`${file}.tmp`, file);'
  node "$here/tools/add-keys.mjs" "$new_layout" >/dev/null
  shown=$(herdr-app status 2>/dev/null | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).layout??"")}catch{}})' || true)
  if [ "$shown" = "$old_layout" ]; then
    herdr-app do layout.switch --name "$new_layout" >/dev/null && echo "shown  layout $new_layout"
  fi
  # An open empty editor ("Welcome" tab without terminals) runs the old mod: replace it first.
  herdr-app ls 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        for (const space of JSON.parse(s).spaces ?? []) {
          for (const tab of space.tabs ?? []) {
            if (tab.name === "Welcome" && !(tab.terminals ?? []).length) console.log(`${space.id} ${tab.id}`);
          }
        }
      } catch {}
    });' | while read -r space tab; do
    herdr-app do tab.new "{\"space\":\"$space\",\"name\":\"Welcome\",\"mod\":\"herdr-vscode-empty\"}" >/dev/null &&
      herdr-app do tab.close "{\"id\":\"$tab\",\"confirmed\":true}" >/dev/null && echo "moved  empty editor $tab"
  done
  for old in "$home_dir"/mods/vx-* "$home_dir/layouts/$old_layout.json" "$home_dir/layouts/$old_layout.svg" \
             "$home_dir/layouts/.state/$old_layout.json" "$home_dir/layouts/.vx-synced"; do
    [ -e "$old" ] || continue
    trash "$old" && echo "trash  ${old#"$home_dir"/}"
  done
fi
exit $status
