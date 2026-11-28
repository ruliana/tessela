// Select mode as the table in `renderer/blockKeys.ts` has it, one key at a time on an editor state, and
// the block selection (`shared/blockSelection.ts`) underneath. The known bugs of the old select mode are
// here as tests of the rules that fix them: Escape and Up/Down that ignored a zoom and a fold, Backspace
// that left blank lines and ended the mode, and Escape that focus mode took first.

import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { LEAVE, STAY, cutBlocks, extendTo, respond, typed } from "../src/renderer/blockKeys";
import { blockSelection, selectedBlocks } from "../src/renderer/selectMode";
import { removalRange } from "../src/shared/blockSelection";
import { type Setup, kinds, offsetOf, pageState, picked, press, selectedText, selecting } from "./support/selecting";

const PAGE = ["# Title", "", "Intro", "", "- one", "  - child", "- two", "", "```js", "let a", "", "let b", "```", "", "Last"].join("\n");

describe("Escape", () => {
  it("selects the block at the cursor, with what it owns, and the text selection is those lines", () => {
    const state = selecting("- a\n- b\n  - c\n- d", 1);
    expect(picked(state)).toEqual([1, 2]);
    expect(selectedText(state)).toBe("- b\n  - c");
  });

  it("widens to the parent, the list, the section and the page, and then has nothing left", () => {
    let state = selecting("# One\n\n- a\n  - b\n- c\n\n## Two\n\ntext\n\n# Three\n\nend", 3);
    const seen = [picked(state)!.join("-")];
    for (let reply = respond(state, "Escape"); typeof reply === "object" && reply !== null; reply = respond(state, "Escape")) {
      state = state.update(reply).state;
      seen.push(picked(state)!.join("-"));
    }
    // b; the item a with b in it; the list; the section One (with Two in it); the page.
    expect(seen).toEqual(["3-3", "2-3", "2-4", "0-8", "0-12"]);
    expect(respond(state, "Escape")).toBe(LEAVE);
  });

  it("takes a heading as its line, then its section", () => {
    const state = selecting("# H\n\ntext\n\n# J", 0);
    expect(picked(state)).toEqual([0, 0]);
    expect(picked(press(state, "Escape"))).toEqual([0, 2]);
  });

  it("selects nothing in a gap between blocks, and goes on to focus mode", () => {
    const state = pageState("a\n\nb", { at: 2 });
    expect(respond(state, "Escape")).toBe(LEAVE);
  });

  it("does not take in the front matter: the page is its blocks", () => {
    const text = "---\ntype: concept\n---\n\nIntro\n\nEnd";
    let state = selecting(text, 4);
    state = press(state, "Escape");
    expect(picked(state)).toEqual([4, 6]);
    expect(respond(state, "Escape")).toBe(LEAVE);
    expect(respond(pageState(text, { at: 5 }), "Escape")).toBe(LEAVE);
  });

  // Known bug: Escape widened past a zoom, to the section and the page outside it.
  it("stops at a zoom: nothing outside it is selected, and with nothing left to widen it moves on to focus mode", () => {
    const text = "# A\n\n- one\n  - child\n- two\n\n# B\n\ntext";
    // Zoomed in on the item `one`, lines 2-3.
    const setup: Setup = { zoom: { first: 2, last: 3 } };
    let state = selecting(text, 3, setup);
    expect(picked(state)).toEqual([3, 3]);
    state = press(state, "Escape");
    expect(picked(state)).toEqual([2, 3]);
    expect(respond(state, "Escape")).toBe(LEAVE);
  });

  it("is the whole zoomed block when the zoom is a section, and not the page around it", () => {
    const text = "# A\n\none\n\n# B\n\ntwo\n\nthree";
    const state = selecting(text, 6, { zoom: { first: 4, last: 8 } });
    expect(picked(state)).toEqual([6, 6]);
    expect(picked(press(state, "Escape"))).toEqual([4, 8]);
    expect(respond(press(state, "Escape"), "Escape")).toBe(LEAVE);
  });
});

