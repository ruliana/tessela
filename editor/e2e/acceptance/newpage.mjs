// The new-page mod (bundled, mods/new-page): New page asks for a name and a type. The types are
// the bundle's `templates/NAME.md` (`type: template`); "Page" is the plain one and comes first.
// It takes the place of the built-in name box, so the button, Ctrl+N and the palette all lead here.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { front, read, suite, write } from "../harness.mjs";

const files = () => ({
  "templates/meeting.md": "---\ntype: template\ndescription: Notes of a talk\ntitle: Template title\nattendees: []\n---\n\n# Agenda\n\n- \n\n# Decisions\n",
  "templates/person.md": `${front("template")}# About\n`,
  "people/ana.md": `${front("person")}Ana works on the editor.\n`,
});

const types = (s) => s.texts("#dialog .newpage-type .newpage-name");
const created = (s, name) => s.win.waitForFunction((n) => document.querySelector(".card-title")?.textContent === n, name);

async function ask(s, how = "Control+n") {
  if (how === "button") await s.win.click("#new-page");
  else await s.key(how);
  await s.win.waitForSelector("#dialog #newpage-input");
}

suite("New page mod: a type for each page", files, (test) => {
  test("Ctrl+N asks for a name and lists the types: Page first, then each template with its description", async (s) => {
    await s.win.click(".cm-content");
    await ask(s);
    assert.equal(await s.win.evaluate(() => document.activeElement?.id), "newpage-input");
    assert.deepEqual(await types(s), ["Page", "meeting", "person"]);
    const meeting = await s.win.textContent('#dialog .newpage-type:has-text("meeting")');
    assert.match(meeting, /Notes of a talk/);
    assert.equal(await s.win.getAttribute("#dialog .newpage-type >> nth=0", "aria-checked"), "true");
    await s.key("Escape");
    assert.equal(await s.win.$("#dialog"), null);
  });

  test("the sidebar button and the palette lead to the same picker", async (s) => {
    await ask(s, "button");
    await s.key("Escape");
    await s.key("Control+k");
    await s.win.waitForSelector("#palette");
    await s.type("New page");
    await s.key("Enter");
    await s.win.waitForSelector("#dialog #newpage-input");
    assert.deepEqual(await types(s), ["Page", "meeting", "person"]);
    await s.key("Escape");
  });

  test("a name alone makes a plain page, as it always did", async (s) => {
    await ask(s);
    await s.type("Sprint notes");
    await s.key("Enter");
    await created(s, "sprint-notes");
    assert.match(read(s.bundle, "sprint-notes.md"), /^---\ntype: concept\ntitle: "Sprint notes"\n---\n/);
    assert.equal(await s.win.$("#dialog"), null);
  });

  test("choosing a template copies it: its keys and text, the type and the title from the name", async (s) => {
    await ask(s);
    await s.win.click('#dialog .newpage-type:has-text("meeting")');
    assert.equal(await s.win.getAttribute('#dialog .newpage-type:has-text("meeting")', "aria-checked"), "true");
    // Choosing leaves the cursor in the name, so typing goes on.
    assert.equal(await s.win.evaluate(() => document.activeElement?.id), "newpage-input");
    await s.type("projects/Sprint review");
    await s.key("Enter");
    await created(s, "projects/sprint-review");
    const text = read(s.bundle, "projects/sprint-review.md");
    assert.match(text, /^---\ntype: meeting\n/);
    assert.match(text, /title: "Sprint review"/);
    assert.match(text, /attendees: \[\]/);
    assert.match(text, /# Agenda\n\n- \n\n# Decisions/);
    assert.match(await s.doc(), /# Decisions/);
  });

  test("the arrow keys in the name choose the type, and the next time starts on Page again", async (s) => {
    await ask(s);
    await s.key("ArrowDown");
    await s.key("ArrowDown");
    assert.equal(await s.win.getAttribute('#dialog .newpage-type:has-text("person")', "aria-checked"), "true");
    await s.key("ArrowDown");
    assert.equal(await s.win.getAttribute('#dialog .newpage-type:has-text("person")', "aria-checked"), "true");
    await s.key("ArrowUp");
    assert.equal(await s.win.getAttribute('#dialog .newpage-type:has-text("meeting")', "aria-checked"), "true");
    await s.type("Grace");
    await s.key("Enter");
    await created(s, "grace");
    assert.match(read(s.bundle, "grace.md"), /^---\ntype: meeting\n/);
    await ask(s);
    assert.equal(await s.win.getAttribute("#dialog .newpage-type >> nth=0", "aria-checked"), "true");
    await s.key("Escape");
  });

  test("a name that exists opens that page and keeps its text, whatever the type", async (s) => {
    await ask(s);
    await s.key("ArrowDown");
    await s.type("people/ana");
    await s.key("Enter");
    await created(s, "people/ana");
    assert.match(read(s.bundle, "people/ana.md"), /^---\ntype: person\n---\n\nAna works on the editor\.\n$/);
  });

  test("an empty or hidden name is refused with a reason, and the dialog stays", async (s) => {
    await ask(s);
    for (const bad of ["   ", ".secret/x", "../escape"]) {
      await s.win.fill("#newpage-input", bad);
      await s.key("Enter");
      await s.win.waitForSelector("#newpage-error:not([hidden])");
      assert.match(await s.win.textContent("#newpage-error"), /name/);
    }
    assert.equal(existsSync(join(s.bundle, ".secret")), false);
    assert.equal(existsSync(join(s.bundle, "..", "escape.md")), false);
    await s.key("Escape");
    assert.equal(await s.win.$("#dialog"), null);
  });

  test("templates written while the app runs are there the next time, and a bundle without any offers only Page", async (s) => {
    write(s.bundle, "templates/book.md", `${front("template")}# Notes\n`);
    await ask(s);
    assert.deepEqual(await types(s), ["Page", "book", "meeting", "person"]);
    await s.key("Escape");
  });

  test("a template named concept is what Page starts from", async (s) => {
    write(s.bundle, "templates/concept.md", "---\ntype: template\nsource: \n---\n\n# Why\n");
    await ask(s);
    assert.equal((await types(s))[0], "Page");
    assert.equal((await types(s)).filter((t) => t === "concept").length, 0);
    await s.type("Reasons");
    await s.key("Enter");
    await created(s, "reasons");
    assert.match(read(s.bundle, "reasons.md"), /^---\ntype: concept\n(?:.*\n)*?source: \n[\s\S]*# Why/);
  });
});

suite("New page mod: a bundle without templates", () => ({}), (test) => {
  test("only a name is asked for, and the page is plain", async (s) => {
    await ask(s);
    assert.deepEqual(await types(s), []);
    await s.type("Alone");
    await s.key("Enter");
    await created(s, "alone");
    assert.match(read(s.bundle, "alone.md"), /^---\ntype: concept\n/);
  });
});
