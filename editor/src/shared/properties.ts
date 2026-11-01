// The properties of a page: what its front matter says, in the few lines that a reader
// needs (title, type, tags, when). The editor draws these in place of the YAML until the
// front matter is edited.

import { frontmatterEnd } from "./blocks";
import { normalizeConcept } from "./links";

export interface Properties {
  title: string | null;
  type: string | null;
  tags: string[];
  /** The date or datetime of the page, as written, and which key it came from. */
  when: { key: string; value: string } | null;
  /** Other simple `key: value` lines, in order. */
  others: { key: string; value: string }[];
}

const WHEN_KEYS = ["timestamp", "date"];

function unquote(value: string): string {
  const v = value.trim();
  const m = /^(["'])(.*)\1$/.exec(v);
  if (!m) return v;
  return m[1] === '"' ? m[2]!.replace(/\\(["\\])/g, "$1") : m[2]!.replace(/''/g, "'");
}

/** Reads the front matter lines (between the two `---` lines, so `lines[0]` is the opener). */
export function parseProperties(lines: string[], end: number): Properties {
  const props: Properties = { title: null, type: null, tags: [], when: null, others: [] };
  let inTags = false;
  for (let i = 1; i < end; i++) {
    const text = lines[i] ?? "";
    const key = /^([\w-]+):(.*)$/.exec(text);
    if (key) {
      const name = key[1]!;
      const value = key[2]!.trim();
      inTags = name === "tags";
      if (inTags) {
        if (value.startsWith("[")) {
          for (const part of value.replace(/^\[|\]\s*$/g, "").split(",")) {
            const tag = normalizeConcept(unquote(part));
            if (tag !== "") props.tags.push(tag);
          }
          inTags = false;
        } else if (value !== "") {
          const tag = normalizeConcept(unquote(value));
          if (tag !== "") props.tags.push(tag);
        }
      } else if (name === "title") props.title = unquote(value) || null;
      else if (name === "type") props.type = unquote(value) || null;
      else if (WHEN_KEYS.includes(name)) {
        const v = unquote(value);
        const current = props.when && WHEN_KEYS.indexOf(props.when.key);
        // The timestamp is the more exact of the two.
        if (v !== "" && (props.when === null || WHEN_KEYS.indexOf(name) < (current ?? 99))) props.when = { key: name, value: v };
      } else if (value !== "" && !value.startsWith("[") && !value.startsWith("{") && !/^[|>]/.test(value)) {
        props.others.push({ key: name, value: unquote(value) });
      }
      continue;
    }
    const item = inTags ? /^\s*-\s+(.+?)\s*$/.exec(text) : null;
    if (item) {
      const tag = normalizeConcept(unquote(item[1]!));
      if (tag !== "") props.tags.push(tag);
    } else if (text.trim() !== "" && !/^\s/.test(text)) inTags = false;
  }
  return props;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-10-27` as `27 Oct 2026`, and `2026-10-27 09:00:00-03:00` as `27 Oct 2026, 09:00`. Others stay as written. */
export function showWhen(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(value);
  if (!m) return value;
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return value;
  const day = `${Number(m[3])} ${month} ${m[1]}`;
  return m[4] ? `${day}, ${m[4]}:${m[5]}` : day;
}

/** Whether the first line of the body is `# title`, so the page title need not be drawn twice. */
export function bodyRepeatsTitle(lines: string[], end: number, title: string | null): boolean {
  if (title === null) return false;
  for (let i = end + 1; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t === "") continue;
    const h = /^#\s+(.+?)\s*#*$/.exec(t);
    return h !== null && h[1]!.trim().toLowerCase() === title.trim().toLowerCase();
  }
  return false;
}

/** Where the cursor should start in `text`: the first line of the body, after a heading that is the title. */
export function bodyStart(text: string): number {
  const lines = text.split("\n");
  const end = frontmatterEnd(lines);
  if (end < 0) return 0;
  let i = end + 1;
  while (i < lines.length - 1 && lines[i]!.trim() === "") i++;
  if (bodyRepeatsTitle(lines, end, parseProperties(lines, end).title)) {
    i++;
    while (i < lines.length - 1 && lines[i]!.trim() === "") i++;
  }
  let offset = 0;
  for (let n = 0; n < i; n++) offset += lines[n]!.length + 1;
  return Math.min(offset, text.length);
}