describe("Up and Down", () => {
  it("step through the blocks in the order they are read, a heading as its own line, and stay at the ends", () => {
    let state = selecting(PAGE, 2);
    const seen: string[] = [];
    for (let i = 0; i < 9; i++) {
      seen.push(picked(state)!.join("-"));
      state = press(state, "ArrowDown");
    }
    // An item is left with what is nested in it: the child is not a stop on the way down.
    expect(seen).toEqual(["2-2", "4-5", "6-6", "8-12", "14-14", "14-14", "14-14", "14-14", "14-14"]);
    expect(respond(state, "ArrowDown")).toBe(STAY);
    expect(picked(press(selecting(PAGE, 2), "ArrowUp"))).toEqual([0, 0]);
    expect(respond(selecting(PAGE, 0), "ArrowUp")).toBe(STAY);
  });

  // Known bug: Down selected blocks inside a fold, and Up from after it went into it.
  it("skip what a fold hides", () => {
    // The item `one` is folded: its child is hidden.
    const state = selecting(PAGE, 4, { folds: [{ first: 4, last: 5 }] });
    expect(picked(state)).toEqual([4, 5]);
    expect(picked(press(state, "ArrowDown"))).toEqual([6, 6]);
    // Begun on `two`, the child is deeper than the walk: Up leaves `one` with it.
    expect(picked(press(selecting(PAGE, 6), "ArrowUp"))).toEqual([4, 5]);
    expect(picked(press(selecting(PAGE, 6, { folds: [{ first: 4, last: 5 }] }), "ArrowUp"))).toEqual([4, 5]);
  });

  it("skip the blocks that a folded heading hides", () => {
    const text = "# A\n\none\n\ntwo\n\n# B\n\nthree";
    const folded = { folds: [{ first: 0, last: 4 }] };
    const state = selecting(text, 0, folded);
    expect(picked(state)).toEqual([0, 0]);
    expect(picked(press(state, "ArrowDown"))).toEqual([6, 6]);
  });

  // Known bug: Down at the end of a zoom selected the block after it, and Up the one before.
  it("stay inside a zoom", () => {
    const text = "# A\n\none\n\ntwo\n\nthree";
    const zoom = { first: 4, last: 4 };
    const state = selecting(text, 4, { zoom });
    expect(picked(state)).toEqual([4, 4]);
    expect(respond(state, "ArrowDown")).toBe(STAY);
    expect(respond(state, "ArrowUp")).toBe(STAY);
    const wide = selecting(text, 2, { zoom: { first: 0, last: 4 } });
    expect(picked(press(wide, "ArrowDown"))).toEqual([4, 4]);
    expect(respond(press(wide, "ArrowDown"), "ArrowDown")).toBe(STAY);
  });

  it("do nothing while editing: the cursor moves as usual", () => {
    const state = pageState(PAGE);
    expect(respond(state, "ArrowDown")).toBeNull();
    expect(respond(state, "ArrowUp")).toBeNull();
  });

  // Known bug (0.5.0 feedback): Up onto a parent, then Down, went past its children, and from a page with
  // nothing else got stuck. Down now goes into the children, as deep as the block select mode began on.
  it("go back down into the children of a parent they went up to, as deep as the block they began on", () => {
    const text = "- a\n  - b\n    - c\n- d";
    const deep = selecting(text, 2);
    // Up climbs out of c and b, and Down comes back the same way, to d.
    const seen: string[] = [];
    let state = deep;
    for (const key of ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowDown"] as const) {
      state = press(state, key);
      seen.push(picked(state)!.join("-"));
    }
    expect(seen).toEqual(["1-2", "0-2", "1-2", "2-2", "3-3"]);
    // Begun on b, c is deeper than the level of the walk: it is not a stop, and the parent still leads back to b.
    const mid = selecting(text, 1);
    expect(picked(press(mid, "ArrowUp"))).toEqual([0, 2]);
    expect(picked(press(mid, "ArrowUp", "ArrowDown"))).toEqual([1, 2]);
    expect(picked(press(mid, "ArrowDown"))).toEqual([3, 3]);
    // Begun at the top, nothing nested is a stop.
    expect(picked(press(selecting(text, 0), "ArrowDown"))).toEqual([3, 3]);
  });

  it("do not get stuck on a parent that is all there is", () => {
    const state = press(selecting("- a\n  - b", 1), "ArrowUp");
    expect(picked(state)).toEqual([0, 1]);
    expect(picked(press(state, "ArrowDown"))).toEqual([1, 1]);
  });

  it("keep the level of the walk when Escape climbs to the parents", () => {
    const state = press(selecting("- a\n  - b\n    - c\n- d", 2), "Escape", "Escape");
    expect(picked(state)).toEqual([0, 2]);
    expect(picked(press(state, "ArrowDown"))).toEqual([1, 2]);
  });
});

