// Search, page list, problems panel, backlinks and changes made by other programs.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { front, read, suite, write } from "../harness.mjs";

const long = Array.from({ length: 30 }, (_, i) => (i === 17 ? "the needle-in-a-haystack line" : `filler line ${i}`)).join("\n\n");

function bundle() {
  return {
    "project/tessela.md": `${front("project")}The editor project.\n`,
    "broken.md": "no frontmatter here, searchable-needle\n",
    "long.md": `${front()}${long}\n`,
    "people/ana.md": `${front("person")}Ana works on the editor.\n`,
    "journals/2020-01-01.md": "---\ntype: journal\ndate: 2020-01-01\n---\n\nWorked on #project/tessela today.\n\nAlso talked to [Ana](/people/ana.md).\n",
    "uses-unwritten.md": `${front()}Thinking about #not-yet-written things.\n`,
  };
}

suite("Search and page list", bundle, (test) => {
  test("the sidebar lists pages and concepts", async (s) => {
    await s.win.waitForSelector("#pages button");
    const names = await s.texts("#pages .name");
    for (const n of ["project/tessela", "broken", "people/ana", "long"]) assert.ok(names.includes(n), `${n} in ${names}`);
  });

  test("a concept used but without a page is listed as unwritten", async (s) => {
    await s.win.waitForSelector("#pages li.unwritten");
    assert.ok((await s.texts("#pages li.unwritten .name")).includes("not-yet-written"));
  });

  test("clicking a page opens it", async (s) => {
    await s.win.click("#pages button:has-text('people/ana')");
    await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "people/ana");
    assert.match(await s.doc(), /Ana works on the editor/);
  });

  test("typing filters the page names", async (s) => {
    await s.win.fill("#search", "tess");
    const names = await s.texts("#pages .name");
    assert.ok(names.includes("project/tessela"));
    assert.ok(!names.includes("broken"));
  });

  test("the filter is not case sensitive", async (s) => {
    await s.win.fill("#search", "TESS");
    assert.ok((await s.texts("#pages .name")).includes("project/tessela"));
  });

  test("Escape clears the search", async (s) => {
    await s.win.fill("#search", "tess");
    await s.win.press("#search", "Escape");
    assert.equal(await s.win.inputValue("#search"), "");
    assert.ok((await s.texts("#pages .name")).includes("broken"));
  });

  test("text search finds words inside pages", async (s) => {
    await s.win.fill("#search", "searchable-needle");
    await s.win.waitForSelector("#results .hit");
    assert.match(await s.win.textContent("#results"), /In the text/);
    assert.match(await s.win.textContent("#results .hit"), /broken/);
    assert.match(await s.win.textContent("#results .hit"), /searchable-needle/);
  });

  test("text search is not case sensitive", async (s) => {
    await s.win.fill("#search", "SEARCHABLE-NEEDLE");
    await s.win.waitForSelector("#results .hit");
    assert.match(await s.win.textContent("#results"), /broken/);
  });

  test("a hit opens the page at its line", async (s) => {
    await s.win.fill("#search", "needle-in-a-haystack");
    await s.win.click("#results .hit:has-text('haystack')");
    await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "long");
    await s.win.waitForFunction(() => {
      const node = getSelection()?.anchorNode;
      return node?.parentElement?.closest(".cm-line")?.textContent?.includes("needle-in-a-haystack");
    });
  });

  test("text that is nowhere says so", async (s) => {
    await s.win.fill("#search", "zzzqqqxxx");
    await s.win.waitForFunction(() => document.querySelector("#results")?.textContent?.includes("Not in any text"));
  });

  test("one character is too little to search the text", async (s) => {
    await s.win.fill("#search", "e");
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(await s.win.isHidden("#results"), true);
  });

  test("clearing the search hides the results", async (s) => {
    await s.win.fill("#search", "searchable-needle");
    await s.win.waitForSelector("#results .hit");
    await s.win.fill("#search", "");
    await s.win.waitForFunction(() => document.querySelector("#results").hidden);
  });

  test("Enter creates the page named by the search, which has no file until typed in", async (s) => {
    await s.win.fill("#search", "A Brand New Idea");
    await s.win.press("#search", "Enter");
    await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "a-brand-new-idea");
    assert.equal(await s.status(), "New page");
    assert.throws(() => readFileSync(join(s.bundle, "a-brand-new-idea.md")));
    assert.match(await s.doc(), /^---\ntype: /);
    await s.win.click(".cm-content");
    await s.key("Control+End");
    await s.type("It starts here");
    await s.saved();
    assert.match(read(s.bundle, "a-brand-new-idea.md"), /It starts here/);
  });

  test("Enter on an existing page name opens it", async (s) => {
    await s.win.fill("#search", "People/Ana");
    await s.win.press("#search", "Enter");
    await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "people/ana");
    assert.match(await s.doc(), /Ana works/);
  });

  test("the page that is open is marked in the list", async (s) => {
    assert.equal(await s.win.$$eval("#pages [aria-current=page] .name", (e) => e.map((x) => x.textContent)).then((a) => a[0]), "people/ana");
  });

  test("a new page shows up in the list once saved", async (s) => {
    await s.win.waitForFunction(() => [...document.querySelectorAll("#pages .name")].some((e) => e.textContent === "a-brand-new-idea"));
  });
});

