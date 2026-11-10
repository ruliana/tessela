// KaTeX, as MathML: the browser typesets it with its own math font, so no fonts or styles are shipped.
import katex from "katex";

export const render = (tex: string, display: boolean): string => katex.renderToString(tex, { output: "mathml", displayMode: display, throwOnError: true });
