// The attach mod's small decisions, kept apart from the window so they can be tested: which
// extension a file has, and the Markdown that links it.

const BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "application/pdf": "pdf",
};

const PICTURES = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"]);

/** The extension to tell `tessela attach`: the file name's, else the media type's, else none (the tool looks at the bytes). */
export function extensionOf(name: string, type: string): string | undefined {
  const dot = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return dot?.[1]?.toLowerCase() ?? BY_TYPE[type.toLowerCase()];
}

/** What goes into the page for a stored file, and where the cursor goes in it (the description). */
export function linkFor(name: string, type: string, link: string): { text: string; cursor: number } {
  const picture = type.startsWith("image/") || PICTURES.has(extensionOf(name, type) ?? "");
  if (picture) return { text: `![](${link})`, cursor: 2 };
  const label = name.replace(/[[\]]/g, "") || "file";
  return { text: `[${label}](${link})`, cursor: 1 + label.length };
}
