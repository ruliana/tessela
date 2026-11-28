// Writing aids: typewriter scrolling and the sentence level of focus mode.

import { EditorState } from "@codemirror/state";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { outsideSentence, sentenceDecorations } from "../src/renderer/sentenceFocus";
import { alongLine, wantsTypewriter } from "../src/renderer/typewriter";
import { sentenceAt } from "../src/shared/sentences";
import { SELECTION_MARGIN, TYPEWRITER_FRACTION, selectionDelta, typewriterDelta } from "../src/shared/typewriter";
import { revealState } from "./support/reveal";

describe("typewriter scrolling", () => {
  const num = fc.double({ min: -5000, max: 5000, noNaN: true });
  const height = fc.double({ min: 100, max: 3000, noNaN: true });

  it("puts the cursor a third of the way down, and then has nothing left to do", () => {
    fc.assert(
      fc.property(num, num, height, (cursorTop, viewTop, h) => {
        const delta = typewriterDelta(cursorTop, viewTop, h);
        // Scrolling by delta moves the cursor up by delta.
        expect(Math.abs(cursorTop - delta - viewTop - h * TYPEWRITER_FRACTION)).toBeLessThanOrEqual(1);
        expect(typewriterDelta(cursorTop - delta, viewTop, h)).toBe(0);
      }),
    );
  });

  it("keeps the line at the golden ratio from the bottom of the window", () => {
    const phi = (1 + Math.sqrt(5)) / 2;
    // 38.2% of the window is below the line, 61.8% above it.
    expect((1 - TYPEWRITER_FRACTION) / TYPEWRITER_FRACTION).toBeCloseTo(1 / phi, 6);
    expect(TYPEWRITER_FRACTION).toBeCloseTo(0.618, 3);
  });

  it("does not move the text for a sub-pixel difference", () => {
    const line = 300 * TYPEWRITER_FRACTION;
    expect(typewriterDelta(line + 0.4, 0, 300)).toBe(0);
    expect(typewriterDelta(line + 30, 0, 300)).toBeCloseTo(30);
    expect(typewriterDelta(line - 30, 0, 300)).toBeCloseTo(-30);
  });

  it("scrolls a selection so that all of it shows when it fits, and its start when it does not", () => {
    const top = fc.double({ min: -5000, max: 5000, noNaN: true });
    const size = fc.double({ min: 1, max: 4000, noNaN: true });
    fc.assert(
      fc.property(top, size, top, height, (selTop, selHeight, viewTop, h) => {
        const delta = selectionDelta(selTop, selTop + selHeight, viewTop, h);
        const at = selTop - delta - viewTop; // where the selection's start ends up in the window
        if (selHeight <= h - 2 * SELECTION_MARGIN) {
          expect(at).toBeGreaterThanOrEqual(SELECTION_MARGIN - 1);
          expect(at + selHeight).toBeLessThanOrEqual(h - SELECTION_MARGIN + 1);
          // On the typewriter line unless that would push the end out of the window.
          expect(at).toBeLessThanOrEqual(h * TYPEWRITER_FRACTION + 1);
        } else {
          expect(Math.abs(at - SELECTION_MARGIN)).toBeLessThanOrEqual(1); // too tall: its start shows
        }
        expect(selectionDelta(selTop - delta, selTop - delta + selHeight, viewTop, h)).toBe(0);
      }),
    );
  });

  it("keeps a short selection on the typewriter line and moves a long one up from it", () => {
    expect(selectionDelta(300, 320, 0, 600)).toBeCloseTo(300 - 600 * TYPEWRITER_FRACTION); // fits under the line
    expect(selectionDelta(400, 700, 0, 600)).toBeCloseTo(400 - (600 - SELECTION_MARGIN - 300)); // would leave the window
  });

  it("follows typing and the keys, not a click or a jump that scrolls by its own effect", () => {
    const state = EditorState.create({ doc: "hello" });
    expect(wantsTypewriter(state.update({ changes: { from: 5, insert: "!" }, scrollIntoView: true, userEvent: "input.type" }))).toBe(true);
    expect(wantsTypewriter(state.update({ selection: { anchor: 2 }, scrollIntoView: true, userEvent: "select" }))).toBe(true);
    expect(wantsTypewriter(state.update({ selection: { anchor: 2 }, scrollIntoView: true, userEvent: "select.pointer" }))).toBe(false);
    expect(wantsTypewriter(state.update({ selection: { anchor: 2 } }))).toBe(false);
  });
});

