import { describe, expect, it } from "vitest";

import { addDays, datesInLine, formatDate, formatDateTime } from "../src/shared/dates";
import { type TextEdit, pasteLink, surround, toggleMark, toggleTask } from "../src/shared/format";
import { matchSlash, slashItems } from "../src/shared/slash";

function apply(doc: string, e: TextEdit): string {
  const text = doc.slice(0, e.from) + e.insert + doc.slice(e.to);
  return `${text.slice(0, e.anchor)}[${text.slice(e.anchor, e.head)}]${text.slice(e.head)}`;
}

describe("surround", () => {
  it("wraps the selection and keeps it selected, so wrapping twice nests", () => {
    const once = surround("a word here", 2, 6, "*");
    expect(apply("a word here", once)).toBe("a *[word]* here");
    const twice = surround("a *word* here", 3, 7, "*");
    expect(apply("a *word* here", twice)).toBe("a **[word]** here");
  });

  it("wraps in different marks", () => {
    expect(apply("x", surround("x", 0, 1, "(", ")"))).toBe("([x])");
  });
});

describe("toggleMark", () => {
  it("marks the selection", () => {
    expect(apply("make bold now", toggleMark("make bold now", 5, 9, "**"))).toBe("make **[bold]** now");
  });

  it("takes the mark off again", () => {
    expect(apply("make **bold** now", toggleMark("make **bold** now", 7, 11, "**"))).toBe("make [bold] now");
  });

  it("marks the word at the cursor when nothing is selected", () => {
    expect(apply("make bold now", toggleMark("make bold now", 7, 7, "*"))).toBe("make *[bold]* now");
  });

  it("inserts the pair on an empty spot and leaves the cursor between", () => {
    expect(apply("a  b", toggleMark("a  b", 2, 2, "`"))).toBe("a `[]` b");
  });

  it("tells italic from bold by the stars around the text", () => {
    // Italic on bold text adds a star pair; bold on italic text does too.
    expect(apply("**bold**", toggleMark("**bold**", 2, 6, "*"))).toBe("***[bold]***");
    expect(apply("***both***", toggleMark("***both***", 3, 7, "*"))).toBe("**[both]**");
    expect(apply("***both***", toggleMark("***both***", 3, 7, "**"))).toBe("*[both]*");
    expect(apply("*it*", toggleMark("*it*", 1, 3, "**"))).toBe("***[it]***");
  });

  it("works with code and strikethrough", () => {
    expect(apply("x `y` z", toggleMark("x `y` z", 3, 4, "`"))).toBe("x [y] z");
    expect(apply("x y z", toggleMark("x y z", 2, 3, "~~"))).toBe("x ~~[y]~~ z");
  });
});

describe("toggleTask", () => {
  it("ticks and unticks", () => {
    expect(toggleTask("- [ ] write")).toEqual({ text: "- [x] write", dcol: 0 });
    expect(toggleTask("  - [x] write")).toEqual({ text: "  - [ ] write", dcol: 0 });
  });

  it("makes a task of an item and of a paragraph", () => {
    expect(toggleTask("- write")).toEqual({ text: "- [ ] write", dcol: 4 });
    expect(toggleTask("1. write")).toEqual({ text: "1. [ ] write", dcol: 4 });
    expect(toggleTask("write")).toEqual({ text: "- [ ] write", dcol: 6 });
  });

  it("leaves blank lines, headings and quotes alone", () => {
    expect(toggleTask("")).toBeNull();
    expect(toggleTask("# Title")).toBeNull();
    expect(toggleTask("> quote")).toBeNull();
  });
});

describe("pasteLink", () => {
  it("makes a link of selected text and a pasted URL", () => {
    expect(pasteLink("OKF", "https://okf.md/spec")).toBe("[OKF](https://okf.md/spec)");
  });

  it("leaves other pastes alone", () => {
    expect(pasteLink("", "https://x.org")).toBeNull();
    expect(pasteLink("a", "not a url")).toBeNull();
    expect(pasteLink("a\nb", "https://x.org")).toBeNull();
  });
});

describe("dates", () => {
  it("formats the way the spec writes dates", () => {
    const d = new Date(2026, 9, 27, 14, 5, 9);
    expect(formatDate(d)).toBe("2026-10-27");
    expect(formatDateTime(d)).toMatch(/^2026-10-27 14:05:09[+-]\d{2}:\d{2}$/);
    expect(formatDate(addDays(d, 5))).toBe("2026-11-01");
  });

  it("finds real dates and datetimes only", () => {
    const line = "on 2026-10-27 at 2026-10-27 14:30:00-03:00, not 2026-13-01 or 12026-10-27 or 2026-02-30";
    expect(datesInLine(line).map((d) => [line.slice(d.from, d.to), d.kind])).toEqual([
      ["2026-10-27", "date"],
      ["2026-10-27 14:30:00-03:00", "datetime"],
    ]);
  });

  it("counts the date of an impossible time", () => {
    const line = "2026-10-27 25:99";
    expect(datesInLine(line).map((d) => line.slice(d.from, d.to))).toEqual(["2026-10-27"]);
  });
});

describe("slash menu", () => {
  const items = slashItems(new Date(2026, 9, 27, 14, 0, 0));

  it("offers line structure only at the start of a line", () => {
    expect(matchSlash(items, "head", true).map((i) => i.label)).toEqual(["Heading 1", "Heading 2", "Heading 3"]);
    expect(matchSlash(items, "head", false)).toEqual([]);
    expect(matchSlash(items, "tod", false).map((i) => i.label)).toEqual(["Today"]);
  });

  it("matches inside the label too, with prefix matches first", () => {
    expect(matchSlash(items, "list", true).map((i) => i.label)).toEqual(["Bullet list", "Numbered list"]);
    expect(matchSlash(items, "", true).length).toBe(items.length);
  });

  it("puts the cursor where typing continues", () => {
    const code = items.find((i) => i.label === "Code block")!;
    expect(code.text.slice(0, code.cursor)).toBe("```\n");
    const today = items.find((i) => i.label === "Today")!;
    expect(today.text).toBe("2026-10-27");
  });
});
