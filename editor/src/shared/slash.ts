// The `/` menu: things to insert without remembering their Markdown.

import { addDays, formatDate, formatDateTime } from "./dates";

export interface SlashItem {
  label: string;
  detail: string;
  /** What replaces the `/word` that was typed. */
  text: string;
  /** Where the cursor goes, as an offset into `text`. */
  cursor: number;
  /** Start of a line only (headings, lists...) or anywhere (dates, links). */
  where: "line" | "anywhere";
  /** Offer the concept suggestions right after inserting. */
  suggest?: boolean;
}

export function slashItems(now: Date): SlashItem[] {
  const line = (label: string, detail: string, text: string, cursor = text.length): SlashItem => ({
    label,
    detail,
    text,
    cursor,
    where: "line",
  });
  const date = (label: string, d: Date): SlashItem => ({
    label,
    detail: formatDate(d),
    text: formatDate(d),
    cursor: 10,
    where: "anywhere",
  });
  return [
    line("Heading 1", "# ", "# "),
    line("Heading 2", "## ", "## "),
    line("Heading 3", "### ", "### "),
    line("Bullet list", "- ", "- "),
    line("Numbered list", "1. ", "1. "),
    line("Task", "- [ ] ", "- [ ] "),
    line("Quote", "> ", "> "),
    line("Code block", "```", "```\n\n```", 4),
    line("Table", "| a | b |", "| Column | Column |\n| --- | --- |\n|  |  |", 2),
    line("Divider", "***", "***\n"),
    date("Today", now),
    date("Tomorrow", addDays(now, 1)),
    date("Yesterday", addDays(now, -1)),
    { label: "Now", detail: formatDateTime(now), text: formatDateTime(now), cursor: formatDateTime(now).length, where: "anywhere" },
    { label: "Link", detail: "[text](target)", text: "[]()", cursor: 1, where: "anywhere" },
    { label: "Tag", detail: "#concept", text: "#", cursor: 1, where: "anywhere", suggest: true },
  ];
}

/** Items whose label starts with, then contains, what was typed after the `/`. */
export function matchSlash(items: SlashItem[], typed: string, atLineStart: boolean): SlashItem[] {
  const q = typed.trim().toLowerCase();
  const usable = items.filter((i) => atLineStart || i.where === "anywhere");
  const words = (i: SlashItem) => i.label.toLowerCase();
  return [
    ...usable.filter((i) => words(i).startsWith(q)),
    ...usable.filter((i) => !words(i).startsWith(q) && words(i).includes(q)),
  ];
}
