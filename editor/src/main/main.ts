import { existsSync, promises as fs, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { BrowserWindow, app, dialog, ipcMain, net, protocol, shell } from "electron";
import { pathToFileURL } from "node:url";

import type { Diagnostic, Hit, OpenFileResult, PageEntry, QueryArgs, VocabEntry } from "../shared/api";
import { journalPath, localDay } from "../shared/pages";
import { relativeInside, resolveImage, resolveInside } from "./files";
import { addPageVia, cliInput, cliVia, findTessela, lintArgv, pagesArgv, queryArgv, readPageVia, runJson, savePageVia, vocabArgv, watchVia } from "./tessela";
import { agentsText, cliArgv, configFolder, installAgents, isModId, listMods, resolveModFile, setModOff } from "./mods";

// Name the app Tessela (the switcher, the menu bar and the Dock would otherwise say "Electron").
// userData is pinned first: the name feeds its default, and the saved bundle lives there.
app.setPath("userData", app.getPath("userData"));
app.setName("Tessela");

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
    stopWatching = watchVia(tesselaBin(), dir, (paths) => win?.webContents.send("changed", paths));
  }
}

/** Mods are switched off by starting with `--no-mods`, for when one breaks the window. */
const modsDisabled = process.argv.includes("--no-mods");

/** The mods that come with the app (built to dist/mods, next to this file). */
const bundledMods = path.join(__dirname, "mods");

function config(): string {
  return configFolder(app.getPath("userData"), process.env.TESSELA_CONFIG);
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
  ipcMain.handle("listPages", () => runJson<PageEntry[]>(tesselaBin(), pagesArgv(needBundle()), "pages"));
  ipcMain.handle("vocab", () => runJson<VocabEntry[]>(tesselaBin(), vocabArgv(needBundle()), "concepts"));
  ipcMain.handle("query", (_e, args: QueryArgs) =>
    runJson<Hit[]>(tesselaBin(), queryArgv(needBundle(), args), "hits"),
  );
  ipcMain.handle("lint", () =>
    runJson<Diagnostic[]>(tesselaBin(), lintArgv(needBundle()), "diagnostics", [1]),
  );
  // Pages are read and written by the same tool agents use, never by the editor itself.
  ipcMain.handle("readPage", (_e, rel: string) => readPageVia(tesselaBin(), needBundle(), rel));
  ipcMain.handle("writePage", (_e, rel: string, text: string, expected: string | null) =>
    savePageVia(tesselaBin(), needBundle(), rel, text, expected),
  );
  ipcMain.handle("addPage", (_e, rel: string, title?: string) =>
    addPageVia(tesselaBin(), needBundle(), rel, title),
  );
  ipcMain.handle("openExternal", async (_event, url: unknown) => {
    // Only addresses meant for another program: never a file or a custom scheme.
    if (typeof url === "string" && /^(https?:|mailto:)/i.test(url)) await shell.openExternal(url);
  });
  ipcMain.handle("todayPath", () => journalPath(localDay(new Date())));
  ipcMain.handle("mods", () => listMods(config(), modsDisabled, bundledMods));
  ipcMain.handle("reload", () => win?.webContents.reload());
  ipcMain.handle("setModOff", (_e, id: unknown, off: unknown) => {
    if (typeof id !== "string" || !isModId(id) || typeof off !== "boolean") throw new Error("setModOff: a mod id and true or false");
    setModOff(config(), id, off);
  });
  // For mods: any tessela command on the open folder (see Api.cli).
  ipcMain.handle("cli", (_e, argv: unknown, input: unknown) =>
    cliVia(tesselaBin(), needBundle(), cliArgv(argv), cliInput(input)),
  );
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    title: "Tessela",
    // The packaged app gets its icon from the build; this is for the window on Linux and when run unpackaged.
    icon: path.join(__dirname, "renderer", "icon.png"),
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

// Pictures in the notes folder are shown through this address, so the window never reads files itself.
protocol.registerSchemesAsPrivileged([
  { scheme: "tessela-file", privileges: { standard: true, secure: true } },
  // Mods are ES modules, which the window loads (and which load each other) from here.
  { scheme: "tessela-mod", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

function serveMods(): void {
  protocol.handle("tessela-mod", async (request) => {
    try {
      const [id = "", ...rest] = decodeURIComponent(new URL(request.url).pathname).replace(/^\//, "").split("/");
      const file = resolveModFile(config(), id, rest.join("/"), bundledMods);
      return new Response(await fs.readFile(file), {
        headers: { "content-type": file.endsWith(".js") ? "text/javascript" : "application/octet-stream", "access-control-allow-origin": "*" },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}

function serveImages(): void {
  protocol.handle("tessela-file", (request) => {
    try {
      const rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\//, "");
      return net.fetch(pathToFileURL(resolveImage(needBundle(), rel)).toString());
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}

void app.whenReady().then(() => {
  serveImages();
  serveMods();
  try {
    installAgents(config(), agentsText(readFileSync(path.join(__dirname, "mods-guide.md"), "utf8")));
  } catch {
    // The guide is only a help.
  }
  useBundle(loadBundle());
  registerIpc();
  // macOS ignores the window icon and takes the Dock one from the app bundle. Packaged builds
  // have build/icon.icns there, so this is for running unpackaged.
  if (process.platform === "darwin" && !app.isPackaged) app.dock?.setIcon(path.join(__dirname, "renderer", "icon.png"));
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopWatching?.();
  app.quit();
});
