// The mod-writing skill (skills/tessela-mods/SKILL.md) is the one description of the mod API for
// agents, and the config folder's AGENTS.md is a copy of it. It must not drift: whatever `ctx` has
// today (the hooks, the events, the overrides, the slots, the built-in commands a mod can replace)
// has to be in it by name.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const editor = path.resolve(import.meta.dirname, "..");
const skillFile = path.resolve(editor, "../skills/tessela-mods/SKILL.md");
const skill = readFileSync(skillFile, "utf8");
const read = (file: string) => readFileSync(path.join(editor, file), "utf8");

/** Splits `text` at the `;` that are not inside any brackets. */
function topLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    if ("{([".includes(text[i]!)) depth++;
    else if ("})]".includes(text[i]!)) depth--;
    else if (text[i] === ";" && depth === 0) {
      parts.push(text.slice(from, i).trim());
      from = i + 1;
    }
  }
  parts.push(text.slice(from).trim());
  return parts.filter((p) => p !== "");
}

/**
 * Every `hook` and `hook.member` of the `ModContext` interface, read from its source (the compiler's
 * own API is not available to tests): a hook is a member of the interface, and its members are the
 * members of the `{ ... }` its type is, when it is one.
 */
function contextNames(): string[] {
  const source = read("src/renderer/mods.ts");
  const start = source.indexOf("export interface ModContext {");
  const text = source
    .slice(start)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/"[^"\n]*"/g, '""');
  // From the interface's opening brace to the closing one.
  let depth = 0;
  let end = 0;
  for (let i = text.indexOf("{"); i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  const names: string[] = [];
  for (const member of topLevel(text.slice(text.indexOf("{") + 1, end))) {
    const head = /^(?:readonly\s+)?(\w+)\??\s*([:(<])\s*(\{)?/.exec(member);
    if (!head) continue;
    names.push(head[1]!);
    if (head[3] && head[1] !== "cm") {
      const inner = member.slice(member.indexOf("{") + 1, member.lastIndexOf("}"));
      for (const sub of topLevel(inner)) {
        const m = /^(\w+)\??\s*[:(<]/.exec(sub);
        if (m) names.push(`${head[1]}.${m[1]}`);
      }
    }
  }
  return names;
}

const quoted = (text: string) => [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);

describe("the mod-writing skill", () => {
  it("names itself and says when to use it", () => {
    expect(skill).toMatch(/^---\nname: tessela-mods\ndescription: .+\n---\n/);
  });

  it("documents every hook of ctx, and every member of each", () => {
    const names = contextNames();
    expect(names.length).toBeGreaterThan(30);
    const missing = names.filter((n) => !skill.includes(`ctx.${n}`));
    expect(missing).toEqual([]);
  });

  it("documents every event, override, slot and built-in command a mod can use or replace", () => {
    const mods = read("src/shared/mods.ts");
    const events = mods.match(/interface ModEvents \{([\s\S]*?)\n\}/)![1]!.matchAll(/^  "?([\w-]+)"?:/gm);
    const overrides = mods.match(/interface ModOverrides \{([\s\S]*?)\n\}/)![1]!.matchAll(/^  ([\w-]+):/gm);
    const slots = quoted(read("src/renderer/mods.ts").match(/mount\(slot: ([^)]*)\)/)![1]!);
    const builtin = [...read("src/renderer/main.ts").match(/function builtinCommands[\s\S]*?\n\}/)![0].matchAll(/\{ id: "([\w-]+)"/g)].map((m) => m[1]!);
    const wanted = [...[...events].map((m) => m[1]!), ...[...overrides].map((m) => m[1]!), ...slots, ...builtin];
    expect(wanted.length).toBeGreaterThan(20);
    const missing = wanted.filter((n) => !skill.includes(`\`${n}\``) && !skill.includes(`"${n}"`));
    expect(missing).toEqual([]);
  });
});
