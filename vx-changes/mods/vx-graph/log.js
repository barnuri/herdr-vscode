// Appends to ~/Library/Logs/herdr-vscode/vx.log, and errors also to vx-error.log, so a failed
// action leaves a trace after its toast is gone.
import { exec, home } from "herdr";

const LOG_DIR = "Library/Logs/herdr-vscode";
const LOG_FILE = "vx.log";
const ERROR_FILE = "vx-error.log";
const APPEND_SCRIPT = 'mkdir -p "$1" && printf "%s\\n" "$3" >> "$1/$2"';
const LOG_TIMEOUT_MS = 5000;

function append(file, line) {
  return exec("sh", ["-c", APPEND_SCRIPT, "vx-log", `${home()}/${LOG_DIR}`, file, line], { timeout: LOG_TIMEOUT_MS }).catch(() => null);
}

function format(level, mod, message, detail) {
  const extra = detail === undefined ? "" : ` ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
  return `${new Date().toISOString()} ${level} [${mod}] ${message}${extra}`;
}

export function logInfo(mod, message, detail) {
  return append(LOG_FILE, format("INFO", mod, message, detail));
}

export async function logError(mod, message, detail) {
  const line = format("ERROR", mod, message, detail);
  await append(LOG_FILE, line);
  return append(ERROR_FILE, line);
}
