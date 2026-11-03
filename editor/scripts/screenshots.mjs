// Takes the screenshots for the README into docs/screenshots/.
// Run with `npm run screenshots` (needs a display: `xvfb-run -a npm run screenshots` on a server).
// It builds a small sample bundle in a temporary folder, so the pictures never show real notes.
import { _electron as electron } from "playwright-core";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = resolve(root, "../docs/screenshots");
mkdirSync(out, { recursive: true });

const day = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const files = {
  "home.md": `---
type: home
title: Home
---

# Home

Where the knowledge starts. Pick a project, or read the journals for what happened lately.

- [Tessela](/project/tessela.md): the notes app this bundle is a sample of.
- [Reading list](/reading-list.md): papers and books waiting for their turn.
- Use the #rust and #okf pages to see what each idea is connected to.
`,
  "project/tessela.md": `---
type: project
title: Tessela
tags: [okf, rust]
---

# Tessela

A personal knowledge manager for humans and agents. Notes are plain Markdown in an [OKF](/okf.md) bundle, synced with git.

## Parts

- The \`tessela\` command line tool, written in #rust: lint, query, vocab, index.
- An Electron editor that calls the same tool behind the scenes.

## Open questions

- How should an agent find the right page first? A [home page](/home.md) per folder looks promising.
- Should the editor show the lint warnings next to the text? Yes, see 2026-10-27.
`,
  "okf.md": `---
type: concept
title: Open Knowledge Format
aliases: [OKF]
---

# Open Knowledge Format

A bundle is a folder of Markdown files with YAML front matter. There is no server and no database, so any tool, or any person with a text editor, can read it.

> A format that outlives the app that wrote it.

Tessela adds a few conventions on top, all additive. See [Tessela](/project/tessela.md).
`,
  "rust.md": `---
type: concept
title: Rust
---

# Rust

Used for the command line tools. Fast to start, one static binary, and the type system makes the parser rules easy to keep honest.
`,
  "reading-list.md": `---
type: concept
title: Reading list
---

# Reading list

- [x] *How to Take Smart Notes*, on keeping a slip box
- [ ] *Designing Data-Intensive Applications*, chapter on logs and replication
- [ ] The #okf specification, front to back
`,
  [`journals/${day(0)}.md`]: `---
type: journal
date: ${day(0)}
---

# ${day(0)}

Wrote the first draft of the README for #project/tessela.

- Took screenshots of the editor with a sample bundle
- The backlinks panel already shows who mentions [Tessela](/project/tessela.md)
- **Next**: try \`tessela lint\` on my real notes and fix what it finds

Lunch with a friend who uses #okf for her research notes. She asked if it works with her editor: it does, because it is only Markdown.
`,
  [`journals/${day(1)}.md`]: `---
type: journal
date: ${day(1)}
---

# ${day(1)}

Read a chapter of the [Reading list](/reading-list.md) book.

- Idea: a link from a home page means "this page matters"
- Idea: queries instead of generated index files, so nothing in the bundle is written by a tool
`,
  [`journals/${day(3)}.md`]: `---
type: journal
date: ${day(3)}
---

# ${day(3)}

Fixed a parsing bug in the #rust linter.

- Dates need a space instead of \`T\`
- Added a rule for deprecated tags
`,
};

// The folder name shows at the top of the sidebar, so give it a nice one.
const bundle = join(mkdtempSync(join(tmpdir(), "tessela-shots-")), "notes");
for (const [path, text] of Object.entries(files)) {
  mkdirSync(dirname(join(bundle, path)), { recursive: true });
  writeFileSync(join(bundle, path), text);
}

process.env.TESSELA_BIN ??= resolve(root, "../target/debug/tessela");
const profile = mkdtempSync(join(tmpdir(), "tessela-profile-"));
const app = await electron.launch({
  args: [join(root, "dist/main.cjs"), "--no-sandbox", `--user-data-dir=${profile}`, `--bundle=${bundle}`],
  env: { ...process.env },
});
const win = await app.firstWindow();
const size = { width: 1280, height: 800 };
await app.evaluate(({ BrowserWindow }, s) => {
  const w = BrowserWindow.getAllWindows()[0];
  w.setSize(s.width, s.height);
  w.center();
}, size);
await win.setViewportSize(size).catch(() => {});

const settle = async () => {
  await win.waitForSelector(".cm-content");
  await win.waitForTimeout(700);
};
const shot = async (name) => {
  await win.evaluate(() => document.activeElement?.blur()); // so no link is open for editing
  await win.mouse.move(0, 0);
  await win.screenshot({ path: join(out, name) });
  console.log("wrote", name);
};

// A page from the concepts list, with its backlinks.
const open = async (name) => {
  await win.click(`#pages li:has-text("${name}")`);
  await win.waitForFunction((n) => document.querySelector(".card-title")?.textContent === n, name);
  await win.waitForSelector("#backlinks .bl-group");
  await win.waitForTimeout(600);
};

await win.evaluate(() => localStorage.setItem("tessela.livePreview", "1"));
await win.reload();
await settle();

// 1. The journals, light.
await win.click("#theme-toggle"); // system -> light
await win.waitForTimeout(300);
await shot("journals.png");

// 2. A page and its backlinks: the home page's mention comes first and is marked.
await open("okf");
await shot("page-backlinks.png");

// 3. The same, dark.
await win.click("#theme-toggle"); // light -> dark
await win.waitForTimeout(300);
await open("project/tessela");
await shot("dark.png");

await app.close();
