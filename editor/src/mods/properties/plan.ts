// The properties mod, without the window: changing one key of a page's front matter and leaving
// every other byte alone, checking a date, and the choices the small editors offer.

import { frontmatterEnd } from "../../shared/blocks";
import { normalizeConcept } from "../../shared/links";
import { slashItems } from "../../shared/slash";

export type Edit =
  /** Gives `key` a new value; an empty one takes the key away (`type` always keeps one). */
  | { op: "set"; key: string; value: string }
  /** Writes the tag `from` as `to`, or takes it away when `to` is null or empty. */
  | { op: "tag"; from: string; to: string | null }
  /** Adds a tag after the others. */
  | { op: "tag-add"; tag: string };

type Style = "plain" | "double" | "single";

const styleOf = (value: string): Style => (value.startsWith('"') ? "double" : value.startsWith("'") ? "single" : "plain");

/** What YAML would read as something other than text, or would not read at all, when written plain. */
function plainSafe(value: string): boolean {
  if (value === "" || value !== value.trim()) return false;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(value)) return false;
  if (/: |\s#|:$/.test(value)) return false;
  return !/^(null|true|false|yes|no|on|off|~)$/i.test(value);
}

/** `value` as a YAML scalar, in the style the old one was written in when that can hold it. */
function scalar(value: string, style: Style): string {
  if (style === "plain" && plainSafe(value)) return value;
  if (style === "single" && !/[\n\r]/.test(value)) return `'${value.replace(/'/g, "''")}'`;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function unquote(raw: string): string {
  const v = raw.trim();
  const m = /^(["'])(.*)\1$/.exec(v);
  if (!m) return v;
  return m[1] === '"' ? m[2]!.replace(/\\(["\\])/g, "$1") : m[2]!.replace(/''/g, "'");
}

const keyLine = (line: string, key: string): RegExpExecArray | null => {
  const m = /^([\w-]+):(.*)$/.exec(line);
  return m && m[1] === key ? m : null;
};

/** Whether the lines after `i` (before `end`) belong to the key on line `i`: a nested value or a block scalar. */
const continues = (lines: string[], i: number, end: number): boolean => i + 1 < end && /^\s+\S|^-\s/.test(lines[i + 1] ?? "");

/**
 * Applies one edit to a page's text. The answer is the new text, the same text when nothing needs to
 * change, or null when the edit cannot be made without guessing (no front matter, a key written
 * across several lines, a comment on the line): the caller then leaves the page alone.
 */
export function applyEdit(text: string, edit: Edit): string | null {
  const lines = text.split("\n");
  const end = frontmatterEnd(lines);
  if (end < 1) return null;
  const done = (): string => lines.join("\n");
  if (edit.op === "set") {
    for (let i = 1; i < end; i++) {
      const m = keyLine(lines[i] ?? "", edit.key);
      if (!m) continue;
      const raw = m[2]!;
      const old = raw.trim();
      if (continues(lines, i, end) || (styleOf(old) === "plain" && /\s#/.test(old))) return null;
      const value = edit.value.trim();
      if (value === "") {
        if (edit.key === "type") return null;
        lines.splice(i, 1);
      } else {
        lines[i] = `${edit.key}:${/^\s*/.exec(raw)![0] || " "}${scalar(value, styleOf(old))}`;
      }
      return done();
    }
    return null;
  }
  return editTags(lines, end, edit) ? done() : null;
}

interface Token {
  lead: string;
  raw: string;
  trail: string;
}

/** The tags of the front matter edited in place (the lines change); false when the key is too unusual. */
function editTags(lines: string[], end: number, edit: Extract<Edit, { op: "tag" | "tag-add" }>): boolean {
  const at = edit.op === "tag" ? normalizeConcept(edit.from) : normalizeConcept(edit.tag);
  const to = edit.op === "tag" ? (edit.to === null ? "" : normalizeConcept(edit.to)) : at;
  let i = 1;
  while (i < end && !keyLine(lines[i] ?? "", "tags")) i++;
  if (i === end) {
    if (edit.op !== "tag-add" || at === "") return edit.op === "tag-add";
    lines.splice(end, 0, `tags: [${at}]`);
    return true;
  }
  const head = /^(tags:\s*)(.*)$/.exec(lines[i]!)!;
  const value = head[2]!.trim();
  const write = (raw: string, name: string) => scalar(name, styleOf(raw));
  const lead = /\s$/.test(head[1]!) ? head[1]! : `${head[1]} `;

  // `tags: [a, b]` and `tags: a`: the tokens of one line.
  if (value !== "") {
    let tokens: Token[];
    let wrap: (inner: string) => string;
    if (value.startsWith("[")) {
      const m = /^(tags:\s*)\[(.*)\](\s*)$/.exec(lines[i]!);
      if (!m) return false;
      tokens = m[2]!.trim() === "" ? [] : m[2]!.split(",").map((t) => ({ lead: /^\s*/.exec(t)![0], raw: t.trim(), trail: /\s*$/.exec(t)![0] }));
      wrap = (inner) => `${m[1]}[${inner}]${m[3]}`;
    } else {
      if (/\s#/.test(value) || /^[|>]/.test(value)) return false;
      tokens = [{ lead: "", raw: value, trail: "" }];
      wrap = (inner) => `${head[1]}${inner}`;
    }
    const names = tokens.map((t) => normalizeConcept(unquote(t.raw)));
    if (edit.op === "tag-add") {
      if (names.includes(at)) return true;
      tokens.push({ lead: tokens.length > 0 ? " " : "", raw: at, trail: "" });
    } else {
      const k = names.indexOf(at);
      if (k < 0) return false;
      if (to === "") {
        const [gone] = tokens.splice(k, 1);
        if (k === 0 && tokens[0]) tokens[0].lead = gone!.lead;
      } else if (!names.includes(to) || to === at) tokens[k] = { ...tokens[k]!, raw: write(tokens[k]!.raw, to) };
      else tokens.splice(k, 1);
    }
    const inner = tokens.map((t) => t.lead + t.raw + t.trail).join(",");
    // A one-tag scalar that gains or loses a tag becomes a list.
    lines[i] = value.startsWith("[") ? wrap(inner) : tokens.length === 1 && edit.op === "tag" ? wrap(tokens[0]!.raw) : `${head[1]}[${inner}]`;
    return true;
  }

  // A list below the key: one `- tag` line each.
  const items: { line: number; prefix: string; raw: string }[] = [];
  for (let j = i + 1; j < end; j++) {
    const m = /^(\s*-\s+)(.+?)\s*$/.exec(lines[j] ?? "");
    if (!m) break;
    items.push({ line: j, prefix: m[1]!, raw: m[2]! });
  }
  if (items.some((it) => /\s#/.test(it.raw))) return false;
  const names = items.map((it) => normalizeConcept(unquote(it.raw)));
  if (edit.op === "tag-add") {
    if (names.includes(at)) return true;
    const last = items[items.length - 1];
    if (last) lines.splice(last.line + 1, 0, `${last.prefix}${at}`);
    else lines[i] = `${lead}[${at}]`;
    return true;
  }
  const k = names.indexOf(at);
  if (k < 0) return false;
  const item = items[k]!;
  if (to === "" || (names.includes(to) && to !== at)) {
    if (items.length === 1) {
      lines.splice(item.line, 1);
      lines[i] = `${lead}[]`;
    } else lines.splice(item.line, 1);
  } else lines[item.line] = `${item.prefix}${write(item.raw, to)}`;
  return true;
}

/**
 * A date or datetime as the conventions write it (`2026-10-27`, `2026-10-27 14:30:00-03:00`), from
 * what was typed, or null when it is neither. A time needs its offset, and a `T` becomes a space.
 */
export function validWhen(typed: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*(Z|[+-]\d{2}:?\d{2}))?$/.exec(typed.trim());
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (m[4] === undefined) return date;
  if (Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6] ?? 0) > 59) return null;
  const zone = m[7] === "Z" ? "Z" : m[7]!.replace(/^([+-]\d{2}):?(\d{2})$/, "$1:$2");
  return `${date} ${m[4]}:${m[5]}:${m[6] ?? "00"}${zone}`;
}

/** The types the notes use, for the type chip: every type of a page, `concept` too, most written first. */
export function knownTypes(pages: { type?: string | null }[]): string[] {
  const count = new Map<string, number>([["concept", 0]]);
  for (const p of pages) if (p.type && p.type !== "journal") count.set(p.type, (count.get(p.type) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
}

/** The tags of the vocabulary that fit what was typed (starting with it first), leaving out those the page has. */
export function tagChoices(concepts: { concept: string; deprecated?: boolean }[], has: string[], typed: string, limit = 8): string[] {
  const q = normalizeConcept(typed);
  const taken = new Set(has);
  const usable = concepts.filter((c) => !c.deprecated && !taken.has(c.concept)).map((c) => c.concept);
  return [...usable.filter((c) => c.startsWith(q)), ...usable.filter((c) => !c.startsWith(q) && c.includes(q))].slice(0, limit);
}

/** The ready-made dates of the `/` menu, for the date chip. */
export function dateChoices(now: Date): { label: string; text: string }[] {
  const wanted = ["Today", "Tomorrow", "Yesterday", "Now"];
  const items = slashItems(now);
  return wanted.flatMap((label) => items.filter((i) => i.label === label).map((i) => ({ label, text: i.text })));
}
