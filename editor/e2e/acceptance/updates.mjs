// Updates: the app looks for a newer release at start (here a local feed plays the GitHub
// release's latest-linux.yml). An AppImage can fetch it with one click and installs it when the
// app restarts; a deb only gets told. Restarting is not pressed: it would replace the test's AppImage.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { front, suite } from "../harness.mjs";

const name = "tessela-editor-99.0.0-linux-x86_64.AppImage";
const image = Buffer.from("pretend this is an AppImage");
const sha512 = createHash("sha512").update(image).digest("base64");
const feed = `version: 99.0.0
files:
  - url: ${name}
    sha512: ${sha512}
    size: ${image.length}
path: ${name}
sha512: ${sha512}
releaseDate: '2026-01-01T00:00:00.000Z'
`;

const server = createServer((req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  const body = path === "/latest-linux.yml" ? feed : path === `/${name}` ? image : null;
  res.writeHead(body ? 200 : 404, { "content-length": body ? Buffer.byteLength(body) : 0 });
  res.end(body ?? undefined);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const TESSELA_UPDATE_FEED = `http://127.0.0.1:${server.address().port}`;
process.on("exit", () => server.close());

const appImage = join(mkdtempSync(join(tmpdir(), "tessela-appimage-")), "tessela-editor-0.0.1-linux-x86_64.AppImage");
writeFileSync(appImage, "the running app");

const files = () => ({ "alpha.md": `${front()}Some text.\n` });

suite("Update of an AppImage", files, (test) => {
  test("a newer release is offered, one click fetches it and a restart installs it", async (s) => {
    const note = s.win.locator("#update");
    await note.waitFor();
    assert.match(await note.textContent(), /Tessela 99\.0\.0 is available/);
    await s.win.click("#update-download");
    await s.win.locator("#update-restart").waitFor();
    assert.match(await note.textContent(), /Tessela 99\.0\.0 is ready/);
  });
}, { env: { TESSELA_UPDATE_FEED, APPIMAGE: appImage } });

suite("Update of a deb", files, (test) => {
  test("the newer release is only announced, with a link to get it", async (s) => {
    await s.win.locator("#update").waitFor();
    assert.match(await s.win.textContent("#update"), /Tessela 99\.0\.0 is available/);
    assert.equal(await s.win.locator("#update-download").count(), 0);
    assert.equal(await s.win.locator("#update-open").count(), 1);
  });
}, { env: { TESSELA_UPDATE_FEED, APPIMAGE: "" } });

suite("No update", files, (test) => {
  test("nothing is shown when the app is not asked to check", async (s) => {
    await s.win.waitForTimeout(1500);
    assert.equal(await s.win.locator("#update").isVisible(), false);
  });
});
