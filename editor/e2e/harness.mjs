// Shared pieces of the end-to-end tests: a bundle on disk, the app in a real window, and
// the small helpers every test uses. Used by acceptance.mjs; smoke.mjs stands alone.

import { _electron as electron } from "playwright-core";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const root = resolve(import.meta.dirname, "..");

export function localDay(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

export function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localDay(d);
}

export const front = (type = "concept") => `---\ntype: ${type}\n---\n\n`;

/** A bundle in a temporary folder. `files` maps a path to its text. */
export function makeBundle(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tessela-acc-"));
  mkdirSync(join(dir, "journals"));
  for (const [path, text] of Object.entries(files)) write(dir, path, text);
  return dir;
}

export function write(bundle, path, text) {
  mkdirSync(dirname(join(bundle, path)), { recursive: true });
  writeFileSync(join(bundle, path), text);
}

export function read(bundle, path) {
  return readFileSync(join(bundle, path), "utf8");
}

/** The page without its front matter. */
export function bodyOf(bundle, path) {
  return read(bundle, path).replace(/^---\n[\s\S]*?\n---\n\n?/, "");
}

/** Starts the built app on `bundle`. E2E_PACKAGED runs the packaged app instead (see smoke.mjs). */
export async function launch(bundle) {
  const packaged = process.env.E2E_PACKAGED;
  if (!packaged) process.env.TESSELA_BIN ??= resolve(root, "../target/debug/tessela");
  else delete process.env.TESSELA_BIN;
  const app = await electron.launch(
    packaged
      ? { executablePath: resolve(root, packaged), args: ["--no-sandbox", `--bundle=${bundle}`], env: { ...process.env } }
      : { args: [join(root, "dist/main.cjs"), "--no-sandbox", `--bundle=${bundle}`], env: { ...process.env } },
  );
  const win = await app.firstWindow();
  await win.waitForSelector(".cm-content");
  return new Session(app, win, bundle);
}

export class Session {
  constructor(app, win, bundle) {
    this.app = app;
    this.win = win;
    this.bundle = bundle;
    this.key = (k) => win.keyboard.press(k);
    this.type = (t) => win.keyboard.type(t);
  }

  /** Types `text`, with "\n" as the Enter key (Enter is what the editor reacts to). */
  async enter(text) {
    const lines = text.split("\n");
    for (const [i, l] of lines.entries()) {
      if (i > 0) await this.key("Enter");
      if (l) await this.type(l);
    }
  }

  /** Opens (creating when new) the page called `name`, with the cursor at its end. */
  async open(name) {
    const { win } = this;
    await win.fill("#search", name);
    await win.press("#search", "Enter");
    await win.waitForFunction((n) => document.querySelector(".card-title")?.textContent === n, name);
    await win.click(".cm-content");
    await this.key("Control+End");
  }

  /** Writes a page with `body` under a concept front matter, then opens it. */
  async openWith(name, body, type = "concept") {
    write(this.bundle, `${name}.md`, front(type) + body);
    await this.open(name);
  }

  /** The text of the editor of the (first) card, line by line. */
  doc(card = 0) {
    return this.win.$$eval(
      ".card",
      (cards, i) => [...cards[i].querySelectorAll(".cm-line")].map((l) => l.textContent).join("\n"),
      card,
    );
  }

  /** The page text without its front matter, as the editor shows it. */
  async body(card = 0) {
    return (await this.doc(card)).replace(/^---\n[\s\S]*?\n---\n\n?/, "");
  }

  /** The selected text. */
  selected() {
    return this.win.evaluate(() => window.getSelection()?.toString() ?? "");
  }

  status(card = 0) {
    return this.win.$$eval(".status", (els, i) => els[i]?.textContent, card);
  }

  async saved(card = 0) {
    await this.win.waitForFunction(
      (i) => document.querySelectorAll(".status")[i]?.textContent === "Saved",
      card,
    );
  }

  /** Waits for autosave and returns the body that reached the disk. */
  async savedBody(name) {
    await this.saved();
    return bodyOf(this.bundle, `${name}.md`);
  }

  texts(selector) {
    return this.win.$$eval(selector, (els) => els.map((e) => e.textContent));
  }

  async shot(path) {
    await this.win.screenshot({ path });
  }

  /** Closes the window; an app that does not quit within a few seconds is killed. */
  async close() {
    const quit = this.app.close().catch(() => {});
    const timeout = new Promise((r) => setTimeout(r, 8000, "timeout"));
    if ((await Promise.race([quit, timeout])) === "timeout") this.app.process().kill("SIGKILL");
  }
}

// ---- a tiny test runner -------------------------------------------------------------

const tests = [];

export function suite(name, make, run) {
  tests.push({ name, make, run });
}

/**
 * Each suite gets its own bundle and app window. A failing test is reported and the next
 * one still runs, so one run shows everything that is broken. ONLY=regex picks tests.
 */
export async function runAll() {
  const only = process.env.ONLY ? new RegExp(process.env.ONLY, "i") : null;
  const failures = [];
  let passed = 0;
  for (const s of tests) {
    const cases = [];
    const t = (name, fn) => cases.push({ name, fn });
    s.run(t);
    const picked = cases.filter((c) => !only || only.test(`${s.name} ${c.name}`));
    if (picked.length === 0) continue;
    const bundle = makeBundle(s.make?.() ?? {});
    const session = await launch(bundle);
    console.log(`\n${s.name}`);
    for (const c of picked) {
      try {
        await c.fn(session);
        passed++;
        console.log(`  ok   ${c.name}`);
      } catch (e) {
        failures.push(`${s.name} > ${c.name}`);
        console.log(`  FAIL ${c.name}\n${String(e.stack ?? e).replace(/^/gm, "       ")}`);
        const shot = join(tmpdir(), `tessela-fail-${failures.length}.png`);
        await session.shot(shot).catch(() => {});
        console.log(`       screenshot: ${shot}`);
      }
    }
    await session.close();
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(failures.length === 0 ? 0 : 1);
}
