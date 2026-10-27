// Surrounding text with Markdown marks, and toggling a task: the edits behind Ctrl+B,
// Ctrl+I and friends. Pure functions on text, so they can be tested without an editor.

export interface TextEdit {
  /** Replace [from, to) with `insert`. */
  from: number;
  to: number;
  insert: string;
  /** The selection afterwards, in the new text. */
  anchor: number;
  head: number;
}

/** Wraps the selection; the selection stays on the inner text, so wrapping twice nests. */
export function surround(doc: string, from: number, to: number, open: string, close = open): TextEdit {
  const inner = doc.slice(from, to);
  return {
    from,
    to,
    insert: `${open}${inner}${close}`,
    anchor: from + open.length,
    head: from + open.length + inner.length,
  };
}

const WORD = /[\p{L}\p{N}_]/u;

function wordAround(doc: string, at: number): [number, number] {
  let a = at;
  let b = at;
  while (a > 0 && WORD.test(doc[a - 1]!)) a--;
  while (b < doc.length && WORD.test(doc[b]!)) b++;
  return [a, b];
}

function run(doc: string, from: number, step: 1 | -1, ch: string): number {
  let n = 0;
  for (let i = step === 1 ? from : from - 1; i >= 0 && i < doc.length && doc[i] === ch; i += step) n++;
  return n;
}

/**
 * Ctrl+B and friends. Marks the selection (or the word at the cursor) with `mark`, or takes
 * the mark off when it is already there. With nothing to mark it inserts the pair and puts
 * the cursor between them. `*` and `**` are told apart by counting the stars around the text.
 */
export function toggleMark(doc: string, from: number, to: number, mark: string): TextEdit {
  if (from === to) {
    const [a, b] = wordAround(doc, from);
    if (a === b) {
      return { from, to, insert: mark + mark, anchor: from + mark.length, head: from + mark.length };
    }
    from = a;
    to = b;
  }
  const len = mark.length;
  let present: boolean;
  if (mark[0] === "*") {
    const around = Math.min(run(doc, from, -1, "*"), run(doc, to, 1, "*"));
    present = len === 1 ? around % 2 === 1 : around >= 2;
  } else {
    present = doc.slice(from - len, from) === mark && doc.slice(to, to + len) === mark;
  }
  if (present) {
    const inner = doc.slice(from, to);
    return { from: from - len, to: to + len, insert: inner, anchor: from - len, head: from - len + inner.length };
  }
  return surround(doc, from, to, mark);
}

const TASK = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+)\[( |x|X)\](\s|$)/;
const ITEM = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+)/;

export interface LineEdit {
  text: string;
  /** How much the columns after the marker moved. */
  dcol: number;
}

/** Ctrl+Enter: ticks or unticks a task; makes a task of an item or a paragraph. */
export function toggleTask(line: string): LineEdit | null {
  const task = TASK.exec(line);
  if (task) {
    const mark = task[2] === " " ? "x" : " ";
    const at = task[1]!.length + 1;
    return { text: `${line.slice(0, at)}${mark}${line.slice(at + 1)}`, dcol: 0 };
  }
  const item = ITEM.exec(line);
  if (item) {
    const at = item[1]!.length;
    return { text: `${line.slice(0, at)}[ ] ${line.slice(at)}`, dcol: 4 };
  }
  if (line.trim() === "" || /^\s*(#{1,6}\s|>|```|~~~)/.test(line)) return null;
  const indent = /^\s*/.exec(line)![0];
  return { text: `${indent}- [ ] ${line.slice(indent.length)}`, dcol: 6 };
}

const WEB_URL = /^(?:https?:\/\/|mailto:)\S+$/;

/** Pasting a URL over selected text makes a link of it. */
export function pasteLink(selected: string, pasted: string): string | null {
  const url = pasted.trim();
  if (selected === "" || selected.includes("\n") || !WEB_URL.test(url)) return null;
  return `[${selected}](${url})`;
}
