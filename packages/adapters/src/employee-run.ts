import {
  EMPLOYEE_ACCESS_REMOVED_MESSAGE,
  EMPLOYEE_SUSPENDED_MESSAGE,
  EMPLOYEE_UNAVAILABLE_MESSAGE,
  EmployeeRoleSchema,
} from "@rakazo/contracts";
import type { ComposedEmployeeBot } from "@rakazo/core";
import { composeEmployeeBot, effectiveEmployeeRole, evaluateEmployeeAccess } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

type EmployeeRunBotRow = {
  id: string;
  userId: string;
  employeeId: string | null;
  employeeVersionSeen: string | null;
  description: string;
  instructions: string;
  disabledBuiltinTools: string[];
  modelProvider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
};

export type EmployeeRun =
  | { ok: true; composed: ComposedEmployeeBot }
  | { ok: false; message: string };

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * Decides whether an employee instance may run now and, if so, what it runs. Called at every run
 * start by the worker, so a person who lost access, a suspended employee or a retired one stops
 * here whatever started the run. Their data is left alone: the instance stays, inert.
 */
export async function resolveEmployeeRun(
  prisma: Pick<PrismaClient, "employee" | "employeeEntitlement" | "employeeVersion" | "bot">,
  bot: EmployeeRunBotRow,
): Promise<EmployeeRun> {
  const employeeId = bot.employeeId;
  if (!employeeId) return { ok: false, message: EMPLOYEE_UNAVAILABLE_MESSAGE };
  const [employee, entitlements] = await Promise.all([
    prisma.employee.findUnique({ where: { id: employeeId } }),
    prisma.employeeEntitlement.findMany({
      where: { employeeId, userId: bot.userId },
      select: { role: true, source: true },
    }),
  ]);
  if (!employee) return { ok: false, message: EMPLOYEE_UNAVAILABLE_MESSAGE };
  const role = effectiveEmployeeRole(
    entitlements.flatMap((row) => {
      const parsed = EmployeeRoleSchema.safeParse(row.role);
      return parsed.success && (row.source === "grant" || row.source === "claim")
        ? [{ role: parsed.data, source: row.source }]
        : [];
    }),
  );
  const decision = evaluateEmployeeAccess({
    role,
    action: "use",
    employee: {
      status:
        employee.status === "draft" || employee.status === "retired"
          ? employee.status
          : "published",
      suspendedAt: employee.suspendedAt,
    },
  });
  if (!decision.allowed) {
    if (decision.reason === "suspended") return { ok: false, message: EMPLOYEE_SUSPENDED_MESSAGE };
    if (decision.reason === "retired") return { ok: false, message: EMPLOYEE_UNAVAILABLE_MESSAGE };
    return { ok: false, message: EMPLOYEE_ACCESS_REMOVED_MESSAGE };
  }
  if (!employee.currentVersionId) return { ok: false, message: EMPLOYEE_UNAVAILABLE_MESSAGE };
  const [version, published] = await Promise.all([
    prisma.employeeVersion.findFirst({
      where: { id: employee.currentVersionId, employeeId, state: "published" },
    }),
    prisma.employeeVersion.findMany({
      where: { employeeId, state: "published" },
      select: { instructions: true },
    }),
  ]);
  if (!version) return { ok: false, message: EMPLOYEE_UNAVAILABLE_MESSAGE };
  // The next run after a publish or rollback picks the new version up; this records which one ran.
  if (bot.employeeVersionSeen !== version.id) {
    await prisma.bot
      .update({ where: { id: bot.id }, data: { employeeVersionSeen: version.id } })
      .catch(() => undefined);
  }
  return {
    ok: true,
    composed: composeEmployeeBot(
      bot,
      {
        role: version.role,
        instructions: version.instructions,
        capabilityPolicy: asRecord(version.capabilityPolicy),
        modelPolicy: asRecord(version.modelPolicy),
      },
      published.map((row) => row.instructions),
    ),
  };
}
