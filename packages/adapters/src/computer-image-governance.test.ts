import type {
  AdapterContext,
  AgentHomeStore,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { installSecurityEventStore } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { provisionComputer } from "./computer-lifecycle.js";
import { setActivePolicy } from "./policy-runtime.js";

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
} satisfies AdapterContext;

const digest = `sha256:${"a".repeat(64)}`;
const image = { ref: `registry.example/computer@${digest}`, digest };
const created: Array<{ data: Record<string, unknown> }> = [];

function setup(capabilities: Record<string, unknown>) {
  installSecurityEventStore({
    securityEvent: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => created.push(args)),
    },
  } as never);
  const findUniqueOrThrow = vi.fn();
  const provision = vi.fn();
  return {
    findUniqueOrThrow,
    provision,
    deps: {
      prisma: { computer: { findUniqueOrThrow } } as unknown as PrismaClient,
      sandbox: { provision, describe: () => ({ capabilities }) } as unknown as SandboxProvider,
      home: {} as AgentHomeStore,
      jobs: {} as JobPublisher,
      events: {} as ThreadEvents,
    },
  };
}

const start = (deps: ReturnType<typeof setup>["deps"], requested = image) =>
  provisionComputer(deps, "computer-1", context, "none", undefined, requested);

afterEach(() => {
  created.length = 0;
  setActivePolicy(undefined);
  installSecurityEventStore(undefined);
});

describe("provisioning from a named image", () => {
  it("refuses an unlisted digest before reading the computer or calling the provider, and audits the digest only", async () => {
    setActivePolicy({
      version: 1,
      computers: { images: { allow: [{ digest: `sha256:${"b".repeat(64)}` }] } },
    });
    const { deps, findUniqueOrThrow, provision } = setup({ fleet: { imageSelection: true } });
    await expect(start(deps)).rejects.toMatchObject({ reason: "policy", rule: "computers.images" });
    expect(findUniqueOrThrow).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
    expect(created.map(({ data }) => data.type)).toEqual(["computer.image_refused"]);
    expect(created[0]?.data.metadata).toMatchObject({ digest, rule: "computers.images" });
    expect(JSON.stringify(created)).not.toContain("registry.example");
  });

  it("refuses every image when the policy lists none", async () => {
    const { deps, provision } = setup({ fleet: { imageSelection: true } });
    await expect(start(deps)).rejects.toMatchObject({ rule: "computers.images" });
    expect(provision).not.toHaveBeenCalled();
    expect(created).toHaveLength(1);
  });

  it("refuses a tag-only reference even when its digest is listed", async () => {
    setActivePolicy({ version: 1, computers: { images: { allow: [{ digest }] } } });
    const { deps, provision } = setup({ fleet: { imageSelection: true } });
    await expect(
      start(deps, { ref: "registry.example/computer:latest", digest }),
    ).rejects.toMatchObject({ rule: "computers.images" });
    expect(provision).not.toHaveBeenCalled();
  });

  it("refuses an approved image on a provider that cannot select one", async () => {
    setActivePolicy({ version: 1, computers: { images: { allow: [{ digest }] } } });
    const { deps, findUniqueOrThrow } = setup({ fleet: { inspect: true } });
    await expect(start(deps)).rejects.toThrow("cannot start from a named image");
    expect(findUniqueOrThrow).not.toHaveBeenCalled();
    expect(created).toEqual([]);
  });

  it("lets an approved image through to the computer lookup", async () => {
    setActivePolicy({ version: 1, computers: { images: { allow: [{ digest }] } } });
    const { deps, findUniqueOrThrow } = setup({ fleet: { imageSelection: true } });
    findUniqueOrThrow.mockRejectedValue(new Error("lookup reached"));
    await expect(start(deps)).rejects.toThrow("lookup reached");
    expect(created).toEqual([]);
  });
});
