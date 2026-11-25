import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { createUpdates, type Updater } from "../src/main/updates";
import type { UpdateState } from "../src/shared/updates";

/** electron-updater's `autoUpdater` as far as the app uses it. */
class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  found: string | null = null;
  fail: Error | null = null;
  installed = false;
  async checkForUpdates() {
    if (this.fail) throw this.fail;
    if (this.found) this.emit("update-available", { version: this.found });
  }
  async downloadUpdate() {
    if (this.fail) throw this.fail;
    this.emit("download-progress", { percent: 41.6 });
    this.emit("update-downloaded", { version: this.found });
  }
  quitAndInstall() {
    this.installed = true;
  }
}

function setup(canInstall: boolean, found: string | null = "1.2.0") {
  const updater = new FakeUpdater();
  updater.found = found;
  const seen: UpdateState[] = [];
  const updates = createUpdates({
    updater: updater as unknown as Updater,
    canInstall,
    releaseUrl: (v) => `https://example.test/v${v}`,
    onState: (s) => seen.push(s),
  });
  return { updater, updates, seen };
}

describe("updates", () => {
  it("an AppImage is offered the update, downloads it on request and installs on restart", async () => {
    const { updater, updates, seen } = setup(true);
    expect([updater.autoDownload, updater.autoInstallOnAppQuit]).toEqual([false, true]);

    await updates.check();
    expect(updates.state()).toEqual({ kind: "available", version: "1.2.0", install: true, url: "https://example.test/v1.2.0" });

    await updates.download();
    expect(seen).toContainEqual({ kind: "downloading", version: "1.2.0", percent: 42 });
    expect(updates.state()).toEqual({ kind: "ready", version: "1.2.0" });

    updates.install();
    expect(updater.installed).toBe(true);
  });

  it("a deb is only told that a newer version exists", async () => {
    const { updater, updates } = setup(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    await updates.check();
    expect(updates.state()).toMatchObject({ kind: "available", install: false, url: "https://example.test/v1.2.0" });
    await updates.download();
    expect(updates.state().kind).toBe("available");
    updates.install();
    expect(updater.installed).toBe(false);
  });

  it("a check that fails or finds nothing says nothing; a failed download can be tried again", async () => {
    const quiet = setup(true, null);
    await quiet.updates.check();
    quiet.updater.fail = new Error("offline");
    await quiet.updates.check();
    expect(quiet.seen).toEqual([]);

    const { updater, updates } = setup(true);
    await updates.check();
    updater.fail = new Error("connection reset");
    await updates.download();
    expect(updates.state()).toEqual({ kind: "failed", version: "1.2.0", message: "connection reset" });
    updater.fail = null;
    await updates.download();
    expect(updates.state().kind).toBe("ready");
  });
});
