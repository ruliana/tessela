// The surface mod (bundled, mods/surface): at a pause in typing it asks `tessela surface` for the notes
// that bear on the paragraph and Jev about each, and shows the one that matters in the margin, level
// with the paragraph. Here a stub Jev server stands in at the base URL of the config folder's settings.json.
// Typewriter scrolling is off, since the tests compare where things are.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { front, suite } from "../harness.mjs";

/** A Jev that likes every note: it answers each question the way a useful one would. Requests are kept. */
const requests = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    requests.push({ url: req.url, auth: req.headers.authorization, body: parsed });
    const answers = {};
    for (const [name, q] of Object.entries(parsed.questions ?? {})) {
      if (name.startsWith("answers_")) answers[name] = { type: "noul", noul: 0.95 };
      else if (name.startsWith("contradicts_")) answers[name] = { type: "noul", noul: 0.02 };
      else if (name.startsWith("written_")) answers[name] = { type: "choice", choice: "different", confidence: 0.9, probabilities: { same: 0.02, overlaps: 0.08, different: 0.9 } };
      else if (name.startsWith("topic_")) answers[name] = { type: "score", score: 2.9, confidence: 0.9, probabilities: {} };
      else if (name.startsWith("next_")) answers[name] = { type: "score", score: 2.9, confidence: 0.9, probabilities: {} };
      else if (name.startsWith("covered_")) answers[name] = { type: "noul", noul: 0.02 };
      else if (name === "holds") answers[name] = { type: "choice", choice: "neither", confidence: 0.9, probabilities: { task: 0.02, date: 0.03, neither: 0.95 } };
      else if (name === "activity") answers[name] = { type: "choice", choice: "idle", confidence: 0.9, probabilities: { drafting: 0.1, editing: 0.05, reading: 0.05, idle: 0.8 } };
      else answers[name] = { type: q.type === "noul" ? "noul" : "choice", noul: 0, choice: "x", probabilities: {} };
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ model: "stub", answers, usage: { input_tokens: 1, output_tokens: 1 } }));
  });
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
server.unref();
const base = `http://127.0.0.1:${server.address().port}`;

const files = () => ({
  "cache.md": `${front()}# Cache\n\nWe chose #rust for the cache because startup time matters.\n`,
  "other.md": `${front()}Nothing about the topic here, only #python.\n`,
});

/** A page long enough to have a next read: about sixty words, ending where the cursor is. */
const LONG = "The #rust cache layer keeps every page it has parsed so that the next call starts from what the last one learned. ".repeat(3);

const settings = (jev) => ({ editor: { typewriter: false }, jev });
const card = ".surface-card";
const SENTENCE = "Thinking again about the #rust cache layer. ";

// Each test writes on a page of its own: a dismissed note stays dismissed for as long as the page is open.
let pages = 0;
const fresh = () => `draft-${++pages}`;

async function writeSentence(s) {
  await s.open(fresh());
  await s.type(SENTENCE);
}

