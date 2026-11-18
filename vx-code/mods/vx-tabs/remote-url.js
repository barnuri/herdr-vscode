// The web page of a repo's origin, with an SSH alias (Host in ~/.ssh/config) resolved the way
// vx-changes does. The rules are in git-core.js (parseRemote) and scm-core.js (repoWebUrl).
import { exec } from "herdr";
import { git } from "./ws.js";
import { parseRemote, providerOf } from "./git-core.js";
import { repoWebUrl, sshHostname } from "./scm-core.js";

export async function repoWebPage(path, on = null) {
  const result = await git(["remote", "get-url", "origin"], { cwd: path, on }).catch(() => null);
  const remote = result?.code === 0 ? parseRemote(result.stdout.trim()) : null;
  if (remote && !providerOf(remote.host) && !on) {
    const ssh = await exec("ssh", ["-G", remote.host]).catch(() => null);
    remote.host = sshHostname(ssh?.stdout) ?? remote.host;
  }
  return repoWebUrl(remote);
}
