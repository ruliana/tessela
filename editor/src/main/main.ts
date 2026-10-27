import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { BrowserWindow, app, dialog, ipcMain } from "electron";

import type { Hit, QueryArgs, VocabEntry } from "../shared/api";
import { journalPath, localDay } from "../shared/pages";
import { listPages, readPage, watchBundle, writePage } from "./files";
import { queryArgv, runJson, vocabArgv } from "./tessela";

let bundle: string | null = null;
let stopWatching: (() => void) | undefined;
let win: BrowserWindow | undefined;

function configFile(): string {
  return path.join(app.getPath("userData"), "config.json");
}

function bundleFromArgs(): string | null {
  const args = process.argv;
  const i = args.findIndex((a) => a === "--bundle" || a.startsWith("--bundle="));
  if (i < 0) return null;
  const arg = args[i] ?? "";
  const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[i + 1];
  return value ? path.resolve(value) : null;
}

function loadBundle(): string | null {
  const fromArgs = bundleFromArgs();
  if (fromArgs) return fromArgs;
  try {
    const saved = (JSON.parse(readFileSync(configFile(), "utf8")) as { bundle?: string }).bundle;
    return saved && existsSync(saved) ? saved : null;
  } catch {
    return null;
  }
}

/** The tessela binary: $TESSELA_BIN, a build next to the editor, or the one on PATH. */
function tesselaBin(): string {
  if (process.env.TESSELA_BIN) return process.env.TESSELA_BIN;
  for (const profile of ["release", "debug"]) {
    const built = path.resolve(app.getAppPath(), "..", "target", profile, "tessela");
    if (existsSync(built)) return built;
  }
  return "tessela";
}

function useBundle(dir: string | null): void {
  bundle = dir;
  stopWatching?.();
  stopWatching = undefined;
  if (dir) {
    try {
      writeFileSync(configFile(), JSON.stringify({ bundle: dir }));
    } catch {
      // Remembering the bundle is a convenience.
    }
    stopWatching = watchBundle(dir, (paths) => win?.webContents.send("changed", paths));
  }
}

function needBundle(): string {
  if (!bundle) throw new Error("no bundle is open");
  return bundle;
}

function registerIpc(): void {
  ipcMain.handle("bundle", () => bundle);
  ipcMain.handle("chooseBundle", async () => {
    const result = await dialog.showOpenDialog({
      title: "Open a Tessela bundle",
      properties: ["openDirectory", "createDirectory"],
    });
    const chosen = result.filePaths[0];
    if (result.canceled || !chosen) return bundle;
    useBundle(chosen);
    return chosen;
  });
  ipcMain.handle("listPages", () => listPages(needBundle()));
  ipcMain.handle("vocab", () => runJson<VocabEntry[]>(tesselaBin(), vocabArgv(needBundle())));
  ipcMain.handle("query", (_e, args: QueryArgs) =>
    runJson<Hit[]>(tesselaBin(), queryArgv(needBundle(), args)),
  );
  ipcMain.handle("readPage", (_e, rel: string) => readPage(needBundle(), rel));
  ipcMain.handle("writePage", (_e, rel: string, text: string, expected: string | null) =>
    writePage(needBundle(), rel, text, expected),
  );
  ipcMain.handle("todayPath", () => journalPath(localDay(new Date())));
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    title: "Tessela",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // The window only ever shows our own page.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  void win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

void app.whenReady().then(() => {
  useBundle(loadBundle());
  registerIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopWatching?.();
  app.quit();
});
