// What the built-in mods share for talking to the tessela command: the shape of an answer and a
// `cli` that says what it expects back. Each mod is built into one file with what it imports from here.

import type { ModContext } from "../renderer/mods";

export type Failure = { ok: false; error: { code: string; message: string } };
export type Answer<T> = ({ ok: true } & T) | Failure;

/** `ctx.cli`, with the answer typed: `cli<{ hits: Hit[] }>(["query", ...])`. */
export const cliOf =
  (ctx: ModContext) =>
  <T>(argv: string[], input?: string | Uint8Array): Promise<Answer<T>> =>
    ctx.cli(argv, input === undefined ? undefined : { input }) as Promise<Answer<T>>;

/** What a failed answer says. */
export function failureText(answer: unknown): string {
  const e = (answer as { error?: { message?: unknown } } | null)?.error;
  return typeof e?.message === "string" ? e.message : "the tessela command failed";
}
