// Mermaid: a diagram's source in, its SVG out. The diagram is made out of the window (as Mermaid
// does) and sanitized by Mermaid itself.
import mermaid from "mermaid";

let theme: string | undefined;

export async function draw(source: string, id: string, dark: boolean): Promise<string> {
  const want = dark ? "dark" : "default";
  if (theme !== want) {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: want });
    theme = want;
  }
  try {
    return (await mermaid.render(id, source)).svg;
  } finally {
    // A diagram that fails leaves its error drawing in the page.
    document.getElementById(`d${id}`)?.remove();
  }
}
