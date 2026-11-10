// The attach mod (bundled, mods/attach): a file pasted or dropped into a page is stored in assets/
// by `tessela attach` (the bytes go through ctx.cli as they are) and linked where the cursor is.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { suite } from "../harness.mjs";

const files = () => ({});

// A real 1x1 PNG: its first byte (0x89) is not valid UTF-8, so text-only input would corrupt it.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const PDF = Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj<<>>endobj\n", "latin1");

/** Sends the editor a paste or a drop that carries `file` (and `text`, for a paste that has some). */
function send(s, kind, file, text = "") {
  return s.win.evaluate(
    ({ kind, name, type, base64, text }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      if (name) data.items.add(new File([bytes], name, { type }));
      if (text) data.setData("text/plain", text);
      const target = document.querySelector(".cm-content");
      const box = target.getBoundingClientRect();
      const event =
        kind === "paste"
          ? new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })
          : new DragEvent("drop", { dataTransfer: data, clientX: box.left + 20, clientY: box.top + 10, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
    },
    { kind, name: file?.name ?? "", type: file?.type ?? "", base64: file?.bytes.toString("base64") ?? "", text },
  );
}

const assets = (s) => {
  try {
    return readdirSync(join(s.bundle, "assets"));
  } catch {
    return [];
  }
};

suite("Attach mod: paste and drop files into a page", files, (test) => {
  test("a pasted picture is stored byte for byte and linked, with the cursor in the description", async (s) => {
    await s.openWith("att-paste", "Look: ");
    await send(s, "paste", { name: "image.png", type: "image/png", bytes: PNG });
    await s.win.waitForFunction(() => /!\[\]\(\/assets\/att-paste-[0-9a-f]{12}\.png\)/.test(document.querySelector(".cm-content").textContent));
    const [stored] = assets(s);
    assert.match(stored, /^att-paste-[0-9a-f]{12}\.png$/);
    assert.deepEqual(readFileSync(join(s.bundle, "assets", stored)), PNG);
    // The cursor is between the brackets, ready for the description.
    await s.type("a pixel");
    assert.match(await s.body(), new RegExp(`Look: !\\[a pixel\\]\\(/assets/${stored}\\)`));
    assert.match(await s.savedBody("att-paste"), /!\[a pixel\]\(\/assets\/att-paste-/);
  });

  test("a dropped PDF becomes a link named after the file", async (s) => {
    await s.openWith("att-drop", "Read this.\n");
    await send(s, "drop", { name: "report.pdf", type: "application/pdf", bytes: PDF });
    await s.win.waitForFunction(() => /\[report\.pdf\]\(\/assets\/att-drop-[0-9a-f]{12}\.pdf\)/.test(document.querySelector(".cm-content").textContent));
    const stored = assets(s).find((f) => f.startsWith("att-drop-"));
    assert.deepEqual(readFileSync(join(s.bundle, "assets", stored)), PDF);
  });

  test("the same file pasted twice is stored once", async (s) => {
    await s.openWith("att-twice", "");
    await send(s, "paste", { name: "image.png", type: "image/png", bytes: PNG });
    await s.win.waitForFunction(() => /!\[\]\(/.test(document.querySelector(".cm-content").textContent));
    await s.key("Control+End");
    await s.key("Enter");
    await send(s, "paste", { name: "image.png", type: "image/png", bytes: PNG });
    await s.win.waitForFunction(() => (document.querySelector(".cm-content").textContent.match(/!\[\]\(/g) ?? []).length === 2);
    assert.equal(assets(s).filter((f) => f.startsWith("att-twice-")).length, 1);
  });

  test("a paste with only text is left to the editor", async (s) => {
    await s.openWith("att-text", "");
    await send(s, "paste", null, "just words");
    assert.match(await s.body(), /just words/);
    assert.deepEqual(assets(s).filter((f) => f.startsWith("att-text-")), []);
  });

  test("a file of a kind nobody can tell is reported and nothing is inserted", async (s) => {
    await s.openWith("att-odd", "Before");
    await send(s, "paste", { name: "mystery", type: "", bytes: Buffer.from("plain words, no signature") });
    await s.win.waitForFunction(() => /Could not attach/.test(document.querySelector("#notice")?.textContent ?? ""));
    assert.equal((await s.body()).trim(), "Before");
    assert.deepEqual(assets(s).filter((f) => f.startsWith("att-odd-")), []);
  });
}, {});

suite("Attach mod: a picture shows in the rendered page", files, (test) => {
  test("the linked picture loads", async (s) => {
    await s.win.evaluate(() => localStorage.setItem("tessela.livePreview", "1"));
    await s.win.reload();
    await s.win.waitForSelector(".cm-content");
    await s.openWith("att-look", "");
    await send(s, "paste", { name: "image.png", type: "image/png", bytes: PNG });
    await s.win.waitForFunction(() => /!\[\]\(/.test(document.querySelector(".cm-content").textContent));
    // The line with the cursor shows its Markdown; moving off it shows the picture.
    await s.key("Control+End");
    await s.key("Enter");
    await s.win.waitForFunction(() => {
      const img = document.querySelector(".cm-lp-image");
      return img && img.complete && img.naturalWidth === 1;
    });
  });
}, { rendered: true });
