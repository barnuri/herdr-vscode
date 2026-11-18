import { cliJson } from "./ci-cli.js";
import { glRun, glJob } from "./ci-core.js";

export class GitLab {
  static CLI = "glab";
  static PUBLIC_HOST = "gitlab.com";
  static DEFAULT_PAGE_SIZE = 30;
  static JOBS_PAGE_SIZE = 100;
  static ARTIFACT_TIMEOUT_MS = 300000;
  static PLAY = "play";

  static async open(host, path) {
    const project = await cliJson(GitLab.CLI, ["api", ...GitLab.hostArgs(host), `projects/${encodeURIComponent(path)}`]);
    return new GitLab(host, project);
  }

  static hostArgs(host) {
    return host === GitLab.PUBLIC_HOST ? [] : ["--hostname", host];
  }

  constructor(host, project) {
    this.provider = "gitlab";
    this.name = "GitLab";
    this.host = host;
    this.id = project.id;
    this.path = project.path_with_namespace;
    this.web = project.web_url;
    this.defaultBranch = project.default_branch;
  }

  api(endpoint) {
    return cliJson(GitLab.CLI, ["api", ...GitLab.hostArgs(this.host), `projects/${this.id}/${endpoint}`]);
  }

  postArgs(endpoint) {
    return ["api", ...GitLab.hostArgs(this.host), "-X", "POST", `projects/${this.id}/${endpoint}`];
  }

  repoArg() {
    return ["-R", this.host === GitLab.PUBLIC_HOST ? this.path : `${this.host}/${this.path}`];
  }

  async runs({ ref, per = GitLab.DEFAULT_PAGE_SIZE } = {}) {
    const query = new URLSearchParams({ per_page: String(per), ...(ref ? { ref } : {}) });
    return (await this.api(`pipelines?${query}`)).map(glRun);
  }

  async run(id) {
    return glRun(await this.api(`pipelines/${id}`));
  }

  async jobs(id) {
    const list = await this.api(`pipelines/${id}/jobs?per_page=${GitLab.JOBS_PAGE_SIZE}`);
    return list.map(glJob).reverse();
  }

  retrySpec(run) {
    return { cmd: GitLab.CLI, args: this.postArgs(`pipelines/${run.id}/retry`), doing: "Retrying", done: `Retried pipeline #${run.number}` };
  }

  cancelSpec(run) {
    return { cmd: GitLab.CLI, args: this.postArgs(`pipelines/${run.id}/cancel`), doing: "Cancelling", done: `Cancelled pipeline #${run.number}` };
  }

  jobSpec(job, verb) {
    const isPlay = verb === GitLab.PLAY;
    return { cmd: GitLab.CLI, args: this.postArgs(`jobs/${job.id}/${verb}`), doing: isPlay ? "Starting" : "Retrying", done: `${isPlay ? "Started" : "Retried"} ${job.name}` };
  }

  startSpec({ ref, variables }) {
    const vars = variables.filter((variable) => variable.key).flatMap((variable) => ["--variables", `${variable.key}:${variable.value}`]);
    return { cmd: GitLab.CLI, args: ["ci", "run", "-b", ref, ...vars, ...this.repoArg()], doing: "Starting pipeline", done: `Pipeline started on ${ref}` };
  }

  artifactSpec(run, job, dir) {
    return { cmd: GitLab.CLI, args: ["job", "artifact", run.ref, job.name, "-p", dir, ...this.repoArg()], doing: "Downloading", done: `Saved to ${dir}`, timeout: GitLab.ARTIFACT_TIMEOUT_MS };
  }
}
