// An Untitled-N buffer in a herdr-vscode-files tab (props.untitled = { name, folder }): an empty editor
// whose ⌘S asks where to save (SaveAsDialog), writes the file, and turns the tab into that file.
import { openOverlay, shared, setShared, spaces, panes, run, exec, readTextFile, writeTextFile } from "herdr";
import { SAVE_AS_KEY, untitledDirtyKey } from "./untitled-core.js";
import { toast } from "./log.js";

const MOD = "herdr-vscode-files";
const KEPT_KEY = "herdr-vscode.tabs.kept";
const ANSWER_POLL_MS = 400;
const POLL_MS = 2000;
const DIALOG_WIDTH = 540;
const DIALOG_HEIGHT = 190;
const SAVED_TOAST_MS = 1500;
const ERROR_TOAST_MS = 8000;

// The tab of this buffer: Untitled names are unique in a window.
function tabNamed(name) {
  const modTabs = new Set(panes().filter((pane) => pane.mod === MOD).map((pane) => pane.tab));
  return spaces().flatMap((space) => space.tabs).find((tab) => tab.name === name && modTabs.has(tab.id))?.id ?? null;
}

export const untitledMethods = {
  initUntitled(spec, cx) {
    this.untitled = spec;
    this.file = { root: spec.folder, rel: spec.name, untitled: true };
    this.fileKey = `untitled|${spec.name}`;
    this.text = "";
    this.lines = [""];
    this.hunks = [];
    this.fixed = true;
    this.startEdit(cx);
    cx.timer.every(ANSWER_POLL_MS, (cx) => this.takeSaveAsAnswer(cx));
  },

  untitledDirtyKey() {
    return this.untitled ? untitledDirtyKey(this.untitled.name) : null;
  },

  openSaveAs() {
    const spec = { token: this.untitled.name, folder: this.untitled.folder, suggested: this.untitled.name };
    openOverlay({ mod: MOD, kind: "dialog", width: DIALOG_WIDTH, height: DIALOG_HEIGHT, props: { saveAs: spec } });
  },

  takeSaveAsAnswer(cx) {
    const answer = shared(SAVE_AS_KEY);
    if (!this.untitled || answer?.token !== this.untitled.name || answer.at === this.saveAsAt) {
      return;
    }
    this.saveAsAt = answer.at;
    cx.spawn(async (cx) => {
      await this.writeUntitled(answer.path, cx);
      cx.notify();
    });
  },

  // Never overwrites: an existing file is refused, so nothing on disk is lost.
  async writeUntitled(path, cx) {
    const text = this.editor?.value() ?? "";
    const cut = path.lastIndexOf("/");
    const dir = path.slice(0, cut) || "/";
    const rel = path.slice(cut + 1);
    try {
      if ((await readTextFile(path).catch(() => null)) !== null) {
        throw new Error(`${path} already exists. Save under another name.`);
      }
      await exec("mkdir", ["-p", dir]);
      await writeTextFile(path, text, null);
    } catch (error) {
      toast("herdr-vscode-files", { title: "Not saved", body: String(error?.message ?? error), level: "error", timeout: ERROR_TOAST_MS });
      return;
    }
    this.becomeFile(dir, rel, text, cx);
    toast("herdr-vscode-files", { title: `Saved ${rel}`, body: path, level: "success", timeout: SAVED_TOAST_MS });
  },

  becomeFile(dir, rel, text, cx) {
    this.setDirty(false);
    const tab = tabNamed(this.untitled.name);
    const value = { root: dir, on: null, rel };
    if (tab) {
      setShared(KEPT_KEY, { ...(shared(KEPT_KEY) ?? {}), [tab]: { mod: MOD, value } });
      run("tab.rename", { id: tab, name: rel });
    }
    this.untitled = null;
    this.myTab = tab;
    this.propsFile = value;
    this.file = value;
    this.fileKey = `|${dir}/${rel}`;
    this.applyText(value, text, cx);
    this.editor?.release();
    this.editor = null;
    this.startEdit(cx);
    cx.timer.every(POLL_MS, (cx) => this.syncPreview(cx, true));
  },
};