describe("Shift+Up and Shift+Down", () => {
  it("take in the next block, and the first step from a heading takes its section", () => {
    expect(picked(press(selecting(PAGE, 2), "Shift-ArrowDown"))).toEqual([2, 6]);
    expect(picked(press(selecting("# H\n\ntext\n\n# J", 0), "Shift-ArrowDown"))).toEqual([0, 2]);
  });

  it("take a whole list in one step, going in, and give it back the same way", () => {
    const state = selecting(PAGE, 2);
    expect(picked(press(state, "Shift-ArrowDown"))).toEqual([2, 6]);
    expect(picked(press(state, "Shift-ArrowDown", "Shift-ArrowUp"))).toEqual([2, 2]);
  });

  it("go on past the list, and from the last child select its parent", () => {
    const page = "- a\n  - b\n  - c\n- d";
    const last = selecting(page, 2);
    expect(picked(last)).toEqual([2, 2]);
    expect(picked(press(last, "Shift-ArrowDown"))).toEqual([0, 2]);
    expect(kinds(press(last, "Shift-ArrowDown"))).toEqual(["item"]);
    // And from the first child, upwards.
    expect(picked(press(selecting(page, 1), "Shift-ArrowUp"))).toEqual([0, 2]);
  });

  it("stay where they are at the edge of the page, and hold the anchor while the head goes either way", () => {
    expect(respond(selecting("a\n\nb", 2), "Shift-ArrowDown")).toBe(STAY);
    const mid = selecting("a\n\nb\n\nc", 2);
    const up = press(mid, "Shift-ArrowUp", "Shift-ArrowUp");
    expect(picked(up)).toEqual([0, 2]);
    // The head is at the top: the text selection runs from the end to the start.
    expect(up.selection.main.anchor).toBe(offsetOf("a\n\nb\n\nc", 2, 1));
    expect(up.selection.main.head).toBe(0);
    expect(picked(press(up, "Shift-ArrowDown"))).toEqual([2, 2]);
  });

  it("do not enter a fold: the selection stops where the blocks are shown", () => {
    const text = "- one\n  - child\n- two";
    const state = selecting(text, 0, { folds: [{ first: 0, last: 1 }] });
    expect(picked(press(state, "Shift-ArrowDown"))).toEqual([0, 2]);
  });
});

describe("leaving select mode", () => {
  it("Enter, Space and Left edit at the start, Right at the end, a character is typed at the start", () => {
    const state = selecting(PAGE, 2);
    // Known bug: Enter added a line below, where it is the same as Right: edit at the end of what is selected.
    const enter = press(state, "Enter");
    expect(picked(enter)).toBeNull();
    expect(enter.doc.toString()).toBe(PAGE);
    expect(enter.selection.main.head).toBe(offsetOf(PAGE, 2, 5));
    for (const key of [" ", "ArrowLeft"] as const) {
      const out = press(state, key);
      expect(picked(out)).toBeNull();
      expect(out.selection.main.head).toBe(offsetOf(PAGE, 2));
      expect(out.doc.toString()).toBe(PAGE);
    }
    expect(press(state, "ArrowRight").selection.main.head).toBe(offsetOf(PAGE, 2, 5));
    const out = state.update(typed(state, "x")!).state;
    expect(out.doc.toString()).toBe(PAGE.replace("Intro", "xIntro"));
    expect(picked(out)).toBeNull();
    expect(typed(pageState(PAGE), "x")).toBeNull();
  });

  it("Shift+Enter opens a line above the selected blocks, and above the cursor while editing, with the cursor in it", () => {
    const state = selecting(PAGE, 4);
    const out = press(state, "Shift-Enter");
    expect(picked(out)).toBeNull();
    expect(out.doc.toString()).toBe(PAGE.replace("- one\n", "- \n- one\n"));
    expect(out.selection.main.head).toBe(offsetOf(PAGE, 4, 2));
    const editing = press(pageState(PAGE, { at: offsetOf(PAGE, 2, 3) }), "Shift-Enter");
    expect(editing.doc.toString()).toBe(PAGE.replace("Intro", "\n\nIntro"));
    expect(editing.selection.main.head).toBe(offsetOf(PAGE, 2));
  });

  it("a click, or anything else that moves the selection or changes the text, goes back to editing", () => {
    const state = selecting(PAGE, 2);
    expect(picked(state.update({ selection: { anchor: 3 } }).state)).toBeNull();
    expect(picked(state.update({ changes: { from: 0, insert: "x" } }).state)).toBeNull();
    expect(picked(state.update({ selection: { anchor: 3 }, effects: [] }).state)).toBeNull();
    // A transaction that does neither keeps the blocks.
    expect(picked(state.update({ scrollIntoView: true }).state)).toEqual([2, 2]);
  });

  it("Escape with nothing left to widen is for focus mode, and the cursor goes to the start when that is off", () => {
    const state = press(selecting("a\n\nb", 0), "Escape");
    expect(picked(state)).toEqual([0, 2]);
    expect(respond(state, "Escape")).toBe(LEAVE);
  });
});

