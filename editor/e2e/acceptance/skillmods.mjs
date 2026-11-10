// The mod-writing skill (skills/tessela-mods/SKILL.md): the mods it shows as complete examples are
// installed as they are written there, and the editor loads and runs them. If an agent can follow
// the skill alone and get a working mod, so can these.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { front, root, suite } from "../harness.mjs";

/** The `// mods/<id>/main.js` code blocks of the skill, by id. */
function examples() {
  const skill = readFileSync(resolve(root, "../skills/tessela-mods/SKILL.md"), "utf8");
  const found = {};
  for (const m of skill.matchAll(/```js\n\/\/ mods\/([\w.-]+)\/main\.js\n([\s\S]*?)```/g)) found[m[1]] = m[2];
  return found;
}

const mods = examples();

const files = () => ({
  "alpha.md": `${front()}Tagged #rust and #go.\n`,
  "beta.md": `${front()}Tagged #rust.\n\n\`\`\`shout\nquiet words\n\`\`\`\n`,
});

suite("The mods in the mod-writing skill", files, (test) => {
  test("the skill has the three examples", () => {
    assert.deepEqual(Object.keys(mods).sort(), ["neighbours", "shout", "stamp"]);
  });

  test("they all load", async (s) => {
    await s.key("Control+k");
    await s.win.locator("#palette").waitFor();
    await s.type("Show the mods");
    await s.key("Enter");
    const text = await s.win.textContent("#notice");
    for (const id of Object.keys(mods)) assert.ok(text.includes(id), text);
    assert.ok(!/Failed/.test(text), text);
  });

  test("stamp: its keys put today's date in the page", async (s) => {
    await s.open("alpha");
    await s.key("Control+Alt+d");
    assert.match(await s.body(), /\d{4}-\d{2}-\d{2}/);
  });

  test("shout: the fence is drawn in capitals under it", async (s) => {
    await s.open("beta");
    await s.win.waitForFunction(() => document.querySelector(".shout-out")?.textContent === "QUIET WORDS");
  });

  test("neighbours: a group in the right column, from the CLI", async (s) => {
    await s.open("alpha");
    await s.win.waitForFunction(() => document.querySelector(".bl-group.neighbours h3")?.textContent === "Neighbours");
  });
}, { mods });

suite("AGENTS.md in the config folder", files, (test) => {
  test("the app writes the mod-writing guide next to the mods, and it describes ctx", async (s) => {
    const text = readFileSync(resolve(s.profile, "AGENTS.md"), "utf8");
    assert.ok(text.startsWith("<!-- "), text.slice(0, 80));
    assert.ok(text.includes("# Writing a mod for the Tessela editor") && text.includes("ctx.commands.add"));
  });
});
