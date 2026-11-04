// The Tessela logo, drawn inline so it follows the theme. The drawings are the ones in
// assets/logo/ (tessela-mark.svg and tessela-mark-small.svg); the colours come from
// the theme (`--accent` and `--date`, see `.logo` in style.css) instead of being fixed.

const SVG = "http://www.w3.org/2000/svg";

/** [x, y, width, height, class] for each tile. */
type Tile = readonly [number, number, number, number, string];

/** Five tiles on a 64 grid: for anything from about 40px up. */
const FULL: readonly Tile[] = [
  [0, 0, 18, 18, "t1"],
  [23, 0, 18, 18, "t2"],
  [46, 0, 18, 18, "t3"],
  [23, 23, 18, 18, "t1"],
  [23, 46, 18, 18, "now"],
];

/** Four bigger tiles on a 32 grid, for small sizes where the five would blur together. */
const SMALL: readonly Tile[] = [
  [0, 0, 10, 14, "t1"],
  [11, 0, 10, 14, "t1"],
  [22, 0, 10, 14, "t1"],
  [11, 15, 10, 17, "now"],
];

/** The logo as an SVG element. `small` picks the simplified drawing. */
export function logo(size: number, small = size < 40): SVGSVGElement {
  const grid = small ? 32 : 64;
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${grid} ${grid}`);
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("class", "logo");
  svg.setAttribute("aria-hidden", "true");
  for (const [x, y, w, h, cls] of small ? SMALL : FULL) {
    const rect = document.createElementNS(SVG, "rect");
    rect.setAttribute("x", String(x));
    rect.setAttribute("y", String(y));
    rect.setAttribute("width", String(w));
    rect.setAttribute("height", String(h));
    rect.setAttribute("rx", String(small ? 2.5 : 4.5));
    rect.setAttribute("class", cls);
    svg.append(rect);
  }
  return svg;
}
