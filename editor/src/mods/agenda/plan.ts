// The pure parts of the agenda mod: which tasks are due on a day, how a tick is written as a patch,
// and the month the strip draws. A task is a `- [ ]` item and a due date is a date written in it.

import { addDays, formatDate } from "../../shared/dates";

/** What the mod uses of a hit of `tessela query --task`. */
export interface TaskHit {
  handle: string;
  path: string;
  line: number;
  text: string;
  dates: string[];
  task?: "open" | "done" | null;
}

export interface Due {
  hit: TaskHit;
  /** The task's own (last) date. */
  date: string;
  overdue: boolean;
}

const DAY = /^(\d{4}-\d{2}-\d{2})$/;

/** The day a journal page is for, or null for any other page. */
export function dayOfJournal(path: string): string | null {
  return DAY.exec(/^journals\/([^/]+)\.md$/.exec(path)?.[1] ?? "")?.[1] ?? null;
}

/**
 * The open tasks to show on the journal `day`: those that name it, and, when it is `today`, the
 * ones whose dates have all passed. The page itself is left out (its tasks are right there), a
 * task is listed once, and overdue ones come first, oldest first.
 */
export function dueOn(hits: TaskHit[], day: string, today: string, page: string): Due[] {
  const seen = new Set<string>();
  const due: Due[] = [];
  for (const hit of hits) {
    if (hit.task !== "open" || hit.path === page || hit.dates.length === 0 || seen.has(hit.handle)) continue;
    const date = [...hit.dates].sort().at(-1) as string;
    const overdue = day === today && date < today;
    if (!overdue && !hit.dates.includes(day)) continue;
    seen.add(hit.handle);
    due.push({ hit, date, overdue });
  }
  return due.sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.date.localeCompare(b.date) || a.hit.path.localeCompare(b.hit.path) || a.hit.line - b.hit.line);
}

/** The day before `day` (`YYYY-MM-DD`), the last that is overdue when `day` is today. */
export function dayBefore(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return formatDate(addDays(new Date(y, m - 1, d), -1));
}

const BOX = /^(\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\](\s)/;

/** The line of a task with its box ticked, or null when the line is not an open task. */
export function ticked(line: string): string | null {
  const m = BOX.exec(line);
  if (!m || m[2] !== " ") return null;
  return `${m[1]}[x]${m[3]}${line.slice(m[0].length)}`;
}

/**
 * A unified diff that ticks the task on the 1-based `line` of `text`, for `tessela save --patch`.
 * Null when the line is not an open task that reads like the hit did (the page changed since).
 */
export function tickPatch(path: string, text: string, line: number, hitText: string): string | null {
  const lines = text.split("\n");
  const old = lines[line - 1];
  if (old === undefined) return null;
  const now = ticked(old);
  const first = hitText.split("\n")[0]?.trim() ?? "";
  if (now === null || !old.includes(first)) return null;
  const lastWithoutNewline = line === lines.length;
  const noEol = lastWithoutNewline ? "\\ No newline at end of file\n" : "";
  return `--- a/${path}\n+++ b/${path}\n@@ -${line},1 +${line},1 @@\n-${old}\n${noEol}+${now}\n${noEol}`;
}

export interface Cell {
  day: string;
  /** Day of the month. */
  n: number;
  file: boolean;
  mention: boolean;
  today: boolean;
}

export interface MonthView {
  title: string;
  /** From the first of the month to the last, as the cells of weeks that start on Monday: `pad` empty cells come first. */
  pad: number;
  cells: Cell[];
  /** First and last day of the month, for the queries. */
  from: string;
  to: string;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The month `year`-`month` (1-12), with which of its days have a file (`files`) or are only mentioned (`mentioned`). */
export function monthView(year: number, month: number, files: Set<string>, mentioned: Set<string>, today: string): MonthView {
  const count = new Date(year, month, 0).getDate();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const cells: Cell[] = [];
  for (let n = 1; n <= count; n++) {
    const day = `${year}-${p2(month)}-${p2(n)}`;
    cells.push({ day, n, file: files.has(day), mention: !files.has(day) && mentioned.has(day), today: day === today });
  }
  const weekday = new Date(year, month - 1, 1).getDay(); // 0 is Sunday
  return {
    title: `${MONTHS[month - 1]} ${year}`,
    pad: (weekday + 6) % 7,
    cells,
    from: cells[0]!.day,
    to: cells[count - 1]!.day,
  };
}

/** The month before or after `[year, month]`. */
export function shiftMonth([year, month]: [number, number], by: number): [number, number] {
  const index = year * 12 + (month - 1) + by;
  return [Math.floor(index / 12), (index % 12) + 1];
}
