import type { Policy } from "@rakazo/contracts";
import { PolicySchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { computerImageCompliance, evaluateComputerImage } from "./policy-capabilities.js";

const policy = (rest: Omit<Policy, "version">): Policy => ({ version: 1, ...rest });
const digest = `sha256:${"a".repeat(64)}`;
const other = `sha256:${"b".repeat(64)}`;
const listed = policy({ computers: { images: { allow: [{ digest, tag: "2026.11" }] } } });

describe("computers.images schema", () => {
  const parse = (images: unknown) => PolicySchema.safeParse({ version: 1, computers: { images } });

  it("accepts digests with an optional tag and an empty list", () => {
    expect(parse({ allow: [] }).success).toBe(true);
    expect(parse({ allow: [{ digest }] }).success).toBe(true);
    expect(parse({ allow: [{ digest, tag: "2026.11" }] }).success).toBe(true);
  });

  it("rejects anything but a full sha256 digest, and unknown keys", () => {
    for (const bad of [
      "latest",
      "sha256:abc",
      `sha256:${"A".repeat(64)}`,
      `sha512:${"a".repeat(64)}`,
    ])
      expect(parse({ allow: [{ digest: bad }] }).success, bad).toBe(false);
    expect(parse({ allow: [{ digest, extra: 1 }] }).success).toBe(false);
    expect(parse({ allow: [], enforce: "block_new" }).success).toBe(false);
    expect(parse({}).success).toBe(false);
    expect(parse({ allow: [digest] }).success).toBe(false);
  });
});

describe("evaluateComputerImage", () => {
  const refused = { allowed: false, rule: "computers.images" };

  it("approves a digest-pinned reference whose digest is listed", () => {
    expect(evaluateComputerImage(listed, { ref: `registry.example/c@${digest}`, digest })).toEqual({
      allowed: true,
    });
  });

  it("refuses an unlisted digest, a tag-only reference and a mismatched pin", () => {
    expect(
      evaluateComputerImage(listed, { ref: `registry.example/c@${other}`, digest: other }),
    ).toEqual(refused);
    expect(evaluateComputerImage(listed, { ref: "registry.example/c:latest", digest })).toEqual(
      refused,
    );
    expect(evaluateComputerImage(listed, { ref: `registry.example/c@${other}`, digest })).toEqual(
      refused,
    );
    expect(evaluateComputerImage(listed, { ref: "registry.example/c:latest" })).toEqual(refused);
  });

  it("approves nothing without a list", () => {
    expect(evaluateComputerImage(undefined, { ref: `c@${digest}`, digest })).toEqual(refused);
    expect(
      evaluateComputerImage(policy({ computers: {} }), { ref: `c@${digest}`, digest }),
    ).toEqual(refused);
  });
});

describe("computerImageCompliance", () => {
  it("checks nothing without a list", () => {
    expect(computerImageCompliance(undefined, { digest: other })).toBeNull();
    expect(computerImageCompliance(policy({ computers: {} }), { digest: other })).toBeNull();
  });

  it("grades what runs against the list", () => {
    expect(computerImageCompliance(listed, { digest })).toBe("approved");
    expect(computerImageCompliance(listed, { ref: "c", digest: other })).toBe("not_approved");
    expect(computerImageCompliance(listed, { ref: "registry.example/c:latest" })).toBe(
      "not_approved",
    );
    expect(computerImageCompliance(listed, {})).toBe("unknown");
    expect(computerImageCompliance(listed, { ref: null, digest: null })).toBe("unknown");
  });
});
