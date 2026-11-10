import { describe, expect, it } from "vitest";

import { applyEdit, dateChoices, knownTypes, tagChoices, validWhen } from "../src/mods/properties/plan";

const page = (yaml: string) => `---\n${yaml}\n---\n\nBody.\n`;

describe("applyEdit: set", () => {
  it("changes only the line of the key, in the style it was written", () => {
    const text = page('type: project\n# keep\ntitle: "Tessela"\nowner: ana\nversion: 0.2');
    expect(applyEdit(text, { op: "set", key: "type", value: "howto" })).toBe(text.replace("type: project", "type: howto"));
    expect(applyEdit(text, { op: "set", key: "title", value: 'Say "hi"' })).toBe(text.replace('"Tessela"', '"Say \\"hi\\""'));
    expect(applyEdit(text, { op: "set", key: "owner", value: "bia: the 2nd" })).toBe(text.replace("owner: ana", 'owner: "bia: the 2nd"'));
    expect(applyEdit(text, { op: "set", key: "version", value: "0.3" })).toBe(text.replace("0.2", "0.3"));
  });

  it("takes a key away when emptied, but never the type", () => {
    const text = page("type: a\nowner: ana");
    expect(applyEdit(text, { op: "set", key: "owner", value: " " })).toBe(page("type: a"));
    expect(applyEdit(text, { op: "set", key: "type", value: "" })).toBeNull();
  });

  it("refuses what it cannot rewrite without guessing", () => {
    expect(applyEdit(page("type: a\nowner: ana # who"), { op: "set", key: "owner", value: "x" })).toBeNull();
    expect(applyEdit(page("type: a\nnote:\n  nested: 1"), { op: "set", key: "note", value: "x" })).toBeNull();
    expect(applyEdit(page("type: a"), { op: "set", key: "missing", value: "x" })).toBeNull();
    expect(applyEdit("No front matter.\n", { op: "set", key: "type", value: "x" })).toBeNull();
  });
});

describe("applyEdit: tags", () => {
  it("renames, removes and adds in a flow list, keeping the spacing of the others", () => {
    const text = page("type: a\ntags: [okf,  rust, \"x\"]\nowner: ana");
    expect(applyEdit(text, { op: "tag", from: "rust", to: "Go lang" })).toBe(text.replace("rust", "go-lang"));
    expect(applyEdit(text, { op: "tag", from: "x", to: "y" })).toBe(text.replace('"x"', '"y"'));
    expect(applyEdit(text, { op: "tag", from: "okf", to: null })).toBe(text.replace("okf,  rust", "rust"));
    expect(applyEdit(text, { op: "tag-add", tag: "#New" })).toBe(text.replace('"x"]', '"x", new]'));
    expect(applyEdit(page("tags: [a]"), { op: "tag", from: "a", to: "" })).toBe(page("tags: []"));
  });

  it("works on a block list line by line", () => {
    const text = page("type: a\ntags:\n  - one\n  - 'two'\nowner: ana");
    expect(applyEdit(text, { op: "tag", from: "one", to: null })).toBe(text.replace("  - one\n", ""));
    expect(applyEdit(text, { op: "tag", from: "two", to: "three" })).toBe(text.replace("'two'", "'three'"));
    expect(applyEdit(text, { op: "tag-add", tag: "four" })).toBe(text.replace("'two'\n", "'two'\n  - four\n"));
    expect(applyEdit(page("tags:\n  - one"), { op: "tag", from: "one", to: null })).toBe(page("tags: []"));
  });

  it("turns a single tag into a list when another comes, and adds the key when there is none", () => {
    expect(applyEdit(page("tags: solo"), { op: "tag-add", tag: "two" })).toBe(page("tags: [solo, two]"));
    expect(applyEdit(page("tags: solo"), { op: "tag", from: "solo", to: "one" })).toBe(page("tags: one"));
    expect(applyEdit(page("type: a"), { op: "tag-add", tag: "first" })).toBe(page("type: a\ntags: [first]"));
  });

  it("does not add a tag twice, and leaves what it cannot read", () => {
    const text = page("tags: [a, b]");
    expect(applyEdit(text, { op: "tag-add", tag: "A" })).toBe(text);
    expect(applyEdit(text, { op: "tag", from: "zzz", to: "y" })).toBeNull();
    expect(applyEdit(page("tags:\n  - a # why"), { op: "tag-add", tag: "b" })).toBeNull();
  });
});

describe("validWhen", () => {
  it("accepts a date, or a datetime with its offset, and writes the form of the conventions", () => {
    expect(validWhen(" 2026-10-27 ")).toBe("2026-10-27");
    expect(validWhen("2026-10-27T14:30-0300")).toBe("2026-10-27 14:30:00-03:00");
    expect(validWhen("2026-10-27 14:30:05Z")).toBe("2026-10-27 14:30:05Z");
  });

  it("refuses the rest", () => {
    for (const bad of ["next week", "2026-02-30", "2026-10-27 14:30", "2026-10-27 25:00:00Z", ""]) expect(validWhen(bad)).toBeNull();
  });
});

describe("choices", () => {
  it("lists the types in use, the most written first", () => {
    const pages = [{ type: "howto" }, { type: "decision" }, { type: "howto" }, { type: "journal" }, { type: null }, {}];
    expect(knownTypes(pages)).toEqual(["howto", "decision", "concept"]);
  });

  it("offers vocabulary that starts with the typed words first, without what the page has or what is deprecated", () => {
    const vocab = [{ concept: "deep-learning" }, { concept: "learning" }, { concept: "machine-learning" }, { concept: "old", deprecated: true }, { concept: "ml" }];
    expect(tagChoices(vocab, ["ml"], "lear")).toEqual(["learning", "deep-learning", "machine-learning"]);
    expect(tagChoices(vocab, [], "")).toEqual(["deep-learning", "learning", "machine-learning", "ml"]);
  });

  it("offers the dates of the / menu", () => {
    const choices = dateChoices(new Date(2026, 9, 27, 9, 5, 0));
    expect(choices.map((c) => c.label)).toEqual(["Today", "Tomorrow", "Yesterday", "Now"]);
    expect(choices[0]!.text).toBe("2026-10-27");
    expect(validWhen(choices[3]!.text)).toBe(choices[3]!.text);
  });
});
