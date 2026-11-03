import { describe, expect, it } from "vitest";
import {
  mintSupervisorProxyCapability,
  supervisorProxyAuthorization,
  supervisorProxyCapabilityFromAuthorization,
  verifySupervisorProxyCapability,
} from "./supervisor-proxy-capability.js";

const token = "supervisor-token-at-least-32-characters";
const now = 1_800_000_000_000;
const grant = { computerId: "abc123", port: 6080, purpose: "screen" as const };

describe("supervisor proxy capability", () => {
  it("round-trips the computer, port and purpose it was minted for", () => {
    const capability = mintSupervisorProxyCapability(token, grant, now);
    expect(verifySupervisorProxyCapability(token, capability, now)).toMatchObject(grant);
  });

  it("is byte-identical within a window so a sealed screen can be reused", () => {
    expect(mintSupervisorProxyCapability(token, grant, now)).toBe(
      mintSupervisorProxyCapability(token, grant, now + 30_000),
    );
  });

  it("outlives a sealed screen capability and then expires", () => {
    const capability = mintSupervisorProxyCapability(token, grant, now);
    const claims = verifySupervisorProxyCapability(token, capability, now);
    expect(claims!.expiresAt - now).toBeGreaterThanOrEqual(65 * 60_000);
    expect(claims!.expiresAt - now).toBeLessThanOrEqual(71 * 60_000);
    expect(
      verifySupervisorProxyCapability(token, capability, claims!.expiresAt - 1),
    ).not.toBeNull();
    expect(verifySupervisorProxyCapability(token, capability, claims!.expiresAt)).toBeNull();
  });

  it("is not valid under another token", () => {
    const capability = mintSupervisorProxyCapability(token, grant, now);
    expect(verifySupervisorProxyCapability(`${token}-other`, capability, now)).toBeNull();
  });

  it("rejects a payload or signature that was altered", () => {
    const [prefix, payload, signature] = mintSupervisorProxyCapability(token, grant, now).split(
      ".",
    );
    const forged = Buffer.from(
      JSON.stringify(["other", 6080, "screen", now + 60 * 60_000]),
    ).toString("base64url");
    expect(
      verifySupervisorProxyCapability(token, `${prefix}.${forged}.${signature}`, now),
    ).toBeNull();
    const flipped = `${signature!.slice(0, -2)}${signature!.endsWith("AA") ? "BB" : "AA"}`;
    expect(
      verifySupervisorProxyCapability(token, `${prefix}.${payload}.${flipped}`, now),
    ).toBeNull();
    expect(verifySupervisorProxyCapability(token, `${prefix}.${payload}.`, now)).toBeNull();
    expect(verifySupervisorProxyCapability(token, `v2.${payload}.${signature}`, now)).toBeNull();
  });

  it("rejects missing and malformed values", () => {
    for (const value of [undefined, "", "rsc1", "rsc1.a", "rsc1.a.b.c", token]) {
      expect(verifySupervisorProxyCapability(token, value, now)).toBeNull();
    }
  });

  it("refuses to mint for an unsafe computer id or a privileged port", () => {
    expect(() => mintSupervisorProxyCapability(token, { ...grant, computerId: "a/b" })).toThrow();
    expect(() => mintSupervisorProxyCapability(token, { ...grant, computerId: ".." })).toThrow();
    expect(() => mintSupervisorProxyCapability(token, { ...grant, port: 22 })).toThrow();
    expect(() => mintSupervisorProxyCapability(token, { ...grant, port: 6080.5 })).toThrow();
  });

  it("travels as a bearer credential", () => {
    const capability = mintSupervisorProxyCapability(token, grant, now);
    expect(
      supervisorProxyCapabilityFromAuthorization(supervisorProxyAuthorization(capability)),
    ).toBe(capability);
    expect(supervisorProxyCapabilityFromAuthorization("Basic abc")).toBeUndefined();
  });
});
