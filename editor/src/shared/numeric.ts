// Which table columns are numbers. A column of numbers reads best right-aligned, so it is the
// alignment a column gets when nobody chose one: smart paste writes `---:` for it, and a table
// that was written without a choice is drawn the same way (an explicit `:---` or `:-:` still wins).

/** A number as people write it in a cell: a sign, a currency sign, grouped digits, a decimal part, an exponent, a percent. */
const NUMBER = /^[-+−]?[$€£¥]?[-+−]?(?:\d[\d,.   ]*|[,.]\d+)(?:[eE][-+]?\d+)?\s*%?$/;

export function isNumeric(text: string): boolean {
  return NUMBER.test(text.trim());
}

/**
 * Whether each column of a table is a column of numbers: every cell under the header that has
 * anything in it is a number, and at least one has. `rows` are the rows under the header.
 */
export function numericColumns(rows: readonly (readonly string[])[], width: number): boolean[] {
  return Array.from({ length: width }, (_, c) => {
    const filled = rows.map((r) => (r[c] ?? "").trim()).filter((t) => t !== "");
    return filled.length > 0 && filled.every(isNumeric);
  });
}
