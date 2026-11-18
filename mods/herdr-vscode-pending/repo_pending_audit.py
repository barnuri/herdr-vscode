#!/usr/bin/env python3
"""Report every git repo under a root folder (default ~/code) that has uncommitted files or unpushed commits.

Run it from the agent's shell tool:  python3 -I <skill-dir>/scripts/repo_pending_audit.py [--root DIR] [--color] [--json]

One line per repo, in the same format as the user's minimal-git zsh prompt:

    private/orch-skill master ↑8 ?27 ±78

- The folder path is relative to the root, so the parent folder shows first.
- Only the checked-out branch counts, from `git status --porcelain=v2 --branch`:
  ↑ ahead, + new (staged add), ? untracked, ± modified, - deleted, ! conflicted. Commits to pull
  (behind) are not shown: they are not local work at risk.
  "no upstream" means the checked-out branch has commits no remote has and no upstream.
  Other local branches are not checked. A repo with no remote is listed only when it has
  uncommitted files.

Read-only: the script never fetches and never changes a repo.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

SKIP_DIRS = {"node_modules", ".venv", "venv", "__pycache__", "dist", "build", "target", ".next", ".cache", "agent-spec"}
MAX_DEPTH = 4

CYAN, RED, GREEN, YELLOW, MAGENTA, RESET = "\033[36m", "\033[31m", "\033[32m", "\033[33m", "\033[35m", "\033[0m"


GIT_ENV = {**os.environ, "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0"}


def git(repo: str, *args: str) -> subprocess.CompletedProcess:
    # --no-optional-locks: `git status` skips the index refresh write, so it takes no index.lock
    # and never blocks (or is blocked by) another git command running in the same repo.
    return subprocess.run(["git", "--no-optional-locks", "-C", repo, *args], capture_output=True, text=True, env=GIT_ENV)


def find_repos(root: str) -> list[str]:
    repos = []
    for dirpath, dirnames, filenames in os.walk(root):
        if ".git" in dirnames or ".git" in filenames:
            repos.append(dirpath)
            dirnames[:] = []
            continue
        if dirpath.count(os.sep) - root.count(os.sep) >= MAX_DEPTH:
            dirnames[:] = []
            continue
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in SKIP_DIRS]
    return sorted(repos)


def head_status(repo: str) -> dict | None:
    """Mirror _git_status in ~/.oh-my-zsh/custom/themes/minimal-git.zsh-theme. None: not a repo."""
    proc = git(repo, "status", "--porcelain=v2", "--branch")
    if proc.returncode != 0:
        return None
    s = {"branch": "", "upstream": False, "behind": 0, "ahead": 0, "new": 0, "untracked": 0,
         "modify": 0, "deleted": 0, "merges": 0}
    for line in proc.stdout.splitlines():
        if line.startswith("# branch.head "):
            branch = line[len("# branch.head "):]
            s["branch"] = "" if branch == "(detached)" else branch
        elif line.startswith("# branch.upstream "):
            s["upstream"] = True
        elif line.startswith("# branch.ab "):
            ahead, behind = line[len("# branch.ab "):].split()
            s["ahead"], s["behind"] = int(ahead.lstrip("+")), int(behind.lstrip("-"))
        elif line.startswith("? "):
            s["untracked"] += 1
        elif line.startswith("u "):
            s["merges"] += 1
        elif line[:2] in ("1 ", "2 "):
            x, y = line[2], line[3]
            s["new"] += x == "A"
            s["modify"] += x in "MTRC" or y in "MTRC"
            s["deleted"] += "D" in (x, y)
    return s


def audit(repo: str) -> dict | None:
    s = head_status(repo)
    if s is None:
        return None
    has_remote = bool(git(repo, "remote").stdout.strip())
    never_pushed = bool(has_remote and s["branch"] and not s["upstream"]
                        and git(repo, "rev-list", "-n1", "HEAD", "--not", "--remotes").stdout.strip())
    dirty = any(s[k] for k in ("new", "untracked", "modify", "deleted", "merges"))
    if not (dirty or s["ahead"] or never_pushed):
        return None
    return {"repo": repo, "has_remote": has_remote, "status": s, "head_never_pushed": never_pushed}


def line_for(r: dict, root: str, color: bool) -> str:
    def c(code: str, text: str) -> str:
        return f"{code}{text}{RESET}" if color else text

    s = r["status"]
    parts = [c(GREEN, os.path.relpath(r["repo"], root)), c(CYAN, s["branch"]) if s["branch"] else c(RED, "no branch")]
    markers = [("ahead", CYAN, "↑"), ("new", GREEN, "+"), ("untracked", YELLOW, "?"),
               ("modify", CYAN, "±"), ("deleted", RED, "-"), ("merges", MAGENTA, "!")]
    parts += [c(code, f"{sym}{s[key]}") for key, code, sym in markers if s[key]]
    if r["head_never_pushed"]:
        parts.append(c(RED, "no upstream"))
    return " ".join(parts)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", default="~/code")
    parser.add_argument("--color", action="store_true", help="color the output like the zsh prompt")
    parser.add_argument("--json", action="store_true", help="print JSON instead of text")
    args = parser.parse_args()

    root = os.path.expanduser(args.root)
    repos = find_repos(root)
    with ThreadPoolExecutor(max_workers=min(64, len(repos) or 1)) as pool:
        results = [r for r in pool.map(audit, repos) if r]

    if args.json:
        json.dump({"root": root, "scanned": len(repos), "pending": results}, sys.stdout, indent=2)
        print()
        return 0
    print(f"{len(results)} of {len(repos)} repos under {args.root} have pending work.")
    for r in results:
        print(line_for(r, root, args.color))
    return 0


if __name__ == "__main__":
    sys.exit(main())
