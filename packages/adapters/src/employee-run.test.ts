import { describe, expect, it, vi } from "vitest";
import { resolveEmployeeRun } from "./employee-run.js";

const bot = {
  id: "bot-1",
  userId: "user-1",
  employeeId: "emp-1",
  employeeVersionSeen: null as string | null,
  description: "mine",
  instructions: "",
  disabledBuiltinTools: [] as string[],
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
};

function fakePrisma(
  options: {
    entitlements?: { role: string; source: string }[];
    employee?: Record<string, unknown> | null;
  } = {},
) {
  const update = vi.fn().mockResolvedValue({});
  const prisma = {
    employee: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          options.employee === undefined
            ? { id: "emp-1", status: "published", suspendedAt: null, currentVersionId: "v2" }
            : options.employee,
        ),
    },
    employeeEntitlement: {
      findMany: vi
        .fn()
        .mockResolvedValue(options.entitlements ?? [{ role: "collaborator", source: "grant" }]),
    },
    employeeVersion: {
      findFirst: vi.fn().mockResolvedValue({
        id: "v2",
        role: "Analyst",
        instructions: "Definition",
        capabilityPolicy: {},
        modelPolicy: {},
      }),
      findMany: vi.fn().mockResolvedValue([{ instructions: "Definition" }]),
    },
    bot: { update },
  };
  return { prisma: prisma as never, update };
}

describe("resolveEmployeeRun", () => {
  it("composes the current published version and records it as seen", async () => {
    const { prisma, update } = fakePrisma();
    const result = await resolveEmployeeRun(prisma, bot);
    expect(result).toMatchObject({
      ok: true,
      composed: { description: "Analyst", instructions: "Definition" },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "bot-1" },
      data: { employeeVersionSeen: "v2" },
    });
  });

  it("does not write again when the version was already seen", async () => {
    const { prisma, update } = fakePrisma();
    await resolveEmployeeRun(prisma, { ...bot, employeeVersionSeen: "v2" });
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses without a usable entitlement", async () => {
    for (const entitlements of [[], [{ role: "viewer", source: "grant" }]]) {
      const { prisma, update } = fakePrisma({ entitlements });
      expect(await resolveEmployeeRun(prisma, bot)).toEqual({
        ok: false,
        message: "Access removed",
      });
      expect(update).not.toHaveBeenCalled();
    }
  });

  it("refuses a suspended, retired or missing employee", async () => {
    const base = { id: "emp-1", currentVersionId: "v2" };
    const messages = await Promise.all(
      [
        { ...base, status: "published", suspendedAt: new Date() },
        { ...base, status: "retired", suspendedAt: null },
        null,
        { ...base, status: "published", suspendedAt: null, currentVersionId: null },
      ].map(async (employee) => {
        const result = await resolveEmployeeRun(fakePrisma({ employee }).prisma, bot);
        return result.ok ? "ok" : result.message;
      }),
    );
    expect(messages).toEqual([
      "This employee is suspended",
      "This employee is no longer available",
      "This employee is no longer available",
      "This employee is no longer available",
    ]);
  });
});
