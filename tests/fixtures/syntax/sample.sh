#!/usr/bin/env zsh
# Deploy script
set -euo pipefail

NAME="${1:-world}"
export PATH="$HOME/bin:$PATH"
if [[ -n "$NAME" ]]; then
  echo "hello $NAME" | grep -q hello && echo ok
fi
for f in *.txt; do
  cat "$f" > /dev/null 2>&1
done
local count=$(ls | wc -l)