suite("Surface mod, with a key", files, (test) => {
  test("a pause brings the note that matters, level with the paragraph, and the text does not move", async (s) => {
    requests.length = 0;
    await s.open(fresh());
    // Typing alone asks nothing: the first call comes at the pause, once.
    await s.type("Thinking again about the #rust cache layer");
    assert.equal(requests.length, 0);
    await s.type(". ");
    await s.win.waitForSelector(card);
    assert.equal(requests.length, 1, "one batch for the pause");
    assert.equal(requests[0].auth, "Bearer test-key");
    assert.equal(requests[0].url, "/v1/systemone");
    assert.ok(Object.keys(requests[0].body.questions).some((q) => q.startsWith("contradicts_")));
    assert.match(await s.win.textContent(`${card} .surface-title`), /Cache/);
    const level = await s.win.evaluate(() => {
      const c = document.querySelector(".surface-card").getBoundingClientRect();
      const l = [...document.querySelectorAll(".cm-line")].find((x) => x.textContent.includes("Thinking")).getBoundingClientRect();
      const text = document.querySelector(".cm-content").getBoundingClientRect();
      return { dy: Math.abs(c.top - l.top), right: c.left >= text.right };
    });
    assert.ok(level.dy < 24, `level with its paragraph (${level.dy}px off)`);
    assert.ok(level.right, "in the margin, beside the text");
    // With the card gone the paragraph is where it was.
    const rect = () => s.win.evaluate(() => [...document.querySelectorAll(".cm-line")].find((l) => l.textContent.includes("Thinking")).getBoundingClientRect().toJSON());
    const withCard = await rect();
    await s.key("Escape");
    await s.win.waitForFunction(() => !document.querySelector(".surface-card"));
    assert.deepEqual(await rect(), withCard, "the text did not move");
  });

  test("Esc dismisses the card and the note does not come back", async (s) => {
    requests.length = 0;
    await writeSentence(s);
    await s.win.waitForSelector(card);
    await s.key("Escape");
    await s.win.waitForFunction(() => !document.querySelector(".surface-card"));
    await s.type("More about the #rust cache layer. ");
    await s.win.waitForTimeout(1200);
    assert.equal(await s.win.$$eval(card, (e) => e.length), 0);
  });

  test("the keys link and peek at the note", async (s) => {
    await writeSentence(s);
    await s.win.waitForSelector(card);
    await s.key("Control+Alt+Enter");
    await s.win.waitForSelector("#side-top #peek");
    // The peek leaves the writing alone, and the card stays: the link goes in at the cursor, and the card with it.
    await s.key("Control+Alt+i");
    assert.match(await s.doc(), /\[Cache\]\(\/cache\.md\)/);
  });

  test("a card shows only at a pause, and the next keystroke asks again, never during one", async (s) => {
    requests.length = 0;
    await s.open(fresh());
    await s.type("The #rust cache layer. ");
    await s.win.waitForSelector(card);
    const asked = requests.length;
    // Typing on, with no pause, asks nothing: the answers for a text that changed are dropped.
    for (const ch of "and more words without a pause") await s.key(ch === " " ? "Space" : ch);
    assert.equal(requests.length, asked);
  });

  test("when nobody types for a while, the results go to the right column", async (s) => {
    await writeSentence(s);
    await s.win.waitForSelector(card);
    await s.win.waitForSelector("#side-bottom .surface-panel .surface-item", { timeout: 15000 });
    assert.equal(await s.win.$$eval(card, (e) => e.length), 0, "the margin is left to the text");
    assert.match(await s.win.textContent("#side-bottom .surface-name"), /Cache/);
  });

  test("at the end of a page, the next reads are listed under it and nothing above them moves", async (s) => {
    requests.length = 0;
    await s.open(fresh());
    await s.type(LONG);
    const first = () => s.win.evaluate(() => document.querySelector(".cm-line").getBoundingClientRect().toJSON());
    const before = await first();
    await s.win.waitForSelector(".read-next .read-next-title", { timeout: 15000 });
    assert.deepEqual(await first(), before, "the text did not move");
    assert.match(await s.win.textContent(".read-next .read-next-title"), /Cache/);
    assert.equal(await s.win.$$eval(".read-next .read-next-title", (e) => e.filter((t) => /draft-/.test(t.textContent)).length), 0, "never the page itself");
    const below = await s.win.evaluate(() => {
      const lines = [...document.querySelectorAll(".cm-line")];
      return document.querySelector(".read-next").getBoundingClientRect().top >= lines[lines.length - 1].getBoundingClientRect().bottom;
    });
    assert.ok(below, "under the last line");
    const asked = requests.filter((r) => Object.keys(r.body.questions).some((q) => q.startsWith("next_")));
    assert.equal(asked.length, 1);
    assert.match(JSON.stringify(asked[0].body.state.page), /keeps every page it has parsed/);
    // The page fits the window, so its end stays in view whatever the cursor does: the list stays.
    await s.key("Control+Home");
    await s.win.waitForTimeout(1200);
    assert.equal(await s.win.$$eval(".read-next .read-next-title", (e) => e.length), 1);
  });
}, { settings: settings({ key: "test-key", baseUrl: base }) });

suite("Surface mod, without a key", files, (test) => {
  test("nothing is asked and nothing is shown", async (s) => {
    requests.length = 0;
    await writeSentence(s);
    await s.win.waitForTimeout(1500);
    assert.equal(requests.length, 0);
    assert.equal(await s.win.$$eval(card, (e) => e.length), 0);
    assert.equal(await s.win.$$eval(".surface-panel", (e) => e.length), 0);
  });

  test("a whole page written asks nothing and lists nothing under it", async (s) => {
    requests.length = 0;
    await s.open(fresh());
    await s.type(LONG);
    await s.win.waitForTimeout(5500);
    assert.equal(requests.length, 0);
    assert.equal(await s.win.$$eval(".read-next", (e) => e.length), 0);
  });
}, { settings: settings({ baseUrl: base }) });
