import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { BrowserWindow, app, dialog, ipcMain } from "electron";

import type { Diagnostic, Hit, OpenFileResult, QueryArgs, VocabEntry } from "../shared/api";
import { journalPath, localDay } from "../shared/pages";
import { listPages, readPage, relativeInside, resolveInside, watchBundle, writePage } from "./files";
import { findTessela, lintArgv, queryArgv, runJson, vocabArgv } from "./tessela";

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

function tesselaBin(): string {
  return findTessela({
    env: process.env.TESSELA_BIN,
    resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
    appPath: app.getAppPath(),
    platform: process.platform,
    exists: existsSync,
  });
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
      title: "Choose the notes folder",
      buttonLabel: "Use this folder",
      defaultPath: bundle ?? undefined,
      properties: ["openDirectory", "createDirectory"],
    });
    const chosen = result.filePaths[0];
    if (result.canceled || !chosen) return bundle;
    useBundle(chosen);
    return chosen;
  });
  ipcMain.handle("openFile", async (): Promise<OpenFileResult> => {
    const root = needBundle();
    const result = await dialog.showOpenDialog({
      title: "Open a Markdown file",
      defaultPath: root,
      properties: ["openFile"],
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    const chosen = result.filePaths[0];
    if (result.canceled || !chosen) return { kind: "canceled" };
    const rel = relativeInside(root, chosen);
    if (rel === null) return { kind: "outside", folder: path.dirname(chosen) };
    try {
      resolveInside(root, rel);
    } catch {
      return { kind: "unsupported", reason: "Only .md files outside hidden folders can be opened." };
    }
    return { kind: "page", path: rel };
  });
  ipcMain.handle("useFolder", (_e, folder: string) => {
    if (!path.isAbsolute(folder) || !existsSync(folder)) throw new Error(`not a folder: ${folder}`);
    useBundle(folder);
    return folder;
  });
  ipcMain.handle("listPages", () => listPages(needBundle()));
  ipcMain.handle("vocab", () => runJson<VocabEntry[]>(tesselaBin(), vocabArgv(needBundle())));
  ipcMain.handle("query", (_e, args: QueryArgs) =>
    runJson<Hit[]>(tesselaBin(), queryArgv(needBundle(), args)),
  );
  ipcMain.handle("lint", () =>
    runJson<Diagnostic[]>(tesselaBin(), lintArgv(needBundle()), [1]),
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
