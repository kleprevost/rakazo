import { resolveSupervisorToken } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { loadSupervisorPolicy, requestedImageApproved } from "./image-policy.js";
import { supervisorApp } from "./index.js";

const digest = `sha256:${"a".repeat(64)}`;
const image = { ref: `registry.example/computer@${digest}`, digest };
const policyText = JSON.stringify({
  version: 1,
  computers: { images: { allow: [{ digest, tag: "2026.11" }] } },
});

describe("supervisor image policy", () => {
  it("has no policy without the variable, and then approves no image", () => {
    expect(loadSupervisorPolicy({}, () => "")).toBeUndefined();
    expect(requestedImageApproved(undefined, image)).toBe(false);
  });

  it("reads the same policy file and approves only a listed, digest-pinned image", () => {
    const policy = loadSupervisorPolicy(
      { RAKAZO_POLICY_FILE: "/data/policy.yaml" },
      () => policyText,
    );
    expect(requestedImageApproved(policy, image)).toBe(true);
    const other = `sha256:${"b".repeat(64)}`;
    expect(
      requestedImageApproved(policy, { ref: `registry.example/computer@${other}`, digest: other }),
    ).toBe(false);
    expect(
      requestedImageApproved(policy, { ref: "registry.example/computer:latest", digest }),
    ).toBe(false);
  });

  it("fails closed on an unreadable or invalid file", () => {
    expect(() =>
      loadSupervisorPolicy({ RAKAZO_POLICY_FILE: "/missing" }, () => {
        throw Object.assign(new Error("nope"), { code: "ENOENT" });
      }),
    ).toThrow("could not be read: ENOENT");
    expect(() =>
      loadSupervisorPolicy(
        { RAKAZO_POLICY_FILE: "/p" },
        () => '{"version":1,"computers":{"images":{}}}',
      ),
    ).toThrow("invalid");
  });
});

describe("supervisor provision request with a named image", () => {
  it("refuses an image when it holds no policy, before any Docker call", async () => {
    const response = await supervisorApp.request("/computers", {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "content-type": "application/json",
        "x-rakazo-bot-id": "bot-1",
        "x-rakazo-space-id": "space-1",
      },
      body: JSON.stringify({
        botId: "bot-1",
        spaceId: "space-1",
        homePath: "/data/homes/bot-1",
        image,
      }),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "image not approved" });
  });
});