describe("Backspace and Delete", () => {
  // Known bug: the selected text was deleted, leaving the blank lines, and select mode ended.
  it("remove the blocks and the space that went with them, and select the next block", () => {
    for (const key of ["Backspace", "Delete"] as const) {
      const state = press(selecting(PAGE, 2), key);
      expect(state.doc.toString()).toBe(PAGE.replace("Intro\n\n", ""));
      expect(picked(state)).toEqual([2, 3]);
      expect(selectedText(state)).toBe("- one\n  - child");
    }
  });

  it("select the block before when the last one goes, and keep one gap between the ones left", () => {
    const state = press(selecting(PAGE, 14), "Backspace");
    expect(state.doc.toString()).toBe(PAGE.replace("\n\nLast", ""));
    expect(picked(state)).toEqual([8, 12]);
    const mid = press(selecting("a\n\nb\n\nc", 2), "Backspace");
    expect(mid.doc.toString()).toBe("a\n\nc");
    expect(picked(mid)).toEqual([2, 2]);
  });

  it("take an item out of a list without opening a gap in it, or closing the one after the list", () => {
    const state = press(selecting("- a\n- b\n\ntext", 1), "Backspace");
    expect(state.doc.toString()).toBe("- a\n\ntext");
    expect(picked(state)).toEqual([2, 2]);
    expect(press(selecting("- a\n- b\n- c", 1), "Backspace").doc.toString()).toBe("- a\n- c");
  });

  it("take everything that is selected, and leave select mode when the page is empty", () => {
    const all = press(selecting("a\n\nb", 0), "Escape", "Backspace");
    expect(all.doc.toString()).toBe("");
    expect(picked(all)).toBeNull();
    const withFront = press(selecting("---\ntype: concept\n---\n\na\n\nb", 4), "Escape", "Backspace");
    expect(withFront.doc.toString()).toBe("---\ntype: concept\n---");
    expect(picked(withFront)).toBeNull();
  });

  it("go to the next block that is shown, and are for blocks only while editing is not going on", () => {
    expect(respond(pageState("a\n\nb"), "Backspace")).toBeNull();
    const zoomed = press(selecting("a\n\nb\n\nc", 2, { zoom: { first: 2, last: 2 } }), "Backspace");
    expect(zoomed.doc.toString()).toBe("a\n\nc");
  });

  it("cut takes the blocks as Markdown, and removes them the same way", () => {
    const cut = cutBlocks(selecting(PAGE, 4))!;
    expect(cut.text).toBe("- one\n  - child");
    expect(cutBlocks(pageState(PAGE))).toBeNull();
  });
});

