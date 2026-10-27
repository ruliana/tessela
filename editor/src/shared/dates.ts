// Dates and datetimes the way the spec writes them (§7): `2026-10-27`, and
// `2026-10-27 14:30:00-03:00` with a space and a UTC offset.

const p2 = (n: number) => String(n).padStart(2, "0");

export function formatDate(d: Date): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** Local time with its UTC offset, e.g. `2026-10-27 14:30:00-03:00`. */
export function formatDateTime(d: Date): string {
  const offset = -d.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  const time = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  return `${formatDate(d)} ${time}${sign}${p2(Math.floor(abs / 60))}:${p2(abs % 60)}`;
}

export function addDays(d: Date, days: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + days);
  return next;
}

function validDay(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(y, m, 0).getDate();
}

export interface DateAt {
  from: number;
  to: number;
  kind: "date" | "datetime";
}

const DATE = /(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?)?(?![\d])/g;

/** Real dates and datetimes in a line. `2026-13-01` and `12026-10-27` are not dates. */
export function datesInLine(line: string): DateAt[] {
  const found: DateAt[] = [];
  for (const m of line.matchAll(DATE)) {
    const [, y, mo, d, h, mi] = m;
    if (!validDay(Number(y), Number(mo), Number(d))) continue;
    if (h !== undefined && (Number(h) > 23 || Number(mi) > 59)) {
      // Not a time: the date alone still counts.
      found.push({ from: m.index ?? 0, to: (m.index ?? 0) + 10, kind: "date" });
      continue;
    }
    const from = m.index ?? 0;
    found.push({ from, to: from + m[0].length, kind: h === undefined ? "date" : "datetime" });
  }
  return found;
}
