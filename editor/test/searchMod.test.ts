import { describe, expect, it } from "vitest";
import { commandLine, quoted, nameFilter, parseSearch, queryArgs, searchable } from "../src/mods/search/plan";

describe("search plan", () => {
  it("reads words, phrases, tags and filters", () => {
    expect(parseSearch('alpha  "two words" #proj/x type:person in:people/ 2020-01-02 beta')).toEqual({
      refs: ["proj/x"],
      type: "person",
      page: "people/",
      from: "2020-01-02",
      to: "2020-01-02",
      phrases: ["two words"],
      words: ["alpha", "beta"],
    });
  });

  it("keeps a filter that is still being typed out of the way, and a bad date as a word", () => {
    expect(parseSearch("type: from:soon alpha")).toMatchObject({ words: ["from:soon", "alpha"] });
    expect(parseSearch("type:").type).toBeUndefined();
  });

  it("needs a filter or two characters of text", () => {
    expect(searchable(parseSearch("a"))).toBe(false);
    expect(searchable(parseSearch("ab"))).toBe(true);
    expect(searchable(parseSearch("#x"))).toBe(true);
    expect(searchable(parseSearch("#"))).toBe(false);
  });

  it("writes the query, quoting what needs it, and meta only with text", () => {
    expect(commandLine(queryArgs(parseSearch('#rust "a b" c d')))).toBe('query --ref rust --text "a b" --words "c d" --meta');
    expect(commandLine(queryArgs(parseSearch("#rust")))).toBe("query --ref rust");
    expect(quoted('say "x" \\ y')).toBe('"say \\"x\\" \\\\ y"');
  });

  it("filters the page names by the plain text only", () => {
    expect(nameFilter('tess #rust type:x "a b"')).toBe("a b tess");
  });
});
