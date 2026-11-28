// Counting work, not time. A test that holds the editor to a time budget fails on a busy runner and passes
// on a fast laptop; the same code does the same work on both. So the speed tests count what the code does
// with the two things every part of the editor reads: the syntax tree (a step of a cursor, a move from a
// node to its child, parent or sibling) and the text of the page (a line looked up, a piece cut out). The
// counts come from the library classes themselves, so that a new view plugin or a new field is counted
// without anybody remembering to count it, and they are the same on every machine and every run.
//
// Time is still measured by the tests, and printed, but nothing fails because of it: it is how a person sees
// what a change felt like, and how a budget in work is first set.

import { syntaxTree } from "@codemirror/language";
import { type EditorState, Text } from "@codemirror/state";
import { Tree, TreeCursor } from "@lezer/common";

export interface Work {
  /** Steps through the syntax tree: cursor moves, and a node asked for its parent, child, sibling or what is at a position. */
  tree: number;
  /** Lookups in the text of the page: a line by position or number, a piece cut out, an iterator opened. */
  text: number;
  /** Characters cut out of the page. The parser reads the page in pieces, so a parse shows up here. */
  chars: number;
}

const total: Work = { tree: 0, text: 0, chars: 0 };
let counting = false;

/** How deep inside a counted call the code is, for each kind of work: a call made by a counted call is its own work, counted once. */
const depth = { tree: 0, text: 0 };

/** Wraps the method or getter `name` of `proto`, if it has one of its own, so that a call adds to `count`. */
function wrap(proto: object, name: string, kind: keyof typeof depth, count: (result: unknown) => void): void {
  const d = Object.getOwnPropertyDescriptor(proto, name);
  if (!d) return;
  const run = (fn: () => unknown): unknown => {
    if (!counting || depth[kind] > 0) return fn();
    depth[kind]++;
    try {
      const result = fn();
      count(result);
      return result;
    } finally {
      depth[kind]--;
    }
  };
  if (typeof d.value === "function") {
    const fn = d.value as (...args: unknown[]) => unknown;
    Object.defineProperty(proto, name, { ...d, value: function (this: unknown, ...args: unknown[]) { return run(() => fn.apply(this, args)); } });
  } else if (d.get) {
    const get = d.get;
    Object.defineProperty(proto, name, { ...d, get(this: unknown) { return run(() => get.call(this)); } });
  }
}

const step = () => void total.tree++;
const lookup = () => void total.text++;
const cut = (result: unknown) => {
  total.text++;
  if (typeof result === "string") total.chars += result.length;
};

/** The class a node of the tree is an instance of, and of its base: the library does not export them. */
function prototypesOf(...nodes: object[]): object[] {
  const seen = new Set<object>();
  for (const node of nodes) {
    for (let p = Object.getPrototypeOf(node) as object | null; p && p !== Object.prototype; p = Object.getPrototypeOf(p) as object | null) seen.add(p);
  }
  return [...seen];
}

let installed = false;

/**
 * Starts counting, as far as the classes of `tree` and `doc` go: a node of a tree has two classes in the
 * library (one for nodes in the tree itself, one for nodes inside a buffer) and a document has two (a leaf of
 * up to 32 lines and a node above leaves), and all of them are patched. Done once; counting is on only inside `measure`.
 */
function install(tree: Tree, doc: Text): void {
  if (installed) return;
  installed = true;
  // Syntax nodes: the top node is the class of nodes in the tree itself; a node inside a buffer is the other.
  const inBuffer: object[] = [];
  tree.iterate({
    enter: (n) => {
      const node = n.node;
      if (Object.getPrototypeOf(node) !== Object.getPrototypeOf(tree.topNode)) {
        inBuffer.push(node);
        return false;
      }
      return undefined;
    },
  });
  if (!inBuffer.length) throw new Error("the page has no node inside a buffer: nothing to count them with");
  for (const proto of prototypesOf(tree.topNode, inBuffer[0]!)) {
    for (const name of ["parent", "firstChild", "lastChild", "nextSibling", "prevSibling"]) wrap(proto, name, "tree", step);
    for (const name of ["getChild", "getChildren", "childAfter", "childBefore", "enter", "resolve", "resolveInner", "cursor", "matchContext"]) wrap(proto, name, "tree", step);
  }
  // Cursors (`Tree.iterate` moves one) and the tree's own ways in.
  for (const name of ["firstChild", "lastChild", "childAfter", "childBefore", "enter", "parent", "nextSibling", "prevSibling", "next", "prev", "moveTo"]) {
    wrap(TreeCursor.prototype, name, "tree", step);
  }
  for (const name of ["cursor", "resolve", "resolveInner"]) wrap(Tree.prototype, name, "tree", step);
  // The text: both classes of document, and what they have in common.
  const leaf = Text.of(["a"]);
  const node = Text.of(Array.from({ length: 200 }, () => "a"));
  for (const proto of prototypesOf(leaf, node, doc)) {
    for (const name of ["lineAt", "line", "iter", "iterRange", "iterLines", "slice"]) wrap(proto, name, "text", lookup);
    wrap(proto, "sliceString", "text", cut);
  }
}

/**
 * What `fn` did, counted. `state` is only used to find the classes the counts are taken from.
 *
 * The clock stands still while `fn` runs. The language gives the parser a slice of time for each
 * transaction (20 ms) and stops when it is used up, leaving a tree that ends part way, which the page model is then
 * built from and built again when the parser goes on. How far the parser gets in a slice depends on how busy the
 * machine is, so with a running clock the work of a key differs from run to run, by more the busier the
 * machine. With the clock still the slice never ends: a key parses what it needs to, once.
 */
export function measure<T>(state: EditorState, fn: () => T): { result: T; work: Work } {
  install(syntaxTree(state), state.doc);
  const before = { ...total };
  const now = Date.now;
  const frozen = now.call(Date);
  Date.now = () => frozen;
  counting = true;
  try {
    const result = fn();
    return { result, work: { tree: total.tree - before.tree, text: total.text - before.text, chars: total.chars - before.chars } };
  } finally {
    counting = false;
    Date.now = now;
  }
}

export const sum = (a: Work, b: Work): Work => ({ tree: a.tree + b.tree, text: a.text + b.text, chars: a.chars + b.chars });
export const none = (): Work => ({ tree: 0, text: 0, chars: 0 });
