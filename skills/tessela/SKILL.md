---
name: tessela
description: Read, search and change a Tessela knowledge bundle (a folder of Markdown pages with `type` frontmatter, tags and links, journals, `home.md`). Use whenever you work inside a Tessela notes folder, or are asked to add, edit, move or delete a note, page or journal entry in one.
---

# Working in a Tessela bundle

A Tessela bundle is a plain [OKF](https://okf.md/) folder of Markdown files, synced with git. The full rules are in `docs/conventions.md` of the Tessela repo (sections are cited below as §N). The `tessela` command line tool and the editor read the same files, so what you write must pass `tessela lint`.

## The rule of thumb: tools first, files last

Use the `tessela` CLI for everything it can do. Pass `--json` when you will parse the output. The bundle is the folder you were pointed at (the CLI takes it as a path argument, default `.`).

| You want to | Run |
| --- | --- |
| Find where a topic is mentioned (backlinks) | `tessela query . --ref NAME [--json]` |
| Search text, a page or folder, a page type, a date range | `tessela query . --text WORDS`, `--page folder/`, `--type journal`, `--from/--to YYYY-MM-DD` |
| See what a folder holds | `tessela index . [--dir folder] [--recursive]` (prints; writes nothing; `--recursive` lists every page below the folder, sub-folders included) |
| Pick an existing tag or concept instead of inventing one | `tessela vocab . [--unwritten] [--prefix project/]` |
| Check your work | `tessela lint . [--strict] [--json]` |
| Import a Logseq graph into a new bundle | `tessela import-logseq GRAPH OUT` |

Search with `tessela query` before you reach for `rg` or `grep`: each hit is a block with its file, line, handle and heading, and filters combine with AND. Use `--limit N` to cut the output; piping into `head` also works.

What `tessela query` does not do, so `rg` over the Markdown files is the fallback:

- `--text` is one literal phrase, case-insensitive: no regex, no words in any order, and only one `--text` per query.
- It reads block text, not frontmatter, so `title`, `role`, `team` and other keys are not searched (`--ref` does match a page's `tags`).
- `--type` returns blocks, so a page with no body text is missing. `tessela index . --dir FOLDER --recursive --json` lists every page below a folder, with its title and type.
- `--ref NAME` takes a page id, a title or an alias from the page's frontmatter `aliases`: all find the same backlinks. It also matches concepts nested under it (`--ref project` finds `project/tessela`). `--own` drops blocks that only inherit it from a parent item or heading.

## Structural changes: the CLI does not have them yet

The intent is that adding, modifying, removing and renaming pages all go through one CLI, shared by agents and the editor, so every writer follows the same safety rules. **That is not built.** Today `tessela` only has `lint`, `query`, `index`, `vocab` and `import-logseq`; there is no command to create, edit, move or delete a page. The editor writes files itself.

So, until those commands exist:

- Do not invent a `tessela add/edit/rename/rm` command, and do not look for one. If one shows up in `tessela --help`, prefer it over everything below.
- Make the change directly in the Markdown files, and follow the writing rules (§9) so you behave like the future CLI would:
  1. **Read the page right before you change it.** Others (the editor, git, other agents) may have touched it.
  2. **Change only what you target.** Leave every other byte of the file alone, including frontmatter keys you do not know (§2). Do not reformat, re-wrap or reorder.
  3. **Write atomically:** write a temporary file in the same folder, then rename it over the page. Never leave a half-written page.
  4. **Do not overwrite blindly.** If the file changed since you read it, read it again and redo the edit.
  5. **Run `tessela lint .` afterwards** and fix every error and warning you caused.
- Tell the user, once, when you do this, that the structural change was made by hand because the CLI has no command for it.

### Add a page

1. Choose the name and check it is new: `tessela vocab . --prefix ...` and `tessela query . --page the/path`.
2. The file name is the name lowercased with whitespace runs turned into `-`; a `/` in a tag or name means a folder (§4). `Machine Learning` becomes `machine-learning.md`, `#project/tessela` becomes `project/tessela.md`. No part may start with `.`. Do not name a page `index`, `log` or `home` (reserved).
3. Start from this, with the original spelling in `title`:

   ```markdown
   ---
   type: concept
   title: "Machine Learning"
   ---

   ```

   Other OKF types (`howto`, `reference`, `decision`, ...) are fine when they fit. `type` is required.
4. End the file with a single newline, LF line endings, UTF-8.

### Journal entries

One file per day at `journals/YYYY-MM-DD.md` with `type: journal`, and `title` and `date` both set to the day, quoted (§6). Create the file only when you have something to write in it. Append new blocks at the end; do not rewrite the day.

### Modify a page

Edit the block or frontmatter key you were asked to, nothing else. Datetimes are written `2026-10-27 14:30:00-03:00` (space, not `T`, and an offset), and quoted in frontmatter (§7). Tags are lowercase.

### Remove a page

Deleting a page can leave links to it. Before removing it, run `tessela query . --ref NAME` and tell the user what still points at it. Links to a missing page are allowed (they read as "mentioned, not written yet", §4), but do not delete a page someone has not asked you to delete. Git is the undo, so make sure the user can see the removal in the diff rather than hiding it in a bigger change.

### Rename or move a page

There is no safe automatic way yet: a rename must also rewrite every link and every tag that mentions the old name. Do it as: find all references with `tessela query . --ref OLD --json` (also grep for the old path in links), move the file, fix each reference, then run `tessela lint .` and `tessela query . --ref OLD` to confirm nothing is left. If this touches many pages, ask the user before starting.

## Rules that are easy to break

- **No generated files.** Never write `index.md` or `log.md` yourself or with `tessela index --write`, and never keep a hand-made table of contents that a query could produce. Listings are computed: use `tessela index`. A hand-written `index.md`/`log.md` that already exists stays as it is (§1).
- **`home.md` is hand-written, optional, per folder, `type: home`.** It is where reading starts for that folder: house rules, the important pages, links to deeper `home.md` files and to `AGENTS.md`. Nothing is inherited from the home pages above it. Open the one for the folder you work in on purpose, and follow its guidance. Only edit a `home.md` when asked. A link from a home page means "this page matters" (§1, §5).
- **`#` headings only.** No setext headings (a line of `---` or `===` under text). A heading also scopes the tags in it to every block below it (§3), so do not put a tag in a heading casually.
- **Links** are bundle-relative Markdown links: `[Machine learning](/machine-learning.md)`. No `[[wikilinks]]`. A link to a page that does not exist is fine.
- **Tags** are `#lowercase`, `#project/tessela` for namespaces. Before you invent one, check `tessela vocab .`, and honour `vocabulary.md` (aliases and deprecated terms) if the bundle has it.
- **Blocks** are paragraphs, list items (any depth), and top-level code, tables and quotes (§3). A list on the line right after a paragraph, with no blank line, belongs to that paragraph and inherits its tags. Keep a blank line when it should not.
- **Never put block IDs in the Markdown.** Handles (`page#9f2c41d0`) exist only in tool output.
- **`.tessela/` is a rebuildable cache** and is never committed. Do not edit it.
- **Lines and files:** LF endings, one trailing newline, UTF-8.

## Before you finish

1. `tessela lint . --strict` has no new findings from your change. (`tessela/unwritten-concept` is informational and fine.)
2. `git status` shows only the files you meant to change.
3. Commit only if asked. The bundle is synced with git and is single-user, so do not push unless asked either.