suite("Problems panel", bundle, (test) => {
  test("summarises what lint found, without the unwritten-concept noise", async (s) => {
    await s.win.waitForFunction(() => /error/.test(document.querySelector("#problems-toggle")?.textContent ?? ""));
    const summary = await s.win.textContent("#problems-toggle");
    assert.match(summary, /\d+ errors?/);
    assert.equal(await s.win.getAttribute("#problems-toggle", "data-clean"), "false");
  });

  test("starts closed and opens with the toggle", async (s) => {
    assert.equal(await s.win.isHidden("#problems"), true);
    await s.win.click("#problems-toggle");
    await s.win.waitForSelector("#problems .problem");
    assert.equal(await s.win.isVisible("#problems"), true);
    await s.win.click("#problems-toggle");
    assert.equal(await s.win.isHidden("#problems"), true);
    await s.win.click("#problems-toggle");
  });

  test("errors come first and name their file", async (s) => {
    const classes = await s.win.$$eval("#problems .problem", (e) => e.map((x) => x.className.replace("problem ", "")));
    assert.ok(classes.length > 0);
    assert.equal(classes[0], "error");
    const sorted = [...classes].sort((a, b) => ({ error: 0, warning: 1 })[a] - ({ error: 0, warning: 1 })[b]);
    assert.deepEqual(classes, sorted);
    assert.match(await s.win.textContent("#problems"), /broken\.md/);
  });

  test("a finding about an unwritten concept is not listed", async (s) => {
    assert.ok(!(await s.win.textContent("#problems")).includes("not-yet-written"));
  });

  test("clicking a problem opens the file", async (s) => {
    await s.win.click("#problems .problem:has-text('broken.md')");
    await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "broken");
    assert.match(await s.doc(), /searchable-needle/);
  });

  test("fixing the problem in the editor makes it go away", async (s) => {
    await s.win.click(".cm-content");
    await s.key("Control+Home");
    await s.enter("---\ntype: concept\n---\n");
    await s.saved();
    await s.win.waitForFunction(() => !document.querySelector("#problems")?.textContent?.includes("broken.md"));
    assert.match(read(s.bundle, "broken.md"), /^---\ntype: concept\n---/);
  });

  test("a problem made by another program appears without a reload", async (s) => {
    write(s.bundle, "another-broken.md", "nothing to see\n");
    await s.win.waitForFunction(() => document.querySelector("#problems")?.textContent?.includes("another-broken.md"));
  });

  test("when everything is fixed it says there are no problems", async (s) => {
    unlinkSync(join(s.bundle, "another-broken.md"));
    await s.win.waitForFunction(() => document.querySelector("#problems-toggle")?.textContent?.includes("No problems"));
    assert.equal(await s.win.getAttribute("#problems-toggle", "data-clean"), "true");
    assert.equal(await s.win.isHidden("#problems"), true);
  });
});

