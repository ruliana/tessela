// A small model of typing in the editor: keys in, text out. It knows what CodeMirror's
// closeBrackets does (the editor has it on), how a completion popup is taken with Enter,
// and nothing else, which is enough to count the keys a way of adding a link costs.

export type Key = string;

export interface Doc {
  text: string;
  cursor: number;
  /** Selected range, if any; `cursor` is its end. */
  sel: [number, number] | null;
  clipboard: string;
}

export interface Option {
  label: string;
  apply(doc: Doc): Doc;
}

export interface Flow {
  name: string;
  /** Options offered for the text as it stands, or null when no popup is open. */
  popup(doc: Doc): Option[] | null;
  /** A key this flow handles itself; null leaves it to the editor's default. */
  key?(doc: Doc, key: Key): Doc | null;
}

const CLOSERS: Record<string, string> = { "[": "]", "(": ")" };

function replace(doc: Doc, from: number, to: number, insert: string, cursor = from + insert.length): Doc {
  return { ...doc, text: doc.text.slice(0, from) + insert + doc.text.slice(to), cursor, sel: null };
}

/** What a key does when no flow takes it: typing, with brackets that close themselves. */
export function defaultKey(doc: Doc, key: Key): Doc {
  const [from, to] = doc.sel ?? [doc.cursor, doc.cursor];
  const next = doc.text[to] ?? "";
  switch (key) {
    case "Enter":
      return replace(doc, from, to, "\n");
    case "Right":
      return { ...doc, cursor: Math.min(doc.cursor + 1, doc.text.length), sel: null };
    case "Shift+Home": {
      const start = doc.text.lastIndexOf("\n", doc.cursor - 1) + 1;
      return { ...doc, sel: [start, doc.cursor] };
    }
    case "Ctrl+V":
      return replace(doc, from, to, doc.clipboard);
    case "Backspace":
      return doc.sel ? replace(doc, from, to, "") : replace(doc, Math.max(from - 1, 0), to, "");
  }
  if (key.length !== 1) return doc;
  if (doc.sel === null && (key === "]" || key === ")") && next === key) {
    return { ...doc, cursor: doc.cursor + 1 };
  }
  const closer = CLOSERS[key];
  if (closer !== undefined && doc.sel === null && (next === "" || /[\s)\]]/.test(next))) {
    return replace(doc, from, to, key + closer, from + 1);
  }
  return replace(doc, from, to, key);
}

/** Types `keys` into an empty page. */
export function run(flow: Flow, keys: Key[], clipboard = ""): Doc {
  let doc: Doc = { text: "", cursor: 0, sel: null, clipboard };
  let index = 0;
  // After a choice is taken the popup stays shut until something else is typed.
  let shut = false;
  for (const key of keys) {
    const options = shut ? null : flow.popup(doc);
    if (options !== null && options.length > 0 && (key === "Enter" || key === "Tab")) {
      doc = options[Math.min(index, options.length - 1)]!.apply(doc);
      index = 0;
      shut = true;
      continue;
    }
    if (options !== null && key === "Down") {
      index = Math.min(index + 1, options.length - 1);
      continue;
    }
    shut = false;
    index = 0;
    doc = flow.key?.(doc, key) ?? defaultKey(doc, key);
  }
  return doc;
}