describe("typewriter scrolling while a line wraps", () => {
  const typed = (doc: string, at: number, insert: string) => {
    const before = EditorState.create({ doc, selection: { anchor: at } });
    return { before, after: before.update({ changes: { from: at, insert }, selection: { anchor: at + insert.length }, userEvent: "input.type" }).state };
  };

  it("counts a word that wraps onto a new row as the same line, to glide to it instead of jumping", () => {
    const { before, after } = typed("one two three", 13, "x");
    expect(alongLine(before, after)).toBe(true);
  });

  it("does not when the cursor goes to another line", () => {
    const { before, after } = typed("one two", 7, "\n");
    expect(alongLine(before, after)).toBe(false);
    const moved = before.update({ selection: { anchor: 0 } }).state;
    const two = EditorState.create({ doc: "a\nb", selection: { anchor: 1 } });
    expect(alongLine(two, two.update({ selection: { anchor: 3 } }).state)).toBe(false);
    expect(alongLine(before, moved)).toBe(true);
  });
});

describe("the dimming of the sentence", () => {
  // Marks cut a paragraph into pieces, and a row that is full to within a pixel wraps differently with
  // other pieces: a word jumps between rows as the cursor moves. So there are none unless it is on.
  const state = revealState("One two. Three four. Five six.", { at: 12 });
  const count = (on: boolean, focused = true) => sentenceDecorations(state, on, focused).size;

  it("has no marks while sentence focus is off, whatever the sentences", () => {
    expect(count(false)).toBe(0);
  });

  it("has them, outside the current sentence, while it is on and the editor has the focus", () => {
    expect(count(true)).toBe(2);
    expect(count(true, false)).toBe(0);
  });
});

describe("the sentence under the cursor", () => {
  it("always holds the cursor, inside the text", () => {
    const text = fc.array(fc.constantFrom("a", "b", " ", ".", "!", "?", "\n", "e", "g", ")", "*", "3", "A"), { maxLength: 60 }).map((cs) => cs.join(""));
    fc.assert(
      fc.property(text, fc.nat(80), (t, n) => {
        const at = Math.min(n, t.length);
        const { from, to } = sentenceAt(t, at);
        expect(from).toBeGreaterThanOrEqual(0);
        expect(from).toBeLessThanOrEqual(at);
        expect(to).toBeGreaterThanOrEqual(at);
        expect(to).toBeLessThanOrEqual(t.length);
      }),
    );
  });

  it("splits a text into sentences that cover it without overlapping", () => {
    const words = fc.array(fc.constantFrom("Some", "words", "here", "Another", "one."), { minLength: 1, maxLength: 12 });
    fc.assert(
      fc.property(words, (ws) => {
        const t = `${ws.join(" ")}.`;
        // Walking the cursor along the text, the sentence changes only forward.
        let last = -1;
        for (let at = 0; at <= t.length; at++) {
          const { from, to } = sentenceAt(t, at);
          expect(to).toBeGreaterThanOrEqual(last);
          last = to;
          expect(t.slice(from, to).trim()).not.toBe("");
        }
      }),
    );
  });

  const sentenceOf = (t: string, at: number) => {
    const { from, to } = sentenceAt(t, at);
    return t.slice(from, to);
  };

  it("ends at . ! ? and the closing marks after them, when a space or the end follows", () => {
    const t = "First one. Second **one!** Third? (Fourth.) Fifth";
    expect(sentenceOf(t, 3)).toBe("First one.");
    expect(sentenceOf(t, t.indexOf("Second") + 3)).toBe("Second **one!**");
    expect(sentenceOf(t, t.indexOf("Third"))).toBe("Third?");
    expect(sentenceOf(t, t.indexOf("Fourth"))).toBe("(Fourth.)");
    expect(sentenceOf(t, t.length)).toBe("Fifth");
  });

  it("does not end at a decimal, an address, an abbreviation or a period before a lowercase word", () => {
    expect(sentenceOf("It costs 3.14 euros. Then", 3)).toBe("It costs 3.14 euros.");
    expect(sentenceOf("See https://a.b/c.html now. Then", 5)).toBe("See https://a.b/c.html now.");
    expect(sentenceOf("Ask Dr. Smith today. Then", 5)).toBe("Ask Dr. Smith today.");
    expect(sentenceOf("Use fruit, e.g. apples. Then", 5)).toBe("Use fruit, e.g. apples.");
  });

  it("belongs to the sentence just typed until the space after it, then to an empty next one", () => {
    const t = "Done. ";
    expect(sentenceOf(t, 5)).toBe("Done.");
    expect(sentenceAt(t, 6)).toEqual({ from: 6, to: 6 });
  });

  it("spans lines of the same paragraph", () => {
    expect(sentenceOf("one two\nthree. Four", 3)).toBe("one two\nthree.");
  });
});

