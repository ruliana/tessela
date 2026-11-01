// How the editor looks: the text face and the light or dark theme, each a choice that is remembered.

import assert from "node:assert/strict";
import { suite } from "../harness.mjs";

const attr = (s, name) => s.win.evaluate((n) => document.documentElement.getAttribute(n), name);
const family = (s) => s.win.evaluate(() => getComputedStyle(document.querySelector(".cm-scroller")).fontFamily);
const background = (s) => s.win.evaluate(() => getComputedStyle(document.body).backgroundColor);

suite("Look", () => ({ "a.md": "---\ntype: concept\n---\n\nSome text.\n" }), (test) => {
  test("the text is in the serif typeface at first, and the theme follows the system", async (s) => {
    assert.match(await family(s), /Newsreader/);
    assert.equal(await attr(s, "data-text"), null);
    assert.equal(await attr(s, "data-theme"), null);
    assert.match(await s.win.textContent("#theme-toggle"), /System/);
  });

  test("the text can be switched to sans-serif and back", async (s) => {
    await s.win.click("#text-toggle");
    assert.equal(await attr(s, "data-text"), "sans");
    assert.match(await family(s), /IBM Plex Sans/);
    await s.win.click("#text-toggle");
    assert.equal(await attr(s, "data-text"), null);
  });

  test("the theme goes from system to light to dark, and dark has a dark background", async (s) => {
    await s.win.click("#theme-toggle");
    assert.equal(await attr(s, "data-theme"), "light");
    const light = await background(s);
    await s.win.click("#theme-toggle");
    assert.equal(await attr(s, "data-theme"), "dark");
    assert.notEqual(await background(s), light);
    await s.win.click("#theme-toggle");
    assert.equal(await attr(s, "data-theme"), null);
  });

  test("a choice is remembered when the window opens again", async (s) => {
    await s.win.click("#theme-toggle");
    await s.win.click("#text-toggle");
    await s.win.reload();
    await s.win.waitForSelector(".cm-content");
    assert.equal(await attr(s, "data-theme"), "light");
    assert.equal(await attr(s, "data-text"), "sans");
    await s.win.click("#theme-toggle");
    await s.win.click("#theme-toggle");
    await s.win.click("#text-toggle");
  });
});