suite("Backlinks", bundle, (test) => {
  test("a page lists the blocks that mention it, grouped by page", async (s) => {
    await s.win.click("#pages button:has-text('project/tessela')");
    await s.win.waitForSelector("#backlinks .hit");
    assert.match(await s.win.textContent("#backlinks h2"), /Backlinks \(1\)/);
    assert.match(await s.win.textContent("#backlinks h3"), /journals\/2020-01-01/);
    assert.match(await s.win.textContent("#backlinks .hit"), /Worked on #project\/tessela today/);
  });

  test("links by path count as mentions too", async (s) => {
    await s.win.click("#pages button:has-text('people/ana')");
    await s.win.waitForFunction(() => document.querySelector("#backlinks")?.textContent?.includes("Talked to") || document.querySelector("#backlinks")?.textContent?.includes("talked to"));
  });

  test("a page nobody mentions says so", async (s) => {
    await s.win.click("#pages button:has-text('long')");
    await s.win.waitForFunction(() => document.querySelector("#backlinks")?.textContent?.includes("Nothing mentions this page yet."));
  });

  test("a backlink opens the page at that block", async (s) => {
    await s.win.click("#pages button:has-text('project/tessela')");
    await s.win.waitForSelector("#backlinks .hit");
    await s.win.click("#backlinks .hit");
    await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent === "journals/2020-01-01" || document.querySelector(".card-title")?.textContent === "2020-01-01");
    await s.win.waitForFunction(() => getSelection()?.anchorNode?.parentElement?.closest(".cm-line")?.textContent?.includes("Worked on"));
  });

  test("the page name above the blocks opens that page", async (s) => {
    await s.win.click("#pages button:has-text('project/tessela')");
    await s.win.waitForSelector("#backlinks h3 button");
    await s.win.click("#backlinks h3 button");
    await s.win.waitForFunction(() => document.querySelector(".card-title")?.textContent?.endsWith("2020-01-01"));
  });

  test("a new mention shows up after saving", async (s) => {
    await s.open("people/ana");
    await s.type("\n\nCalls #project/tessela often");
    await s.saved();
    await s.win.click("#pages button:has-text('project/tessela')");
    await s.win.waitForFunction(() => document.querySelector("#backlinks h2")?.textContent === "Backlinks (2)");
  });
});

