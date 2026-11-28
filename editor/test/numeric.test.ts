import { syntaxTree } from "@codemirror/language";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { htmlToMarkdown } from "../src/shared/htmlToMarkdown";
import { isNumeric, numericColumns } from "../src/shared/numeric";
import { readTable } from "../src/renderer/livePreview";
import { revealState } from "./support/reveal";

describe("numeric columns", () => {
  it("any number as people write it is numeric, and a word in it is not", () => {
    const digits = fc.stringMatching(/^[0-9]{1,4}$/);
    const number = fc
      .record({
        sign: fc.constantFrom("", "-", "+", "$", "-$"),
        whole: fc.oneof(digits, fc.tuple(digits, digits).map(([a, b]) => `${a},${b.padStart(3, "0")}`)),
        frac: fc.option(digits, { nil: undefined }),
        percent: fc.constantFrom("", "%"),
      })
      .map(({ sign, whole, frac, percent }) => `${sign}${whole}${frac === undefined ? "" : `.${frac}`}${percent}`);
    fc.assert(fc.property(number, (n) => isNumeric(n) && isNumeric(` ${n} `)));
    fc.assert(fc.property(number, fc.stringMatching(/^[a-z]{1,4}$/), (n, w) => !isNumeric(`${n} ${w}`) && !isNumeric(`${w}${n}`)));
    for (const t of ["", " ", "-", "$", "1-2", "12 apples", "v1.2.3x", "**1**"]) expect(isNumeric(t)).toBe(false);
  });

  it("a column is numeric when every filled cell is a number; empty cells do not count", () => {
    expect(numericColumns([["1", "x", ""], ["2.5", "3", ""], ["", "4", ""]], 3)).toEqual([true, false, false]);
    expect(numericColumns([], 2)).toEqual([false, false]);
  });

  const aligns = (text: string) => {
    const state = revealState(text);
    let found: ReturnType<typeof readTable> = null;
    syntaxTree(state).iterate({ enter: (n) => void (n.name === "Table" && (found = readTable(state, n.node))) });
    return (found as ReturnType<typeof readTable>)!.aligns;
  };

  it("a table without a chosen alignment is drawn right-aligned in its numeric columns; a chosen one stays", () => {
    expect(aligns("| id | name | n |\n| --- | --- | --- |\n| 1 | a | 2 |\n| 10 | b | 3.5 |\n")).toEqual(["right", null, "right"]);
    expect(aligns("| n | m |\n| :--- | :-: |\n| 1 | 2 |\n")).toEqual(["left", "center"]);
  });

  it("smart paste writes --: for numeric columns, as Google Sheets gives them", () => {
    const html = `<table><tr><th>pos</th><th>name</th><th>pct</th></tr><tr><td>0</td><td>a</td><td>93%</td></tr><tr><td>1</td><td>b</td><td>1,100</td></tr></table>`;
    expect(htmlToMarkdown(html).markdown).toBe("| pos | name | pct |\n| ---: | --- | ---: |\n| 0 | a | 93% |\n| 1 | b | 1,100 |");
  });
});
