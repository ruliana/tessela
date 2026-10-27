// What the problems panel shows: the findings of `tessela lint`, errors first.

import type { Diagnostic, Severity } from "./api";

const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** Findings that matter while writing. `info` (unwritten concepts) is the normal state of a notebook. */
export function visibleProblems(all: Diagnostic[]): Diagnostic[] {
  return all
    .filter((d) => d.severity !== "info")
    .sort(
      (a, b) =>
        order[a.severity] - order[b.severity] ||
        a.path.localeCompare(b.path) ||
        (a.line ?? 0) - (b.line ?? 0),
    );
}

export function summary(problems: Diagnostic[]): string {
  const count = (s: Severity) => problems.filter((d) => d.severity === s).length;
  const errors = count("error");
  const warnings = count("warning");
  if (errors + warnings === 0) return "No problems";
  const part = (n: number, word: string) => (n === 0 ? [] : [`${n} ${word}${n === 1 ? "" : "s"}`]);
  return [...part(errors, "error"), ...part(warnings, "warning")].join(", ");
}