describe("the other keys of select mode, on the blocks, which stay selected", () => {
  it("Tab nests an item and Shift+Tab takes it out, and the same block is selected", () => {
    const nested = press(selecting("- a\n- b\n- c", 1), "Tab");
    expect(nested.doc.toString()).toBe("- a\n  - b\n- c");
    expect(picked(nested)).toEqual([1, 1]);
    expect(kinds(nested)).toEqual(["item"]);
    const back = press(nested, "Shift-Tab");
    expect(back.doc.toString()).toBe("- a\n- b\n- c");
    expect(picked(back)).toEqual([1, 1]);
  });

  it("Alt+Up and Alt+Down move the blocks, and the blocks are still selected", () => {
    const state = press(selecting("a\n\nb\n\nc", 0), "Shift-ArrowDown", "Alt-ArrowDown");
    expect(state.doc.toString()).toBe("c\n\na\n\nb");
    expect(picked(state)).toEqual([2, 4]);
    expect(selectedText(state)).toBe("a\n\nb");
    expect(respond(selecting("a\n\nb", 0), "Alt-ArrowUp")).toBe(STAY);
  });

  it("Ctrl+D copies the blocks under themselves, and the copy is selected", () => {
    const one = press(selecting("a\n\nb", 0), "Mod-d");
    expect(one.doc.toString()).toBe("a\n\na\n\nb");
    expect(picked(one)).toEqual([2, 2]);
    const items = press(selecting("- a\n  - b\n- c", 0), "Mod-d");
    expect(items.doc.toString()).toBe("- a\n  - b\n- a\n  - b\n- c");
    expect(picked(items)).toEqual([2, 3]);
    expect(respond(pageState("a"), "Mod-d")).toBeNull();
  });

  it("Ctrl+Enter ticks every selected item, and makes a task of one that is not", () => {
    const state = press(selecting("- [ ] a\n- [x] b\n- c\n\ntext", 0), "Escape", "Mod-Enter");
    expect(state.doc.toString()).toBe("- [x] a\n- [ ] b\n- [ ] c\n\ntext");
    expect(picked(state)).toEqual([0, 2]);
    expect(respond(selecting("para", 0), "Mod-Enter")).toBe(STAY);
    expect(respond(pageState("- a"), "Mod-Enter")).toBeNull();
  });
});

describe("Shift+click", () => {
  it("takes the selection from its anchor to the block clicked, and not to a block that is hidden", () => {
    const state = selecting("a\n\nb\n\nc", 0);
    const to = extendTo(state, offsetOf("a\n\nb\n\nc", 4))!;
    expect(picked(state.update(to).state)).toEqual([0, 4]);
    expect(extendTo(pageState("a"), 0)).toBeNull();
    const folded = selecting("- a\n  - b\n- c", 0, { folds: [{ first: 0, last: 1 }] });
    expect(extendTo(folded, offsetOf("- a\n  - b\n- c", 1, 4))).toBeNull();
  });
});

describe("what is selected", () => {
  it("is exposed to mods as the blocks, in page order, and nothing while editing", () => {
    const state = selecting(PAGE, 4);
    expect(selectedBlocks(state).map((n) => n.startLine)).toEqual([5]);
    expect(selectedBlocks(press(state, "Shift-ArrowDown")).map((n) => n.startLine)).toEqual([5, 7]);
    expect(selectedBlocks(pageState(PAGE))).toEqual([]);
    expect(pageState(PAGE).field(blockSelection)).toBeNull();
  });
});

describe("removing blocks from a page", () => {
  const cut = (text: string, first: number, last = first): string => {
    const doc = Text.of(text.split("\n"));
    const { from, to } = removalRange(doc, first, last);
    return doc.sliceString(0, from) + doc.sliceString(to);
  };

  it("keeps the larger of the two gaps between what is left, and no gap at an end", () => {
    expect(cut("a\n\nb\n\nc", 2)).toBe("a\n\nc");
    expect(cut("a\nb\n\nc", 1)).toBe("a\n\nc");
    expect(cut("a\n\nb\nc", 2)).toBe("a\n\nc");
    expect(cut("a\n\n\nb\n\nc", 3)).toBe("a\n\n\nc");
    expect(cut("a\n\nb", 0)).toBe("b");
    expect(cut("a\n\nb", 2)).toBe("a");
    expect(cut("a\n\nb\n", 2)).toBe("a\n");
    expect(cut("---\nx: 1\n---\n\na", 4)).toBe("---\nx: 1\n---");
    expect(cut("a", 0)).toBe("");
  });
});
