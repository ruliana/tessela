// The state of app updates, as the window shows it.

export type UpdateState =
  | { kind: "idle" }
  /** A newer version exists. `install`: the app can fetch and install it itself (AppImage); otherwise `url` is where to get it. */
  | { kind: "available"; version: string; install: boolean; url: string }
  | { kind: "downloading"; version: string; percent: number }
  /** Downloaded: it is installed when the app restarts (or quits). */
  | { kind: "ready"; version: string }
  | { kind: "failed"; version: string; message: string };
