// The search mod (bundled, mods/search): the sidebar search reads what is typed as words in any
// order, "quoted phrases" and filters (#tag, type:, in:, dates), shows the `tessela query` it runs,
// and can keep it as a live list. It takes over through the `override` hook, so another mod can too.

import assert from "node:assert/strict";
import { front, suite } from "../harness.mjs";

const files = () => ({
  "notes/one.md": `${front()}We keep alpha, beta and gamma together.\n`,
  "notes/two.md": `${front()}Only alpha here, with a #rust tag.\n`,
  "people/ana.md": `${front("person")}Ana likes alpha and #rust.\n`,
  "journals/2020-01-01.md": "---\ntype: journal\ndate: 2020-01-01\n---\n\nWrote alpha today #rust\n",
  "reports/q3.md": "---\ntype: concept\ntitle: Quarterly Report\n---\n\nThe numbers.\n",
});

/** Types into the search box and waits for the results to be about `typed`. */
async function find(s, typed) {
  await s.win.fill("#search", typed);
  await s.win.waitForFunction((t) => document.querySelector("#results")?.dataset.for === t, typed);
  return s.texts("#results .hit .kind");
}

suite("Search mod", files, (test) => {
  test("words match in any order", async (s) => {
    assert.deepEqual(await find(s, "gamma alpha"), ["notes/one"]);
  });

  test("a quoted phrase must match as written, and several can be combined", async (s) => {
    assert.deepEqual(await find(s, '"alpha, beta"'), ["notes/one"]);
    assert.deepEqual(await find(s, '"beta, alpha"'), []);
    assert.match(await s.win.textContent("#results"), /Not in any text/);
    assert.deepEqual(await find(s, '"alpha, beta" "and gamma"'), ["notes/one"]);
  });

  test("#tag narrows the words, and the page list is not filtered by the filter words", async (s) => {
    assert.deepEqual((await find(s, "alpha #rust")).sort(), ["journals/2020-01-01", "notes/two", "people/ana"]);
    // Only the plain words filter the names: nothing is filtered by a tag alone.
    await find(s, "#rust");
    assert.ok((await s.texts("#pages .name")).includes("notes/one"));
  });

  test("type:, in: and a date narrow too", async (s) => {
    assert.deepEqual(await find(s, "alpha type:person"), ["people/ana"]);
    assert.deepEqual((await find(s, "alpha in:notes/")).sort(), ["notes/one", "notes/two"]);
    assert.deepEqual(await find(s, "alpha 2020-01-01"), ["journals/2020-01-01"]);
  });

  test("a page is found by its title, and the hit opens it", async (s) => {
    assert.deepEqual(await find(s, "quarterly"), ["reports/q3"]);
    assert.match(await s.win.textContent("#results .hit"), /Quarterly Report/);
    await s.win.click("#results .hit");
    await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "reports/q3");
  });

  test("the command that runs is shown", async (s) => {
    await find(s, 'alpha #rust type:person in:people/ "likes alpha"');
    const shown = await s.win.textContent("#search-command");
    assert.match(shown, /^tessela query /);
    for (const part of ["--ref rust", "--type person", "--page people/", '--text "likes alpha"', "--words alpha"]) {
      assert.ok(shown.includes(part), `${part} in ${shown}`);
    }
  });

  test("filters alone search, and the result can be kept as a live list in the page", async (s) => {
    await s.open("scratch");
    assert.equal((await find(s, "#rust")).length, 3);
    await s.win.click("#search-keep");
    await s.win.waitForFunction(() => document.querySelectorAll(".tessela-live .tessela-row").length === 3);
    assert.match(await s.body(), /```tessela\nquery --ref rust\n```/);
    await s.saved();
  });

});

suite(
  "Search mod: taken over by another mod",
  files,
  (test) => {
    test("a mod that overrides search answers instead, and the names are filtered by what it says", async (s) => {
      await s.win.fill("#search", "tess ana");
      await s.win.waitForFunction(() => document.querySelector("#results")?.textContent === "custom:tess ana");
      assert.deepEqual(await s.texts("#pages .name"), ["people/ana"]);
    });
  },
  {
    mods: {
      // Loads after the bundled `search`, so it is the one that takes over.
      zsearch: `export default (ctx) => {
        ctx.override.add("search", {
          run: ({ input, results }) => { results.textContent = "custom:" + input; return true; },
          names: (input) => input.split(" ").pop(),
        });
      };`,
    },
  },
);