describe("what sentence focus dims", () => {
  /** The text with the dimmed parts in brackets. */
  const dimmed = (doc: string, at: number, to = at) => {
    const state = revealState(doc, { at, to });
    let out = doc;
    for (const r of outsideSentence(state).reverse()) out = `${out.slice(0, r.from)}[${out.slice(r.from, r.to)}]${out.slice(r.to)}`;
    return out;
  };

  it("is the rest of the paragraph around the current sentence", () => {
    const doc = "Intro.\n\nOne two. Three four. Five six.\n";
    expect(dimmed(doc, doc.indexOf("Three") + 2)).toBe("Intro.\n\n[One two. ]Three four.[ Five six.]\n");
  });

  it("is the rest of the item for a list item (its bullet goes with the first sentence), and only the item's own text", () => {
    const doc = "- One. Two.\n  - Nested. Text.\n";
    expect(dimmed(doc, 8)).toBe("[- One. ]Two.\n  - Nested. Text.\n");
  });

  it("leaves a selection alone, and does nothing for a heading, a fence or a blank line", () => {
    const doc = "# Head. Line\n\nOne. Two. Three.\n\n```\na. b.\n```\n";
    expect(dimmed(doc, doc.indexOf("Two"), doc.indexOf("Three") + 2)).toContain("One. Two. Three.".replace("One. ", "[One. ]"));
    expect(dimmed(doc, 3)).toBe(doc);
    expect(dimmed(doc, doc.indexOf("\n\nOne") + 1)).toBe(doc);
    expect(dimmed(doc, doc.indexOf("a. b.") + 1)).toBe(doc);
  });

  it("never reaches outside the block, and always leaves the cursor in the part that is not dimmed", () => {
    const sentences = fc.array(fc.constantFrom("Alpha beta.", "Gamma?", "delta"), { minLength: 1, maxLength: 5 });
    fc.assert(
      fc.property(sentences, fc.nat(100), (ss, n) => {
        const doc = `Intro\n\n${ss.join(" ")}\n\n- item\n`;
        const at = 7 + (n % (ss.join(" ").length + 1));
        for (const r of outsideSentence(revealState(doc, { at }))) {
          expect(r.from).toBeGreaterThanOrEqual(7);
          expect(r.to).toBeLessThanOrEqual(7 + ss.join(" ").length);
          expect(at <= r.from || at >= r.to).toBe(true);
        }
      }),
    );
  });
});
