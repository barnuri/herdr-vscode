#!/bin/sh
# Makes throwaway git repos with made-up files for the demo: fake-repos.sh <folder>
set -eu
root=$1
mkdir -p "$root"
g() { git -c user.name="Demo Dev" -c user.email=demo@example.com -c commit.gpgsign=false "$@"; }

make_repo() { # name
  dir="$root/$1"
  mkdir -p "$dir/src" "$dir/test"
  cd "$dir"
  git init -q -b main
  printf '# %s\n\nA made-up project for the herdr-vscode demo.\n' "$1" > README.md
  printf '{\n  "name": "%s",\n  "private": true,\n  "scripts": {\n    "dev": "node src/index.js",\n    "test": "node --test",\n    "lint": "echo lint ok"\n  }\n}\n' "$1" > package.json
  printf 'export function greet(name) {\n  return `Hello, ${name}!`;\n}\n' > src/greet.js
  printf 'import { greet } from "./greet.js";\n\nconsole.log(greet("world"));\n' > src/index.js
  g add -A && g commit -qm "Initial commit"
  printf 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { greet } from "../src/greet.js";\n\ntest("greet", () => assert.equal(greet("a"), "Hello, a!"));\n' > test/greet.test.js
  g add -A && g commit -qm "Add greet test"
  g checkout -qb feature/farewell
  printf '\nexport const farewell = (name) => `Bye, ${name}!`;\n' >> src/greet.js
  g commit -qam "Add farewell"
  g checkout -q main
  printf 'node_modules/\n' > .gitignore
  g add -A && g commit -qm "Ignore node_modules"
  g merge -q --no-ff -m "Merge feature/farewell" feature/farewell
  g tag v0.1.0
  # Uncommitted work so Source Control has something to show.
  printf '\nexport const shout = (name) => greet(name).toUpperCase();\n' >> src/greet.js
  printf -- '- [ ] write docs\n' > TODO.md
}

make_repo acme-web
make_repo acme-api
