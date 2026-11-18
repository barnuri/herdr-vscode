#!/bin/sh
# Records the README demo GIFs into docs/media/ from fake repos, in a second Herdr window with its
# own app home (HERDR_APP_HOME), so the person's window, layout and settings are not touched.
# Spaces live in herdr-core, which both windows share: the demo's spaces show up in the person's
# window while it runs, and are closed at the end.
#
#   skills/herdr-vscode-demo/scripts/record.sh [scene...]    scenes: hero explorer scm quickopen running
set -eu
repo=$(cd "$(dirname "$0")/../../.." && pwd)
# A short path: the app's control socket lives in the home and must fit in SUN_LEN.
work=$(mktemp -d /tmp/hvd.XXXXXX)
export HERDR_APP_HOME="$work/home"
out="$repo/docs/media"
frame_s=1.2
scenes=${*:-hero explorer scm quickopen running}
spaces=""

say() { echo "demo: $*"; }
do_() { herdr-app do "$@" >/dev/null; }

cleanup() {
  # Also any demo space whose id was not caught (its folder is under $work).
  spaces="$spaces $(herdr-app ls 2>/dev/null | WORK="$work" node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{try{for(const x of JSON.parse(s).spaces??[])if((x.folder??"").startsWith(process.env.WORK))console.log(x.id)}catch{}})' || true)"
  for id in $spaces; do herdr-app do space.close "{\"id\":\"$id\",\"confirmed\":true}" >/dev/null 2>&1 || true; done
  herdr-app do app.quit >/dev/null 2>&1 || true
  sleep 1
  trash "$work" 2>/dev/null || true
}
trap cleanup EXIT

# 1. An app home with only our mods, layout and theme; the welcome tour already seen.
mkdir -p "$HERDR_APP_HOME/mods" "$HERDR_APP_HOME/layouts" "$HERDR_APP_HOME/themes"
echo '{"frame.welcomed":"finished"}' > "$HERDR_APP_HOME/shared.json"
"$repo/sync.sh" --layout herdr-vscode >/dev/null

# 2. Fake repos: no real data.
"$(dirname "$0")/fake-repos.sh" "$work/code"

# 3. The demo window.
nohup herdr-app >"$work/app.log" 2>&1 &
i=0
until herdr-app status >/dev/null 2>&1; do i=$((i + 1)); [ $i -lt 240 ] || { say "window did not start"; tail -20 "$work/app.log"; exit 1; }; sleep 0.5; done
sleep 2
do_ layout.switch --name herdr-vscode

new_space() { # name folder
  id=$(herdr-app do space.new "{\"name\":\"$1\",\"folder\":\"$2\",\"argv\":[\"/usr/bin/env\",\"-i\",\"HOME=$2\",\"PS1=\$ \",\"TERM=xterm-256color\",\"/bin/sh\"]}" |
    node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>console.log(JSON.parse(s).space))')
  spaces="$spaces $id"
}
new_space acme-api "$work/code/acme-api"
new_space acme-web "$work/code/acme-web"
web=$id
do_ space.select --id "$web"
sleep 3

n=0
shot() { n=$((n + 1)); sleep "${1:-1}"; herdr-app shot "$work/frames/$(printf %03d $n).png" >/dev/null; }
scene_begin() { trash "$work/frames" 2>/dev/null || true; mkdir -p "$work/frames"; n=0; }
scene_end() { # name
  mkdir -p "$out"
  if command -v ffmpeg >/dev/null; then
    ffmpeg -loglevel error -y -framerate "1/$frame_s" -i "$work/frames/%03d.png" \
      -vf "scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=none" \
      -loop 0 "$out/$1.gif"
  else
    magick -delay "$(echo "$frame_s * 100" | bc | cut -d. -f1)" -loop 0 "$work/frames/"*.png -resize 960x "$out/$1.gif"
  fi
  ffmpeg -loglevel error -y -i "$work/frames/001.png" -vf "scale=960:-1" "$out/$1.png" 2>/dev/null || cp "$work/frames/001.png" "$out/$1.png"
  say "wrote $out/$1.gif"
}

for scene in $scenes; do
  scene_begin
  case $scene in
    hero)
      do_ herdr-vscode-activity.explorer; shot 2
      do_ herdr-vscode-activity.scm; shot
      do_ herdr-vscode-activity.history; shot
      do_ herdr-vscode-activity.running; shot
      do_ herdr-vscode-activity.explorer; shot ;;
    explorer)
      do_ herdr-vscode-activity.explorer; shot 2
      do_ herdr-vscode-activity.search; shot
      do_ herdr-vscode-activity.explorer; shot ;;
    scm)
      do_ herdr-vscode-activity.scm; shot 2
      do_ herdr-vscode-activity.history; shot
      do_ herdr-vscode-activity.scm; shot ;;
    quickopen)
      do_ herdr-vscode-titlebar.goto; shot 2
      do_ overlay.close; shot
      do_ herdr-vscode-tabs.switch; shot
      do_ overlay.close; shot ;;
    running)
      do_ herdr-vscode-activity.running; shot 2
      do_ herdr-vscode-activity.projects; shot
      do_ herdr-vscode-activity.panel; shot
      do_ herdr-vscode-activity.panel; shot ;;
    *) say "unknown scene $scene"; continue ;;
  esac
  scene_end "$scene"
done
