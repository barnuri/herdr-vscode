import { exec } from "herdr";

const CLI_TIMEOUT_MS = 30000;
const ERROR_TAIL_LINES = 3;

export async function cliJson(cmd, args) {
  const result = await exec(cmd, args, { timeout: CLI_TIMEOUT_MS });
  if (result.code !== 0) {
    const output = result.stderr || result.stdout || `${cmd} failed`;
    throw new Error(output.trim().split("\n").slice(-ERROR_TAIL_LINES).join(" "));
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${cmd} returned something that isn't JSON`);
  }
}
