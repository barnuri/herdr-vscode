// A change never runs on one click: the mod reopens itself as a dialog with props { confirm: spec }
// and runs the action from there, since closing a copy first could drop the exec in flight.
import { openOverlay, closeOverlay, exec, notify, props } from "herdr";
import { bump } from "./ws.js";

const DIALOG_WIDTH = 440;
const DIALOG_HEIGHT = 150;
const DIALOG_DETAIL_HEIGHT = 196;
const STEP_ROW_HEIGHT = 26;
const ACTION_TIMEOUT_MS = 120000;
const SUCCESS_TOAST_MS = 3000;
const ERROR_TOAST_MS = 8000;
const ERROR_TAIL_CHARS = 600;

export function askConfirm(mod, spec) {
  const extraSteps = Math.max(0, (spec.action.steps?.length ?? 1) - 1);
  const height = (spec.detail ? DIALOG_DETAIL_HEIGHT : DIALOG_HEIGHT) + extraSteps * STEP_ROW_HEIGHT;
  openOverlay({ mod, kind: "dialog", width: DIALOG_WIDTH, height, props: { confirm: spec } });
}

function runStep(action, step) {
  return exec(step.cmd, step.args, { cwd: step.cwd ?? action.cwd, on: action.on ?? null, timeout: action.timeout ?? ACTION_TIMEOUT_MS })
    .catch((error) => ({ code: -1, stdout: "", stderr: String(error?.message ?? error) }));
}

function notifyResult(action, result) {
  const text = (result.stderr || result.stdout || "").trim();
  if (result.code === 0) {
    notify({ title: action.done ?? "Done", body: text.split("\n").pop() || undefined, level: "success", timeout: SUCCESS_TOAST_MS });
    return;
  }
  notify({ title: `${action.doing ?? "It"} failed`, body: text.slice(-ERROR_TAIL_CHARS) || `exit ${result.code}`, level: "error", timeout: ERROR_TOAST_MS });
}

export async function runAction(action) {
  let result = null;
  for (const step of action.steps ?? [action]) {
    result = await runStep(action, step);
    if (result.code !== 0) {
      break;
    }
  }
  notifyResult(action, result);
  if (action.root !== undefined) {
    bump(action.root);
  }
  return result;
}

export const confirmMethods = {
  isConfirm() {
    return Boolean(this.confirmSpec);
  },
  async confirmYes(cx) {
    if (this.confirmBusy) {
      return;
    }
    this.confirmBusy = true;
    cx.notify();
    try {
      await runAction(this.confirmSpec.action);
    } finally {
      closeOverlay(props()?.overlay ?? this.confirmOverlay);
    }
  },
  confirmNo() {
    closeOverlay(props()?.overlay ?? this.confirmOverlay);
  },
};