suite("Changes from outside and saving", bundle, (test) => {
  test("a page changed by another program is reloaded", async (s) => {
    await s.open("people/ana");
    write(s.bundle, "people/ana.md", `${front("person")}Changed outside.\n`);
    await s.win.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("Changed outside."));
    assert.equal(await s.status(), "Saved");
  });

  test("a journal changed by another program is reloaded in the stack", async (s) => {
    await s.win.click("#journals-view");
    await s.win.waitForFunction(() => document.querySelectorAll(".card").length === 2);
    write(s.bundle, "journals/2020-01-01.md", "---\ntype: journal\ndate: 2020-01-01\n---\n\nRewritten outside.\n");
    await s.win.waitForFunction(() => document.querySelectorAll(".cm-content")[1]?.textContent?.includes("Rewritten outside."));
  });

  test("a new page made by another program shows in the list", async (s) => {
    write(s.bundle, "appeared.md", `${front()}I just appeared.\n`);
    await s.win.waitForFunction(() => [...document.querySelectorAll("#pages .name")].some((e) => e.textContent === "appeared"));
  });

  test("unsaved edits are not lost when the disk changes: a conflict is offered", async (s) => {
    await s.openWith("conflict-a", "Mine");
    await s.type(" is typed");
    write(s.bundle, "conflict-a.md", `${front()}Theirs\n`);
    await s.win.waitForSelector(".banner:not([hidden])");
    assert.match(await s.win.textContent(".banner"), /changed on disk/);
    assert.match(await s.status(), /Not saved/);
    assert.match(await s.doc(), /Mine is typed/);
  });

  test("Keep mine overwrites the disk", async (s) => {
    await s.win.click(".banner .keep-mine");
    await s.saved();
    assert.match(read(s.bundle, "conflict-a.md"), /Mine is typed/);
    assert.equal(await s.win.isHidden(".banner"), true);
  });

  test("Load disk version drops my edits", async (s) => {
    await s.openWith("conflict-b", "Mine");
    await s.type(" is typed");
    write(s.bundle, "conflict-b.md", `${front()}Theirs\n`);
    await s.win.waitForSelector(".banner:not([hidden])");
    await s.win.click(".banner .load-disk");
    await s.win.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("Theirs"));
    assert.ok(!(await s.doc()).includes("Mine is typed"));
    assert.equal(await s.status(), "Saved");
    assert.match(read(s.bundle, "conflict-b.md"), /Theirs/);
  });

  test("typing shows Editing… and then Saved", async (s) => {
    await s.openWith("status-flow", "x");
    await s.type("y");
    assert.equal(await s.status(), "Editing…");
    await s.saved();
  });

  test("saving leaves no temporary files behind", async (s) => {
    await s.openWith("atomic", "x");
    await s.type("y");
    await s.saved();
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(readdirSync(s.bundle).filter((f) => f.includes(".tmp")), []);
  });

  test("the front matter is kept as it was", async (s) => {
    write(s.bundle, "keeps-front.md", "---\ntype: concept\ntags: [a, b]\nextra: 1\n---\n\nBody\n");
    await s.open("keeps-front");
    await s.key("ArrowUp");
    await s.key("End");
    await s.type(" more");
    await s.saved();
    assert.equal(read(s.bundle, "keeps-front.md"), "---\ntype: concept\ntags: [a, b]\nextra: 1\n---\n\nBody more\n");
  });
});

suite("Undo", bundle, (test) => {
  test("Ctrl+Z right after opening a page does not blank it", async (s) => {
    await s.open("people/ana");
    await s.key("Control+z");
    await new Promise((r) => setTimeout(r, 1200));
    assert.match(await s.doc(), /Ana works on the editor/);
    assert.match(read(s.bundle, "people/ana.md"), /Ana works/);
  });

  test("Ctrl+Z many times after opening still does not blank it", async (s) => {
    await s.open("project/tessela");
    for (let i = 0; i < 5; i++) await s.key("Control+z");
    assert.match(await s.doc(), /The editor project/);
  });

  test("undo takes back typing, not the page", async (s) => {
    await s.open("people/ana");
    await s.type(" typed");
    await s.key("Control+z");
    assert.equal((await s.body()).trim(), "Ana works on the editor.");
  });

  test("redo brings the typing back", async (s) => {
    await s.key("Control+Shift+z");
    assert.match(await s.body(), /typed/);
    await s.key("Control+y");
  });

  test("Ctrl+Z after a page reloaded from outside keeps the page", async (s) => {
    await s.open("project/tessela");
    write(s.bundle, "project/tessela.md", `${front("project")}Changed outside.\n`);
    await s.win.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("Changed outside."));
    await s.key("Control+z");
    assert.match(await s.doc(), /Changed outside/);
  });

  test("Ctrl+Z in the journal stack does not blank a day", async (s) => {
    await s.win.click("#journals-view");
    await s.win.waitForFunction(() => document.querySelectorAll(".card").length === 2);
    await s.win.click(".card:nth-child(2) .cm-content");
    await s.key("Control+z");
    await new Promise((r) => setTimeout(r, 1200));
    assert.match(await s.doc(1), /Worked on #project\/tessela today/);
    assert.match(read(s.bundle, "journals/2020-01-01.md"), /Worked on/);
  });

  test("undoing an edit in a journal restores only that edit", async (s) => {
    await s.key("Control+End");
    await s.type(" extra");
    await s.key("Control+z");
    assert.ok(!(await s.doc(1)).includes("extra"));
    assert.match(await s.doc(1), /Worked on/);
  });
});
