// The heading path of a position: the headings you are under, outermost first (`Project › Design › Risks`).
// It reads the page model's sections (`editor/ARCHITECTURE.md`, principle 1) and nothing else.
//
// A position is under a heading from that heading's line on, up to the next heading as high or higher,
// the blank lines before it included, so the path is the nearest heading above the position and the
// headings that hold it. Above the first heading, and in the front matter, it is empty.

import { headingText } from "./links";
import { type PageModel, type PageNode } from "./pageModel";

const sectionLists = new WeakMap<PageModel, readonly PageNode[]>();

/** The sections of a page in the order they start; made once for each model. */
function sectionsOf(model: PageModel): readonly PageNode[] {
  let list = sectionLists.get(model);
  if (!list) {
    list = model.nodes.filter((n) => n.kind === "section");
    sectionLists.set(model, list);
  }
  return list;
}

/** The sections that a position is under, the outermost first and the nearest last. */
export function headingPath(model: PageModel, pos: number): PageNode[] {
  const sections = sectionsOf(model);
  // The last section that starts at or before the position.
  let lo = 0;
  let hi = sections.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sections[mid]!.from <= pos) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0) return [];
  const last = sections[found]!;
  const path = [last];
  for (const a of last.ancestors()) if (a.kind === "section") path.push(a);
  return path.reverse();
}

/** What the bar shows for each heading on the path: its text without Markdown marks, and where it starts. */
export interface Crumb {
  text: string;
  from: number;
}

export function headingCrumbs(model: PageModel, pos: number): Crumb[] {
  return headingPath(model, pos).map((n) => ({ text: headingText(model.doc.line(n.startLine).text), from: n.from }));
}
