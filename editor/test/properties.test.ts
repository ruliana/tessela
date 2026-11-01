import { describe, expect, it } from "vitest";

import { frontmatterEnd } from "../src/shared/blocks";
import { bodyRepeatsTitle, bodyStart, parseProperties, showWhen } from "../src/shared/properties";

const read = (text: string) => {
  const lines = text.split("\n");
  return parseProperties(lines, frontmatterEnd(lines));
};

describe("parseProperties", () => {
  it("reads the title, type, tags and timestamp", () => {
    const p = read('---\ntype: concept\ntitle: "Tessela"\ntags: [okf, "Project/X"]\ntimestamp: "2026-10-27 09:00:00-03:00"\n---\n\ntext');
    expect(p.title).toBe("Tessela");
    expect(p.type).toBe("concept");
    expect(p.tags).toEqual(["okf", "project/x"]);
    expect(p.when).toEqual({ key: "timestamp", value: "2026-10-27 09:00:00-03:00" });
  });

  it("reads tags written as a list", () => {
    const p = read("---\ntype: concept\ntags:\n  - one\n  - two\ntitle: T\n---\n");
    expect(p.tags).toEqual(["one", "two"]);
    expect(p.title).toBe("T");
  });

  it("prefers the timestamp over the date, and keeps other simple keys", () => {
    const p = read("---\ndate: 2026-10-27\ntimestamp: 2026-10-27 09:00:00-03:00\nokf_version: 0.2\nnested:\n  a: 1\n---\n");
    expect(p.when?.key).toBe("timestamp");
    expect(p.others).toEqual([{ key: "okf_version", value: "0.2" }]);
  });
});

describe("showWhen", () => {
  it("writes a date and a datetime in words", () => {
    expect(showWhen("2026-10-27")).toBe("27 Oct 2026");
    expect(showWhen("2026-10-27 09:00:00-03:00")).toBe("27 Oct 2026, 09:00");
    expect(showWhen("someday")).toBe("someday");
  });
});

describe("bodyRepeatsTitle", () => {
  it("is true when the first body line is the title as a heading", () => {
    const lines = "---\ntitle: Tessela\n---\n\n# tessela\ntext".split("\n");
    expect(bodyRepeatsTitle(lines, 2, "Tessela")).toBe(true);
    expect(bodyRepeatsTitle(lines, 2, "Other")).toBe(false);
    expect(bodyRepeatsTitle(lines, 2, null)).toBe(false);
  });
});

describe("bodyStart", () => {
  it("is the first body line, or the start without front matter", () => {
    expect(bodyStart("---\ntype: a\n---\n\nHello")).toBe("---\ntype: a\n---\n\n".length);
    expect(bodyStart("Hello")).toBe(0);
    expect(bodyStart("---\ntitle: T\n---\n\n# T\n\nText")).toBe("---\ntitle: T\n---\n\n# T\n\n".length);
    expect(bodyStart("---\ntype: a\n---\n\n")).toBe("---\ntype: a\n---\n".length + 1);
  });
});
