// The web page of a repo's origin, with an SSH alias (Host in ~/.ssh/config) resolved the way
// vx-changes does. The rules are in git-core.js (parseRemote) and scm-core.js (repoWebUrl).
import { exec } from "herdr";
import { git } from "./ws.js";
import { parseRemote, providerOf } from "./git-core.js";
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

// The current branch, or the commit when detached.
async function currentRef(path, on) {
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: path, on }).catch(() => null);
  const name = branch?.code === 0 ? branch.stdout.trim() : "";
  if (name && name !== "HEAD") {
    return name;
  }
  const sha = await git(["rev-parse", "HEAD"], { cwd: path, on }).catch(() => null);
  return sha?.code === 0 ? sha.stdout.trim() : null;
}

// The GitHub / GitLab page of the file or folder at `path` (lines = { start, end? }), else null.
export async function fileWebLink(path, { dir = false, lines = null, on = null } = {}) {
  const cwd = dir ? path : path.replace(/\/[^/]*$/, "");
  const top = await git(["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
  const root = top?.code === 0 ? top.stdout.trim() : null;
  const remote = root ? await originOf(root, on) : null;
  if (!remote || !path.startsWith(`${root}/`)) {
    return null;
  }
  return fileWebUrl(remote, await currentRef(root, on), path.slice(root.length + 1), lines);
}
