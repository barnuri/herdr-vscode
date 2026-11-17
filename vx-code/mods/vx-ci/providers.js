// GitLab (glab) and GitHub (gh) behind one interface. Reads run here; anything that changes CI
// comes back as an action spec { cmd, args } for the confirm dialog (actions.js) to run.
// Only the active glab / gh login is used: no switching accounts behind your back.
import { exec } from "herdr";
import { git } from "./ws.js";
import { parseRemote, providerOf } from "./git-core.js";
import { glRun, glJob, ghRun, ghJob } from "./ci-core.js";

const TIMEOUT = 30000;

async function json(cmd, args) {
  const r = await exec(cmd, args, { timeout: TIMEOUT });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || `${cmd} failed`).trim().split("\n").slice(-3).join(" "));
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`${cmd} returned something that isn't JSON`);
  }
}

// An SSH alias (Host work-github in ~/.ssh/config) to the host it really connects to.
async function realHost(alias) {
  const r = await exec("ssh", ["-G", alias]).catch(() => null);
  return /^hostname\s+(\S+)/m.exec(r?.stdout ?? "")?.[1] ?? null;
}

// The CI project behind a repo's origin remote, or { error }.
export async function resolveProject(top, on) {
  const r = await git(["remote", "get-url", "origin"], { cwd: top, on }).catch(() => null);
  if (r?.code !== 0) return { error: "This repo has no origin remote." };
  const remote = parseRemote(r.stdout.trim());
  if (!remote) return { error: `Can't read the origin URL: ${r.stdout.trim()}` };
  let host = remote.host;
  let provider = providerOf(host);
  if (!provider) {
    const real = await realHost(host);
    if (real) {
      host = real;
      provider = providerOf(real);
    }
  }
  if (!provider) return { error: `${remote.host} is neither GitLab nor GitHub.` };
  try {
    return provider === "gitlab" ? await GitLab.open(host, remote.path) : await GitHub.open(host, remote.path);
  } catch (e) {
    const cli = provider === "gitlab" ? "glab" : "gh";
    return { error: `${cli}: ${e.message}`, provider };
  }
}

export class GitLab {
  static async open(host, path) {
    const p = await json("glab", ["api", ...GitLab.hostArgs(host), `projects/${encodeURIComponent(path)}`]);
    return new GitLab(host, p);
  }
  static hostArgs(host) {
    return host === "gitlab.com" ? [] : ["--hostname", host];
  }
  constructor(host, p) {
    this.provider = "gitlab";
    this.name = "GitLab";
    this.host = host;
    this.id = p.id;
    this.path = p.path_with_namespace;
    this.web = p.web_url;
    this.defaultBranch = p.default_branch;
  }
  api(endpoint) {
    return json("glab", ["api", ...GitLab.hostArgs(this.host), `projects/${this.id}/${endpoint}`]);
  }
  repoArg() {
    return ["-R", this.host === "gitlab.com" ? this.path : `${this.host}/${this.path}`];
  }
  async runs({ ref, per = 30 } = {}) {
    const q = new URLSearchParams({ per_page: String(per), ...(ref ? { ref } : {}) });
    return (await this.api(`pipelines?${q}`)).map(glRun);
  }
  async run(id) {
    return glRun(await this.api(`pipelines/${id}`));
  }
  async jobs(id) {
    const list = await this.api(`pipelines/${id}/jobs?per_page=100`);
    return list.map(glJob).reverse();
  }
  // Mutations, as specs for the confirm dialog.
  retrySpec(run) {
    return { cmd: "glab", args: ["api", ...GitLab.hostArgs(this.host), "-X", "POST", `projects/${this.id}/pipelines/${run.id}/retry`], doing: "Retrying", done: `Retried pipeline #${run.number}` };
  }
  cancelSpec(run) {
    return { cmd: "glab", args: ["api", ...GitLab.hostArgs(this.host), "-X", "POST", `projects/${this.id}/pipelines/${run.id}/cancel`], doing: "Cancelling", done: `Cancelled pipeline #${run.number}` };
  }
  jobSpec(job, verb) {
    return { cmd: "glab", args: ["api", ...GitLab.hostArgs(this.host), "-X", "POST", `projects/${this.id}/jobs/${job.id}/${verb}`], doing: verb === "play" ? "Starting" : "Retrying", done: `${verb === "play" ? "Started" : "Retried"} ${job.name}` };
  }
  startSpec({ ref, variables }) {
    const vars = variables.filter((v) => v.key).flatMap((v) => ["--variables", `${v.key}:${v.value}`]);
    return { cmd: "glab", args: ["ci", "run", "-b", ref, ...vars, ...this.repoArg()], doing: "Starting pipeline", done: `Pipeline started on ${ref}` };
  }
  artifactSpec(run, job, dir) {
    return { cmd: "glab", args: ["job", "artifact", run.ref, job.name, "-p", dir, ...this.repoArg()], doing: "Downloading", done: `Saved to ${dir}`, timeout: 300000 };
  }
}

