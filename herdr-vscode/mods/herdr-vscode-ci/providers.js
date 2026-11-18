import { exec } from "herdr";
import { git } from "./ws.js";
import { parseRemote, providerOf } from "./git-core.js";
import { GitLab } from "./gitlab.js";
import { GitHub } from "./github.js";
import { logError } from "./log.js";

// Resolves an SSH alias (a Host entry in ~/.ssh/config) to the host it connects to.
async function realHost(alias) {
  const result = await exec("ssh", ["-G", alias]).catch(() => null);
  return /^hostname\s+(\S+)/m.exec(result?.stdout ?? "")?.[1] ?? null;
}

async function resolveProvider(host) {
  const provider = providerOf(host);
  if (provider) {
    return { host, provider };
  }
  const real = await realHost(host);
  if (!real) {
    return { host, provider: null };
  }
  return { host: real, provider: providerOf(real) };
}

export async function resolveProject(top, on) {
  const result = await git(["remote", "get-url", "origin"], { cwd: top, on }).catch(() => null);
  if (result?.code !== 0) {
    return { error: "This repo has no origin remote." };
  }
  const remote = parseRemote(result.stdout.trim());
  if (!remote) {
    return { error: `Can't read the origin URL: ${result.stdout.trim()}` };
  }
  const { host, provider } = await resolveProvider(remote.host);
  if (!provider) {
    return { error: `${remote.host} is neither GitLab nor GitHub.` };
  }
  const isGitLab = provider === "gitlab";
  try {
    return isGitLab ? await GitLab.open(host, remote.path) : await GitHub.open(host, remote.path);
  } catch (error) {
    logError("herdr-vscode-ci", "provider discovery failed", String(error?.message ?? error));
    return { error: `${isGitLab ? GitLab.CLI : GitHub.CLI}: ${error.message}`, provider };
  }
}
