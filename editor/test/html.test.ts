import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { ALLOWED_HTML, allowedHtml } from "../src/shared/html";

const BR = { element: "br" };

describe("the HTML allowlist", () => {
  it("draws &nbsp; as a no-break space, and <br> in its three spellings as a line break", () => {
    expect(allowedHtml("a&nbsp;b")).toEqual(["a b"]);
    expect(allowedHtml("one<br>two<br/>three<br />four")).toEqual(["one", BR, "two", BR, "three", BR, "four"]);
    expect(allowedHtml("")).toEqual([]);
  });

  it("leaves every other piece of HTML as typed", () => {
    for (const text of [
      "<b>x</b>",
      "<script>alert(1)</script>",
      "<br class=x>",
      "<br onclick=alert(1)>",
      "<br  />",
      "<BR>",
      "&NBSP;",
      "&amp;nbsp;",
      "&nbsp",
      "&lt;br&gt;",
      "<img src=x onerror=y>",
    ]) {
      expect(allowedHtml(text)).toEqual([text]);
    }
  });

  it("never lets typed characters into an element: only the allowlist's own element names come out", () => {
    const names = new Set(ALLOWED_HTML.flatMap(({ draw }) => (typeof draw === "string" ? [] : [draw.element])));
    fc.assert(
      fc.property(fc.array(fc.constantFrom("&nbsp;", "<br>", "<br/>", "<br />", "<br x>", "<b>", "&", "<", "a", " ")).map((p) => p.join("")), (text) => {
        for (const piece of allowedHtml(text)) {
          if (typeof piece !== "string") expect([...names]).toContain(piece.element);
        }
        // Drawing it back as Markdown gives the same text, with a no-break space for &nbsp;.
        const flat = allowedHtml(text).map((p) => (typeof p === "string" ? p : "<br>")).join("");
        expect(flat.replace(/ /g, "&nbsp;").replace(/<br>/g, "")).toBe(text.replace(/<br ?\/?>/g, ""));
      }),
    );
  });
});
