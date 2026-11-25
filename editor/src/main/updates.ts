// Update checks against the GitHub releases (electron-updater reads latest-linux.yml there).
// An AppImage updates itself in place: the person says when to download, and the new version
// takes over when the app restarts. A deb only gets told that a newer version exists.
// The updater is passed in, so the flow can be tested without Electron or the network.

import type { UpdateState } from "../shared/updates";

/** The parts of electron-updater's `autoUpdater` this uses. */
export interface Updater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: "update-available" | "update-downloaded", listener: (info: { version: string }) => void): unknown;
  on(event: "download-progress", listener: (progress: { percent: number }) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
}

export interface Updates {
  state(): UpdateState;
  /** Looks for a newer version. Silent when there is none or the network is down. */
  check(): Promise<void>;
  /** Fetches the version that is available (only where the app can install it). */
  download(): Promise<void>;
  /** Restarts into a downloaded version. */
  install(): void;
}

export function createUpdates(options: {
  updater: Updater;
  /** The app can replace itself (an AppImage). */
  canInstall: boolean;
  releaseUrl: (version: string) => string;
  onState: (state: UpdateState) => void;
}): Updates {
  const { updater } = options;
  let state: UpdateState = { kind: "idle" };
  const set = (next: UpdateState): void => {
    state = next;
    options.onState(next);
  };
  /** `state` as it is now, after awaiting. */
  const now = (): UpdateState => state;

  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = options.canInstall;
  updater.on("update-available", (info) =>
    set({ kind: "available", version: info.version, install: options.canInstall, url: options.releaseUrl(info.version) }),
  );
  updater.on("download-progress", (p) => {
    if (state.kind === "downloading") set({ ...state, percent: Math.round(p.percent) });
  });
  updater.on("update-downloaded", (info) => set({ kind: "ready", version: info.version }));
  updater.on("error", (error) => {
    // A check that fails (offline, rate limited) is not worth a message; a download the person asked for is.
    if (state.kind === "downloading") set({ kind: "failed", version: state.version, message: error.message });
  });

  return {
    state: () => state,
    async check() {
      try {
        await updater.checkForUpdates();
      } catch {
        // Checking is a convenience.
      }
    },
    async download() {
      if (state.kind !== "available" && state.kind !== "failed") return;
      if (state.kind === "available" && !state.install) return;
      const { version } = state;
      set({ kind: "downloading", version, percent: 0 });
      try {
        await updater.downloadUpdate();
      } catch (e) {
        if (now().kind === "downloading") set({ kind: "failed", version, message: e instanceof Error ? e.message : String(e) });
      }
    },
    install() {
      if (state.kind === "ready") updater.quitAndInstall();
    },
  };
}
