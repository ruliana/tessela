// What the find box says about its matches: where the selection is among them, and how many there are.

export interface Range {
  from: number;
  to: number;
}

export interface Tally {
  /** The matches counted, never more than the cap. */
  total: number;
  /** More matches than the cap were left uncounted. */
  capped: boolean;
  /** The match the selection is on, counting from 1; 0 when it is on none. */
  current: number;
}

/** Counting stops here, so a one-letter search in a long page costs a bounded amount of work. */
export const COUNT_CAP = 999;

/** Takes the matches in page order and the selected range; stops reading once the cap is reached. */
export function tally(matches: Iterator<Range>, selection: Range, cap = COUNT_CAP): Tally {
  let total = 0;
  let current = 0;
  for (let next = matches.next(); !next.done; next = matches.next()) {
    if (total === cap) return { total, capped: true, current };
    total++;
    if (next.value.from === selection.from && next.value.to === selection.to) current = total;
  }
  return { total, capped: false, current };
}

/** "3/12" with the selection on a match, "12" without, "999+" when the count was cut, "" before anything is typed. */
export function countLabel(t: Tally | null): string {
  if (!t) return "";
  if (t.total === 0) return "none";
  const total = `${t.total}${t.capped ? "+" : ""}`;
  return t.current ? `${t.current}/${total}` : total;
}
