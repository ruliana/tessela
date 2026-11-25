// The sidebar's drawers (Calendar from the agenda mod, Recent, Journals, Concepts) fold away
// from their heads, with the mouse or the keyboard, and stay folded after a restart.

import assert from "node:assert/strict";
import { front, localDay, suite } from "../harness.mjs";

const drawers = ["#month-strip-drawer", "#recent", "#journals-section", "#concepts-section"];
const toggle = (d) => `${d} .drawer-toggle`;
const hidden = (s, d) => s.win.$eval(`${d} > :not(.drawer-head)`, (b) => getComputedStyle(b).display === "none");

suite("Sidebar drawers", () => ({ "a.md": `${front()}Hello.\n`, [`journals/${localDay()}.md`]: `${front("journal")}Today.\n` }), (test) => {
  test("every drawer starts open, and its head says so", async (s) => {
    await s.openWith("a", "Hello.");
    for (const d of drawers) {
      await s.win.waitForSelector(toggle(d));
      assert.equal(await s.win.getAttribute(toggle(d), "aria-expanded"), "true", d);
      assert.equal(await hidden(s, d), false, d);
    }
  });

  test("clicking a head folds the drawer, and again opens it", async (s) => {
    for (const d of drawers) {
      await s.win.click(toggle(d));
      assert.equal(await s.win.getAttribute(toggle(d), "aria-expanded"), "false", d);
      assert.equal(await hidden(s, d), true, d);
      await s.win.click(toggle(d));
      assert.equal(await hidden(s, d), false, d);
    }
  });

  test("the keyboard folds a drawer from its head", async (s) => {
    await s.win.focus(toggle("#concepts-section"));
    await s.key("Enter");
    assert.equal(await hidden(s, "#concepts-section"), true);
    await s.key("Space");
    assert.equal(await hidden(s, "#concepts-section"), false);
  });

  test("a folded drawer stays folded after a restart, and the others stay open", async (s) => {
    await s.win.click(toggle("#recent"));
    await s.win.click(toggle("#month-strip-drawer"));
    await s.win.reload();
    await s.win.waitForSelector(toggle("#recent"));
    assert.equal(await hidden(s, "#recent"), true);
    assert.equal(await hidden(s, "#month-strip-drawer"), true);
    assert.equal(await hidden(s, "#journals-section"), false);
  });
});
