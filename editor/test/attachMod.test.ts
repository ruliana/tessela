import { describe, expect, it } from "vitest";

import { extensionOf, linkFor } from "../src/mods/attach/plan";

describe("the attach mod's words", () => {
  it("takes the extension from the name, else from the media type, else leaves it to the tool", () => {
    expect(extensionOf("Report.PDF", "")).toBe("pdf");
    expect(extensionOf("image", "image/jpeg")).toBe("jpg");
    expect(extensionOf("mystery", "")).toBeUndefined();
  });

  it("links a picture with an empty description and any other file by its name", () => {
    expect(linkFor("image.png", "image/png", "/assets/a-1.png")).toEqual({ text: "![](/assets/a-1.png)", cursor: 2 });
    expect(linkFor("photo.JPG", "", "/assets/a-2.jpg").text).toBe("![](/assets/a-2.jpg)");
    expect(linkFor("q3 [final].pdf", "application/pdf", "/assets/a-3.pdf")).toEqual({ text: "[q3 final.pdf](/assets/a-3.pdf)", cursor: 13 });
  });
});
