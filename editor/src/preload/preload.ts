import { contextBridge, ipcRenderer } from "electron";

import type { Api } from "../shared/api";

const api: Api = {
  bundle: () => ipcRenderer.invoke("bundle"),
  chooseBundle: () => ipcRenderer.invoke("chooseBundle"),
  openFile: () => ipcRenderer.invoke("openFile"),
  useFolder: (folder) => ipcRenderer.invoke("useFolder", folder),
  listPages: () => ipcRenderer.invoke("listPages"),
  vocab: () => ipcRenderer.invoke("vocab"),
  query: (args) => ipcRenderer.invoke("query", args),
  lint: () => ipcRenderer.invoke("lint"),
  readPage: (path) => ipcRenderer.invoke("readPage", path),
  writePage: (path, text, expected) => ipcRenderer.invoke("writePage", path, text, expected),
  openExternal: (url) => ipcRenderer.invoke("openExternal", url),
  todayPath: () => ipcRenderer.invoke("todayPath"),
  onChanged(listener) {
    const handler = (_event: unknown, paths: string[]) => listener(paths);
    ipcRenderer.on("changed", handler);
    return () => ipcRenderer.removeListener("changed", handler);
  },
};

contextBridge.exposeInMainWorld("tessela", api);
