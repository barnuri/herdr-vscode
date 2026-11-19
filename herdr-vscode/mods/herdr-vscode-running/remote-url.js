// The web page of a repo's origin, with an SSH alias (Host in ~/.ssh/config) resolved the way
// herdr-vscode-changes does. The rules are in git-core.js (parseRemote) and scm-core.js (repoWebUrl).
import { exec } from "herdr";
import { git } from "./ws.js";
import { parseRemote, providerOf, defaultBranchOf } from "./git-core.js";
import { repoWebUrl, sshHostname } from "./scm-core.js";
import { fileWebUrl } from "./fileops-core.js";

async function originOf(path, on) {
  const result = await git(["remote", "get-url", "origin"], { cwd: path, on }).catch(() => null);
  const remote = result?.code === 0 ? parseRemote(result.stdout.trim()) : null;
  if (remote && !providerOf(remote.host) && !on) {
    const ssh = await exec("ssh", ["-G", remote.host]).catch(() => null);
    remote.host = sshHostname(ssh?.stdout) ?? remote.host;
  }
  return remote;
}

export async function repoWebPage(path, on = null) {
  return repoWebUrl(await originOf(path, on));
}

// The current branch ({ ref, branch: true }), or the commit when detached ({ ref, branch: false }).
async function currentRef(path, on) {
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: path, on }).catch(() => null);
  const name = branch?.code === 0 ? branch.stdout.trim() : "";
  if (name && name !== "HEAD") {
    return { ref: name, branch: true };
  }
  const sha = await git(["rev-parse", "HEAD"], { cwd: path, on }).catch(() => null);
  return { ref: sha?.code === 0 ? sha.stdout.trim() : null, branch: false };
}

// origin's default branch (origin/HEAD), else null.
async function defaultBranch(path, on) {
  const head = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: path, on }).catch(() => null);
  return head?.code === 0 ? defaultBranchOf(head.stdout) : null;
}

// The GitHub / GitLab pages of the file or folder at `path` (lines = { start, end? }) as
// [{ ref, url }]: the current branch's, and first the default branch's when on another branch.
// Empty when there is no such page.
export async function fileWebLinks(path, { dir = false, lines = null, on = null } = {}) {
  const cwd = dir ? path : path.replace(/\/[^/]*$/, "");
  const top = await git(["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
  const root = top?.code === 0 ? top.stdout.trim() : null;
  const remote = root ? await originOf(root, on) : null;
  if (!remote || !path.startsWith(`${root}/`)) {
    return [];
  }
  const rel = path.slice(root.length + 1);
  const [current, base] = await Promise.all([currentRef(root, on), defaultBranch(root, on)]);
  const link = (ref) => ({ ref, url: fileWebUrl(remote, ref, rel, lines) });
  const links = current.branch && base && base !== current.ref ? [link(base), link(current.ref)] : [link(current.ref)];
  return links.filter((entry) => entry.url);
}
