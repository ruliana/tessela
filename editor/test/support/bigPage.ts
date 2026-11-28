// A long page for timing the editor: the same page every time (a seeded generator, no randomness
// from outside), shaped like notes people really keep and using every construct that a built-in
// extension or mod draws: front matter, headings, bold, italic, code, links, tags, dates, nested
// lists and tasks, tables, fences (also the ones mods draw), callouts, quotes, footnotes and math.

/** A small seeded generator (mulberry32), so that a page is the same on every machine. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = "rust editor note link page agent model speed typing reading search index cache block parser tree garden memory focus decision value flow design".split(" ");

/** A page of at least `lines` lines. */
export function bigPage(lines: number, seed = 1): string {
  const rand = seeded(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const word = () => pick(WORDS);
  const sentence = (n = 8 + Math.floor(rand() * 14)) => Array.from({ length: n }, word).join(" ");
  /** A line of prose with the inline constructs that notes have. */
  const prose = (): string => {
    const parts: string[] = [];
    for (let i = 0, n = 2 + Math.floor(rand() * 4); i < n; i++) {
      const kind = Math.floor(rand() * 10);
      const w = sentence(3 + Math.floor(rand() * 4));
      parts.push(
        kind === 0 ? `**${w}**`
        : kind === 1 ? `*${w}*`
        : kind === 2 ? `\`${word()}\``
        : kind === 3 ? `[${w}](/topics/${word()}-${Math.floor(rand() * 900)}.md)`
        : kind === 4 ? `#${word()}`
        : kind === 5 ? `2026-11-${String(1 + Math.floor(rand() * 28)).padStart(2, "0")}`
        : kind === 6 ? `~~${word()}~~`
        : kind === 7 && rand() < 0.3 ? `$x_${Math.floor(rand() * 9)}^2$`
        : w,
      );
    }
    return parts.join(" ");
  };

  const out: string[] = ["---", "title: A long page", "type: note", "tags: [speed, typing]", "---", "", "# A long page", ""];
  let footnotes = 0;
  for (let section = 0; out.length < lines; section++) {
    out.push(`## Section ${section}: ${sentence(3)}`, "");
    for (let b = 0, blocks = 3 + Math.floor(rand() * 4); b < blocks; b++) {
      const kind = Math.floor(rand() * 12);
      if (kind < 4) {
        out.push(prose(), prose(), "");
      } else if (kind < 8) {
        for (let i = 0, n = 3 + Math.floor(rand() * 4); i < n; i++) {
          out.push(`${rand() < 0.3 ? "- [ ] " : "- "}${prose()}`);
          if (rand() < 0.6) {
            out.push(`  - ${prose()}`);
            if (rand() < 0.4) out.push(`    - ${sentence()}`);
          }
        }
        out.push("");
      } else if (kind === 8) {
        out.push("| name | value | note |", "| --- | --- | --- |");
        for (let r = 0; r < 4; r++) out.push(`| ${word()} | ${Math.floor(rand() * 1000)} | ${sentence(3)} |`);
        out.push("");
      } else if (kind === 9) {
        out.push("```ts", `const ${word()} = ${Math.floor(rand() * 100)};`, `console.log(${word()});`, "```", "");
      } else if (kind === 10) {
        out.push(`> [!${pick(["NOTE", "TIP", "WARNING"])}]`, `> ${prose()}`, `> ${sentence()}`, "");
      } else {
        footnotes++;
        out.push(`${prose()}[^${footnotes}]`, "", "$$", `\\sum_{i=0}^{${Math.floor(rand() * 9)}} x_i`, "$$", "");
      }
    }
  }
  for (let n = 1; n <= footnotes; n++) out.push(`[^${n}]: ${sentence()}`, "");
  return out.join("\n");
}