export class GitHub {
  static async open(host, path) {
    const d = await json("gh", ["api", ...GitHub.hostArgs(host), `repos/${path}`]);
    return new GitHub(host, d);
  }
  static hostArgs(host) {
    return host === "github.com" ? [] : ["--hostname", host];
  }
  constructor(host, d) {
    this.provider = "github";
    this.name = "GitHub";
    this.host = host;
    this.path = d.full_name;
    this.web = d.html_url;
    this.defaultBranch = d.default_branch;
  }
  api(endpoint) {
    return json("gh", ["api", ...GitHub.hostArgs(this.host), `repos/${this.path}/${endpoint}`]);
  }
  repoArg() {
    return ["-R", this.host === "github.com" ? this.path : `${this.host}/${this.path}`];
  }
  async runs({ ref, per = 30 } = {}) {
    const q = new URLSearchParams({ per_page: String(per), ...(ref ? { branch: ref } : {}) });
    return ((await this.api(`actions/runs?${q}`)).workflow_runs ?? []).map(ghRun);
  }
  async run(id) {
    return ghRun(await this.api(`actions/runs/${id}`));
  }
  async jobs(id) {
    const [jobs, arts] = await Promise.all([
      this.api(`actions/runs/${id}/jobs?per_page=100`),
      this.api(`actions/runs/${id}/artifacts?per_page=100`).catch(() => ({ artifacts: [] })),
    ]);
    this.artifacts = (arts.artifacts ?? []).filter((a) => !a.expired).map((a) => ({ name: a.name, size: a.size_in_bytes }));
    return (jobs.jobs ?? []).map(ghJob);
  }
  async workflows() {
    return ((await this.api("actions/workflows?per_page=100")).workflows ?? []).filter((w) => w.state === "active");
  }
  retrySpec(run) {
    return { cmd: "gh", args: ["api", ...GitHub.hostArgs(this.host), "-X", "POST", `repos/${this.path}/actions/runs/${run.id}/rerun`], doing: "Re-running", done: `Re-ran run #${run.number}` };
  }
  cancelSpec(run) {
    return { cmd: "gh", args: ["api", ...GitHub.hostArgs(this.host), "-X", "POST", `repos/${this.path}/actions/runs/${run.id}/cancel`], doing: "Cancelling", done: `Cancelled run #${run.number}` };
  }
  startSpec({ ref, workflow, variables }) {
    const inputs = variables.filter((v) => v.key).flatMap((v) => ["-f", `${v.key}=${v.value}`]);
    return { cmd: "gh", args: ["workflow", "run", String(workflow), "--ref", ref, ...inputs, ...this.repoArg()], doing: "Dispatching", done: `Dispatched on ${ref}` };
  }
  artifactSpec(run, artifact, dir) {
    return { cmd: "gh", args: ["run", "download", String(run.id), "-n", artifact.name, "-D", dir, ...this.repoArg()], doing: "Downloading", done: `Saved to ${dir}`, timeout: 300000 };
  }
}
