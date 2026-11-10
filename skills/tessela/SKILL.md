---
name: tessela
description: Read, search and change a Tessela knowledge bundle (a folder of Markdown pages with `type` frontmatter, tags and links, journals, `home.md`). Use whenever you work inside a Tessela notes folder, or are asked to add, edit, move or delete a note, page or journal entry in one.
---

# Working in a Tessela bundle

A Tessela bundle is a plain [OKF](https://okf.md/) folder of Markdown files, synced with git. The full rules are in `docs/conventions.md` of the Tessela repo (sections are cited below as §N). The `tessela` command line tool and the editor read the same files, so what you write must pass `tessela lint`.

## The rule of thumb: tools first, files last

Use the `tessela` CLI for everything it can do, changes included. Pass `--json` when you will parse the output. The bundle is the folder you were pointed at (the read-only commands take it as a path argument, default `.`; the edit commands take `--bundle DIR`, default `.`).

| You want to | Run |
| --- | --- |
| Find where a topic is mentioned (backlinks) | `tessela query . --ref NAME [--json]` |
| Search text, a page or folder, a page type, a date range | `tessela query . --text WORDS`, `--page folder/`, `--type journal`, `--from/--to YYYY-MM-DD` |
| List tasks (checkbox items), open or done, with their dates | `tessela query . --task open [--from/--to YYYY-MM-DD] [--ref NAME]`; `--task done` and `--task any` too; each hit has `task` |
| Find text that names a page but does not link it (to link it) | `tessela query . --unlinked NAME --json`: blocks with `mentions` (`text`, `line`, `column`, `link`); skips blocks that already reach the page; fix with a patch through `save` |
| See what a folder holds | `tessela index . [--dir folder] [--recursive]` (prints; writes nothing; `--recursive` lists every page below the folder, sub-folders included) |
| List every page with its title and type | `tessela pages . --json` (`pages`: `id`, `path`, `title`, `type`; sorted by path) |
| Follow changes as they happen | `tessela watch . --json [--exit-on-stdin-close]` (one JSON line per burst: `{"event":"changed","paths":[...]}`; runs until stopped) |
| See every command, argument and answer shape | `tessela schema` (one JSON document: `commands.NAME.args`, `commands.NAME.answer` as JSON Schema) |
| Pick an existing tag or concept instead of inventing one | `tessela vocab . [--unwritten] [--prefix project/]` |
| Check your work | `tessela lint . [--strict] [--json]` |
| Run a live list (the body of a ```` ```tessela ```` fence) | `tessela fence -b . --json < body.txt`: one read-only command (`query`, `index`, `vocab`, `lint`), then built-in filters (`rg`, `sed`, `sort`, `uniq`, `head`, `wc`); never a shell |
| Import a Logseq graph into a new bundle | `tessela import-logseq GRAPH OUT` |
| Add, edit, rename, move or remove a page | the edit commands, next section |

Search with `tessela query` before you reach for `rg` or `grep`: each hit is a block with its file, line, handle and heading, and filters combine with AND. Use `--limit N` to cut the output; piping into `head` also works.

What `tessela query` does not do, so `rg` over the Markdown files is the fallback:

- `--text` is one literal phrase, case-insensitive: no regex, no words in any order, and only one `--text` per query.
- `--text` reads block text, not frontmatter, so `title`, `role`, `team` and other keys are not searched by words. `--ref` does match a page's `tags` and the links in its other frontmatter text.
- `--type` returns blocks, so a page with no body text is missing. `tessela index . --dir FOLDER --recursive --json` lists every page below a folder, with its title and type.
- `--ref NAME` takes a page id, a title or an alias from a page's frontmatter `aliases`. An alias finds the page's backlinks plus the blocks that use the alias itself, but the page id does not find blocks that use an alias, and an alias that several pages share finds all of them. It also matches concepts nested under it (`--ref project` finds `project/tessela`). `--own` drops blocks that only inherit it from a parent item or heading.

## Changing pages: always through the CLI

Adding, editing, renaming, moving and deleting pages all go through the `tessela` edit commands. They are the same door the editor uses, so every writer follows the same safety rules: no overwriting a change you have not seen, atomic writes, and renames that keep links and tags working. **Do not edit the Markdown files directly** (no `sed -i`, no redirecting into a page, no `mv`/`rm` on pages) unless the CLI is missing (see the end of this section).

All of them take `--bundle DIR` (default `.`) and the page as a path relative to the bundle, with or without `.md`. Add `--json` and `--api 2` when you parse the output: the answer is `{"api": 2, "ok": true, ...}` or `{"api": 2, "ok": false, "error": {"code", "message"}}`, and `--api 2` makes the tool refuse if it speaks another version. This holds for the read commands too (`query` answers `hits` and `total`, `vocab` `concepts`, `lint` `diagnostics`, `index` the listing), which take `--api` as well. Run `tessela api` if unsure.

| You want to | Run |
| --- | --- |
| Read a page and get its hash | `tessela read -b . PAGE --json` (`hash`, `text`; `exists: false` and a template for a new page) |
| Create a page | `tessela add -b . "Machine Learning" [--title T] [--type howto]` (add `--stdin` to send the whole text) |
| Replace a page | `tessela save -b . PAGE --expect HASH < new-text.md` (`--expect new` when it must not exist yet) |
| Change a few lines | `tessela save -b . PAGE --expect HASH --patch < changes.diff` (a unified diff, from `diff -u old new` or `git diff`; it must apply exactly) |
| Rename (same folder) | `tessela rename -b . PAGE NEW-NAME [--dry-run]` |
| Move to another folder or path | `tessela move -b . PAGE folder/ [--dry-run]` or `... PAGE new/path` |
| Delete | `tessela remove -b . PAGE --expect HASH` |
| Store a picture or file | `tessela attach -b . PAGE [--file F \| < bytes] [--ext png]`, then link it as `![what it shows](/assets/NAME)` (named after the page plus a hash of the content) |

### The workflow for every change

1. **Read right before you change**: `tessela read ... --json` gives the `hash` of what is on disk. Others (the editor, git, other agents) may have touched the page, so never reuse an old hash.
2. **Send the change with that hash** (`--expect HASH`). Change only what you were asked to; keep every other byte, including frontmatter keys you do not know (§2). Do not reformat, re-wrap or reorder.
3. **On a `conflict` error (exit code 3)**, the page changed since you read it. Read it again (the error also carries `disk_hash`), redo your edit on the new text, and save again. Never retry with a made-up hash and do not delete-and-add to get around it.
4. **Run `tessela lint .`** afterwards and fix every error and warning you caused.

For a whole-page edit, write the new text to a temporary file and send it with `< file`. For a fine-grained edit, copy the page text to a temporary file, edit the copy, and make the patch with `diff -u`; the patch then applies exactly to the text you read. If `save --patch` says the patch does not apply, read the page again and rebuild the patch.

### Add a page

`tessela add -b . "Machine Learning"` picks the file name for you: the name lowercased with whitespace runs turned into `-`, and a `/` means a folder (§4). `Machine Learning` becomes `machine-learning.md`, `#project/tessela` becomes `project/tessela.md`. It fails with `exists` when the page is there, and refuses `index` and `log` (reserved). The new page starts with `type: concept` and a `title` that keeps your spelling; pass `--type` for another OKF type (`howto`, `reference`, `decision`, ...). First check the name is new with `tessela vocab . --prefix ...` and `tessela query . --page the/path`. To create it with its text in one step: `tessela add -b . NAME --stdin < page.md`. Add the content afterwards by reading the page and saving with its hash.

### Journal entries

One file per day at `journals/YYYY-MM-DD.md` with `type: journal`, and `title` and `date` both set to the day, quoted (§6). `tessela add -b . journals/2026-11-04` makes exactly that. Create the file only when you have something to write in it. Append new blocks at the end; do not rewrite the day.

### Modify a page

Edit the block or frontmatter key you were asked to, nothing else. Datetimes are written `2026-10-27 14:30:00-03:00` (space, not `T`, and an offset), and quoted in frontmatter (§7). Tags are lowercase.

### Remove a page

`tessela remove` says in `mentioned_by` which pages still mention the removed one. Links to a missing page are allowed (they read as "mentioned, not written yet", §4), but tell the user what is left pointing at it, and do not delete a page someone has not asked you to delete. Git is the undo, so make sure the user can see the removal in the diff rather than hiding it in a bigger change.

### Rename or move a page

`rename` and `move` rewrite every tag and link that names the page, in every page, and keep the moved page's own relative links working. Run it with `--dry-run` first to see which pages change; it needs no hash unless you pass `--expect`. If the dry run touches many pages, ask the user before running it for real. Afterwards run `tessela lint .`. The `warnings` in the answer list links it could not rewrite (written with escapes); fix those by hand with `read` and `save`. Folders and tags nested below the page (`#old/child`) are separate pages and do not move.

### If the CLI has no edit commands

An older `tessela` (no `read`/`save` in `tessela --help`, or an `api-mismatch` error) cannot do the above. Say so to the user once, update it if you can, and only if you cannot, edit the Markdown by hand, following the same rules: read the page right before you change it, change only what you target, write a temporary file in the same folder and rename it over the page, do not overwrite a file that changed since you read it, and run `tessela lint .` afterwards.

## Rules that are easy to break

- **No generated files.** Never write `index.md` or `log.md` yourself or with `tessela index --write` (`tessela add` refuses those names too), and never keep a hand-made table of contents that a query could produce. Listings are computed: use `tessela index`. A hand-written `index.md`/`log.md` that already exists stays as it is (§1).
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
