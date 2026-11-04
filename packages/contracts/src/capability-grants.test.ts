import { describe, expect, it } from "vitest";
import { CapabilitySimulateInputSchema, CapabilitySimulationSchema } from "./capability-grants.js";

describe("capability simulator contract", () => {
  it("names a tool or a scope, never both or neither", () => {
    const ok = (input: object) => CapabilitySimulateInputSchema.safeParse(input).success;
    expect(ok({ botId: "b", tool: "web_fetch" })).toBe(true);
    expect(ok({ botId: "b", tool: "create_event", server: "cal", args: { title: "x" } })).toBe(
      true,
    );
    expect(ok({ botId: "b", scope: "calendar.read" })).toBe(true);
    expect(ok({ botId: "b" })).toBe(false);
    expect(ok({ botId: "b", tool: "web_fetch", scope: "web.fetch" })).toBe(false);
    expect(ok({ botId: "b", scope: "not.a-scope" })).toBe(false);
    expect(ok({ botId: "b", tool: "t", args: { nested: { a: 1 } } })).toBe(false);
  });

  it("carries scope names, rule names and ids only", () => {
    const result = CapabilitySimulationSchema.parse({
      outcome: "deny",
      rule: "no_grant",
      scopes: ["files.write"],
      basis: "builtin",
      unmapped: false,
      mode: "shadow",
      enforced: false,
      trace: [{ layer: "grant", rule: "no_grant", scope: "files.write", effect: "deny" }],
      args: { path: "/secret" },
    });
    expect(Object.keys(result).sort()).toEqual(
      ["basis", "enforced", "mode", "outcome", "rule", "scopes", "trace", "unmapped"].sort(),
    );
  });
});
