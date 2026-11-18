import { cliJson } from "./ci-cli.js";
import { ghRun, ghJob } from "./ci-core.js";

export class GitHub {
  static CLI = "gh";
  static PUBLIC_HOST = "github.com";
  static DEFAULT_PAGE_SIZE = 30;
  static LIST_PAGE_SIZE = 100;
  static ARTIFACT_TIMEOUT_MS = 300000;

  static async open(host, path) {
    const repo = await cliJson(GitHub.CLI, ["api", ...GitHub.hostArgs(host), `repos/${path}`]);
    return new GitHub(host, repo);
  }

  static hostArgs(host) {
    return host === GitHub.PUBLIC_HOST ? [] : ["--hostname", host];
  }

  constructor(host, repo) {
    this.provider = "github";
    this.name = "GitHub";
    this.host = host;
    this.path = repo.full_name;
    this.web = repo.html_url;
    this.defaultBranch = repo.default_branch;
  }

  api(endpoint) {
    return cliJson(GitHub.CLI, ["api", ...GitHub.hostArgs(this.host), `repos/${this.path}/${endpoint}`]);
  }

  postArgs(endpoint) {
    return ["api", ...GitHub.hostArgs(this.host), "-X", "POST", `repos/${this.path}/${endpoint}`];
  }

  repoArg() {
    return ["-R", this.host === GitHub.PUBLIC_HOST ? this.path : `${this.host}/${this.path}`];
  }

  async runs({ ref, per = GitHub.DEFAULT_PAGE_SIZE } = {}) {
    const query = new URLSearchParams({ per_page: String(per), ...(ref ? { branch: ref } : {}) });
    return ((await this.api(`actions/runs?${query}`)).workflow_runs ?? []).map(ghRun);
  }

  async run(id) {
    return ghRun(await this.api(`actions/runs/${id}`));
  }

  async jobs(id) {
    const [jobs, artifacts] = await Promise.all([
      this.api(`actions/runs/${id}/jobs?per_page=${GitHub.LIST_PAGE_SIZE}`),
      this.api(`actions/runs/${id}/artifacts?per_page=${GitHub.LIST_PAGE_SIZE}`).catch(() => ({ artifacts: [] })),
    ]);
    this.artifacts = (artifacts.artifacts ?? [])
      .filter((artifact) => !artifact.expired)
      .map((artifact) => ({ name: artifact.name, size: artifact.size_in_bytes }));
    return (jobs.jobs ?? []).map(ghJob);
  }

  async workflows() {
    const response = await this.api(`actions/workflows?per_page=${GitHub.LIST_PAGE_SIZE}`);
    return (response.workflows ?? []).filter((workflow) => workflow.state === "active");
  }

  retrySpec(run) {
    return { cmd: GitHub.CLI, args: this.postArgs(`actions/runs/${run.id}/rerun`), doing: "Re-running", done: `Re-ran run #${run.number}` };
  }

  cancelSpec(run) {
    return { cmd: GitHub.CLI, args: this.postArgs(`actions/runs/${run.id}/cancel`), doing: "Cancelling", done: `Cancelled run #${run.number}` };
  }

  startSpec({ ref, workflow, variables }) {
    const inputs = variables.filter((variable) => variable.key).flatMap((variable) => ["-f", `${variable.key}=${variable.value}`]);
    return { cmd: GitHub.CLI, args: ["workflow", "run", String(workflow), "--ref", ref, ...inputs, ...this.repoArg()], doing: "Dispatching", done: `Dispatched on ${ref}` };
  }

  artifactSpec(run, artifact, dir) {
    return { cmd: GitHub.CLI, args: ["run", "download", String(run.id), "-n", artifact.name, "-D", dir, ...this.repoArg()], doing: "Downloading", done: `Saved to ${dir}`, timeout: GitHub.ARTIFACT_TIMEOUT_MS };
  }
}
