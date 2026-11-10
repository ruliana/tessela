// The folders mod: a view of one folder at a time, from the root down. It shows where the folder
// starts (its hand-written `home.md` and the pages that links to), then what is computed from the
// notes by `tessela index --dir`: sub-folders, pages with their descriptions, journal days.
// Nothing is saved: a folder without a home page only offers to write one.

import type { ModContext } from "../../renderer/mods";
import { cliOf, failureText } from "../kit";
import { type Listing, type PageEntry, cleanDir, folderOf, homePath, homeTitle, JOURNAL_SHOWN, leaf, pagesIn, trail } from "./plan";

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] =>
  Object.assign(document.createElement(tag), { className, textContent: text });

export default function (ctx: ModContext): void {
  const openFolder = (dir: string) => void ctx.views.open("folders", dir);
  const openPage = (path: string) => void ctx.pages.open(path);

  const button = (className: string, text: string, run: () => void): HTMLButtonElement => {
    const b = node("button", className, text);
    b.addEventListener("click", run);
    return b;
  };

  const pageRow = (page: PageEntry): HTMLElement => {
    const row = button("folders-page", "", () => openPage(page.path));
    row.append(node("span", "folders-title", leaf(page.path).replace(/\.md$/, "")));
    if (page.type) row.append(node("span", "folders-type", page.type));
    if (page.description) row.append(node("span", "folders-description", page.description));
    return row;
  };

  const section = (className: string, heading: string, ...children: HTMLElement[]): HTMLElement => {
    const el = node("section", `folders-section ${className}`);
    el.append(node("h3", "", heading), ...children);
    return el;
  };

  async function writeHome(dir: string): Promise<void> {
    const answer = await cliOf(ctx)<{ path: string }>(["add", homePath(dir), "--type", "home", "--title", homeTitle(dir)]);
    if (!answer.ok) return ctx.ui.toast(`Could not write the home page: ${failureText(answer)}`);
    await ctx.pages.open(answer.path);
  }

  function draw(container: HTMLElement, listing: Listing): void {
    const dir = listing.dir;
    const crumbs = node("nav", "folders-crumbs");
    const ancestors = trail(dir).slice(0, -1);
    for (const [i, c] of ancestors.entries()) {
      if (i > 0) crumbs.append(node("span", "folders-sep", "›"));
      crumbs.append(button("folders-crumb", c.name === "" ? "Notes" : c.name, () => openFolder(c.path)));
    }
    const here = node("h2", "folders-here", dir === "" ? "Notes" : dir);

    const where: HTMLElement[] = [];
    if (listing.home) {
      const home = listing.home;
      const open = button("folders-open-home", `Open ${home}`, () => openPage(home));
      const start = node("div", "folders-start");
      for (const page of listing.links) start.append(pageRow(page));
      where.push(section("folders-where", "Start here", open, ...(listing.links.length > 0 ? [start] : [])));
    } else {
      where.push(
        section(
          "folders-where",
          "Start here",
          node("p", "folders-empty", "This folder has no home page yet."),
          button("folders-write-home", `Write ${homePath(dir)}`, () => void writeHome(dir)),
        ),
      );
    }

    const folders = listing.folders.map((f) => {
      const row = button("folders-folder", "", () => openFolder(f.path));
      row.append(node("span", "folders-title", `${leaf(f.path)}/`), node("span", "folders-count", pagesIn(f.pages)));
      if (f.has_home) row.append(node("span", "folders-type", "home"));
      return row;
    });
    const journal = listing.journal.slice(0, JOURNAL_SHOWN).map(pageRow);
    const more = listing.journal.length - journal.length;
    if (more > 0) journal.push(node("p", "folders-empty", `and ${more} more`));

    container.replaceChildren(
      crumbs,
      here,
      ...where,
      ...(folders.length > 0 ? [section("folders-folders", "Folders", ...folders)] : []),
      ...(listing.pages.length > 0 ? [section("folders-pages", "Pages", ...listing.pages.map(pageRow))] : []),
      ...(journal.length > 0 ? [section("folders-journal", "Journal", ...journal)] : []),
    );
  }

  let run = 0;
  ctx.views.add({
    id: "folders",
    label: "Folders",
    glyph: "▤",
    title: "Browse the notes folder by folder, starting from each one's home page",
    async render(container, { arg }) {
      const dir = cleanDir(arg);
      const mine = ++run;
      const answer = await cliOf(ctx)<Listing>(["index", "--dir", dir]);
      if (mine !== run) return;
      if (!answer.ok) return void container.replaceChildren(node("p", "folders-error", failureText(answer)));
      draw(container, answer);
    },
  });

  ctx.commands.add({
    id: "folders.show",
    label: "Show folders",
    run: () => {
      const path = ctx.pages.current();
      return ctx.views.open("folders", path ? folderOf(path) : "");
    },
  });
  ctx.slots.add("page-menu", { label: "Show folder", run: ({ path }) => ctx.views.open("folders", folderOf(path)) });
}
