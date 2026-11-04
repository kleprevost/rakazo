import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every function that resolves a credential routes through the run principal. A lookup of a
 * credential table in the adapters or the db package must sit in a function that builds its owner
 * filter with `credentialOwner` or `principalAvailable`/`principalItemSecret`, checks a fetched
 * row with `ownedCredential`/`assertCredentialPrincipal`, or goes through `vaultFields`. A lookup
 * that resolves no credential (a count, an existence check, an admin sweep) says so with
 * `credential-lookup: exempt (<reason>)` inside the function.
 */
const DIRS = [join(__dirname), join(__dirname, "../../db/src")];
const MODELS = [
  "connection",
  "mcpServer",
  "mcpOAuthSession",
  "vaultCredential",
  "botSecret",
  "userModelCredential",
  "userVoiceCredential",
];
const LOOKUP = new RegExp(
  `\\.(?:${MODELS.join("|")})\\.(?:find\\w+|count|update\\w*|delete\\w*|upsert)\\(`,
  "g",
);
const GUARD =
  /\b(?:credentialOwner|principalAvailable|principalItemSecret|ownedCredential|assertCredentialPrincipal|vaultFields)\(/;
const EXEMPT = /credential-lookup: exempt \(\S[^)]*\)/;
// These fragment builders hide the owner behind a bare userId; adapters use the principal forms.
const BARE = /\b(?:availableInSpace|itemSecretIn)\(/;
const BARE_ALLOWED = new Set(["availability.ts", "credential-principal.ts", "skill-tools.ts"]);
const SKIP = (name: string) =>
  !name.endsWith(".ts") ||
  /\.(?:test|postgres\.test|test-support)\.ts$/.test(name) ||
  /(?:-fake|-emulator)\.ts$/.test(name) ||
  name === "credential-principal.ts";

function sources() {
  return DIRS.flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => !SKIP(name))
      .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") })),
  );
}

/** Same-length copy with string contents and comments blanked, so braces and calls line up. */
function blank(text: string): string {
  const fill = (m: string) => m.replace(/[^\n]/g, " ");
  return text
    .replace(/\/\*[\s\S]*?\*\//g, fill)
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p) => p + fill(m.slice(p.length)))
    .replace(/"(?:[^"\\\n]|\\.)*"/g, (m) => `"${" ".repeat(m.length - 2)}"`)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, (m) => `'${" ".repeat(m.length - 2)}'`);
}

function functionLike(code: string, brace: number): boolean {
  const before = code.slice(Math.max(0, brace - 300), brace).trimEnd();
  // An object literal or type: it follows an operator, an opening bracket or a keyword.
  if (/[(,:=[?|&<!+]$|\b(?:return|yield|await|typeof|of|in)$/.test(before)) return false;
  // A class, interface or enum body holds members; the member is the function.
  return !/\b(?:class|interface|enum|namespace)\b[^{}]*$/.test(before);
}

/** The outermost function or method containing `at`: its start and end offsets. */
function enclosingFunction(code: string, at: number): [number, number] | undefined {
  const stack: Array<{ start: number; fn: boolean }> = [];
  let found: [number, number] | undefined;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === "{") stack.push({ start: i, fn: functionLike(code, i) });
    else if (ch === "}") {
      const open = stack.pop();
      if (open?.fn && open.start < at && i > at && !stack.some((frame) => frame.fn)) {
        found = [open.start, i];
      }
    }
  }
  return found;
}

function lineOf(text: string, offset: number) {
  return text.slice(0, offset).split("\n").length;
}

describe("credential lookups route through the run principal", () => {
  it("guards every credential table lookup", () => {
    const unguarded: string[] = [];
    let seen = 0;
    for (const { name, text } of sources()) {
      const code = blank(text);
      for (const match of code.matchAll(LOOKUP)) {
        seen++;
        const at = match.index ?? 0;
        const range = enclosingFunction(code, at);
        const raw = range ? text.slice(range[0], range[1]) : "";
        const guarded = range && (GUARD.test(code.slice(range[0], range[1])) || EXEMPT.test(raw));
        if (!guarded) unguarded.push(`${name}:${lineOf(text, at)} ${match[0]}`);
      }
    }
    expect(seen).toBeGreaterThan(20);
    expect(unguarded).toEqual([]);
  });

  it("keeps the bare owner-filter helpers out of credential code", () => {
    const bare: string[] = [];
    for (const { name, text } of sources()) {
      if (BARE_ALLOWED.has(name)) continue;
      if (BARE.test(blank(text))) bare.push(name);
    }
    expect(bare).toEqual([]);
  });

  it("recognizes an unguarded lookup", () => {
    const code = blank(
      "async function leak(prisma) {\n  return prisma.connection.findFirst({});\n}",
    );
    const at = code.search(LOOKUP);
    const range = enclosingFunction(code, at);
    expect(range).toBeDefined();
    expect(GUARD.test(code.slice(range?.[0], range?.[1]))).toBe(false);
  });
});
