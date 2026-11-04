import { ORPCError } from "@orpc/server";
import type { Actor, EmployeeKnowledge, EmployeeKnowledgeProposal } from "@rakazo/contracts";
import { looksLikeCredential } from "@rakazo/core";
import { recordSecurityEvent, runAsSystem } from "@rakazo/db";
import { authorize, lockEmployee } from "./employees.js";
import type { RouterDeps } from "./router.js";

/**
 * Shared knowledge and proposals. Approved knowledge is a definition-level table that every
 * instance reads at run time; a proposal is text a person chose to offer, copied at that moment
 * with no pointer to the private note it came from. Nothing here reads a thread, message, memory
 * document or secret. Writes run as system inside one transaction that holds the employee row,
 * after the role check, so two reviewers cannot approve conflicting text at once.
 */

type KnowledgeDeps = Pick<RouterDeps, "prisma" | "env">;

/** Approved paths per employee, and open proposals per person and employee. */
const MAX_APPROVED_PATHS = 100;
const MAX_OPEN_PROPOSALS = 20;
const LIST_LIMIT = 200;

const system = <T>(what: string, fn: () => Promise<T>) =>
  runAsSystem(`employee knowledge: ${what}`, fn);

function requireEnabled(deps: KnowledgeDeps) {
  if (!deps.env.sharedEmployeesEnabled)
    throw new ORPCError("FORBIDDEN", { message: "Shared employees are not turned on" });
}

/** Deterministic, never echoes the value. A credential must not reach every colleague's prompt. */
function refuseCredentials(...texts: string[]) {
  if (texts.some(looksLikeCredential))
    throw new ORPCError("BAD_REQUEST", { message: "This looks like it contains a credential" });
}

const stale = (message: string) => new ORPCError("CONFLICT", { message });

/** Approved knowledge, for anyone who may use the employee. */
export async function listKnowledge(
  deps: KnowledgeDeps,
  actor: Actor,
  input: { employeeId: string },
): Promise<EmployeeKnowledge[]> {
  requireEnabled(deps);
  await authorize(deps.prisma, actor.userId, input.employeeId, "propose_knowledge");
  const rows = await deps.prisma.employeeKnowledge.findMany({
    where: { employeeId: input.employeeId, state: "approved" },
    orderBy: [{ path: "asc" }],
    take: LIST_LIMIT,
  });
  return rows.map((row) => ({
    path: row.path,
    content: row.content,
    revision: row.revision,
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export async function proposeKnowledge(
  deps: KnowledgeDeps,
  actor: Actor,
  input: { employeeId: string; path: string; content: string },
): Promise<{ ok: true }> {
  requireEnabled(deps);
  const { employeeId, path, content } = input;
  await authorize(deps.prisma, actor.userId, employeeId, "propose_knowledge");
  refuseCredentials(path, content);
  const proposalId = await system("propose", () =>
    deps.prisma.$transaction(async (tx) => {
      await lockEmployee(tx, employeeId);
      await authorize(tx, actor.userId, employeeId, "propose_knowledge");
      const current = await tx.employeeKnowledge.findUnique({
        where: { employeeId_path: { employeeId, path } },
        select: { revision: true },
      });
      const open = await tx.employeeKnowledgeProposal.findFirst({
        where: { employeeId, proposedByUserId: actor.userId, path, status: "pending" },
        select: { id: true },
      });
      // Offering the same path again replaces the open text instead of piling up copies.
      if (open) {
        await tx.employeeKnowledgeProposal.update({
          where: { id: open.id },
          data: { proposedContent: content, baseRevision: current?.revision ?? null },
        });
        return open.id;
      }
      const openCount = await tx.employeeKnowledgeProposal.count({
        where: { employeeId, proposedByUserId: actor.userId, status: "pending" },
      });
      if (openCount >= MAX_OPEN_PROPOSALS)
        throw new ORPCError("BAD_REQUEST", { message: "Too many suggestions are waiting" });
      const created = await tx.employeeKnowledgeProposal.create({
        data: {
          employeeId,
          proposedByUserId: actor.userId,
          path,
          proposedContent: content,
          baseRevision: current?.revision ?? null,
        },
        select: { id: true },
      });
      return created.id;
    }),
  );
  await recordSecurityEvent({
    type: "employee.knowledge_proposed",
    userId: actor.userId,
    spaceId: actor.spaceId,
    metadata: { employeeId, proposalId },
  });
  return { ok: true };
}

/** Pending proposals for Owners and Managers. The proposer is deliberately not returned. */
export async function listProposals(
  deps: KnowledgeDeps,
  actor: Actor,
  input: { employeeId: string },
): Promise<EmployeeKnowledgeProposal[]> {
  requireEnabled(deps);
  const { employeeId } = input;
  await authorize(deps.prisma, actor.userId, employeeId, "approve_knowledge");
  const rows = await deps.prisma.employeeKnowledgeProposal.findMany({
    where: { employeeId, status: "pending" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: LIST_LIMIT,
  });
  const current = await deps.prisma.employeeKnowledge.findMany({
    where: { employeeId, path: { in: rows.map((row) => row.path) } },
    select: { path: true, content: true, revision: true, state: true },
  });
  const byPath = new Map(current.map((row) => [row.path, row]));
  return rows.map((row) => {
    const existing = byPath.get(row.path);
    return {
      id: row.id,
      path: row.path,
      content: row.proposedContent,
      currentContent: existing?.state === "approved" ? existing.content : null,
      stale: (existing?.revision ?? null) !== row.baseRevision,
      createdAt: row.createdAt.toISOString(),
    };
  });
}

export async function listOwnProposals(
  deps: KnowledgeDeps,
  actor: Actor,
  input: { employeeId: string },
) {
  requireEnabled(deps);
  await authorize(deps.prisma, actor.userId, input.employeeId, "propose_knowledge");
  const rows = await deps.prisma.employeeKnowledgeProposal.findMany({
    where: { employeeId: input.employeeId, proposedByUserId: actor.userId, status: "pending" },
    select: { id: true, path: true, createdAt: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: LIST_LIMIT,
  });
  return rows.map((row) => ({
    id: row.id,
    path: row.path,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function withdrawProposal(
  deps: KnowledgeDeps,
  actor: Actor,
  input: { employeeId: string; proposalId: string },
): Promise<{ ok: true }> {
  requireEnabled(deps);
  const { employeeId, proposalId } = input;
  await authorize(deps.prisma, actor.userId, employeeId, "view_card");
  const closed = await system("withdraw", () =>
    deps.prisma.employeeKnowledgeProposal.updateMany({
      where: { id: proposalId, employeeId, proposedByUserId: actor.userId, status: "pending" },
      data: { status: "withdrawn", decidedAt: new Date() },
    }),
  );
  if (closed.count !== 1) throw new ORPCError("NOT_FOUND", { message: "Suggestion not found" });
  return { ok: true };
}

type Tx = Parameters<Parameters<KnowledgeDeps["prisma"]["$transaction"]>[0]>[0];

/**
 * Writes the next approved revision of a path (creating it, or reviving a retired one). The caller
 * holds the employee lock and has already checked the role and the expected revision.
 */
async function writeRevision(
  tx: Tx,
  input: { employeeId: string; path: string; content: string; approvedBy: string },
) {
  const { employeeId, path, content, approvedBy } = input;
  const existing = await tx.employeeKnowledge.findUnique({
    where: { employeeId_path: { employeeId, path } },
  });
  if (existing?.state !== "approved") {
    const active = await tx.employeeKnowledge.count({ where: { employeeId, state: "approved" } });
    if (active >= MAX_APPROVED_PATHS)
      throw new ORPCError("BAD_REQUEST", { message: "Shared knowledge is full" });
  }
  const revision = (existing?.revision ?? 0) + 1;
  const row = existing
    ? await tx.employeeKnowledge.update({
        where: { id: existing.id },
        data: { content, revision, state: "approved", approvedBy },
      })
    : await tx.employeeKnowledge.create({
        data: { employeeId, path, content, revision, approvedBy },
      });
  await tx.employeeKnowledgeRevision.create({
    data: { knowledgeId: row.id, revision, content, approvedBy },
  });
  return row;
}

/** Direct edit by an Owner or Manager, against the revision they loaded. */
export async function setKnowledge(
  deps: KnowledgeDeps,
  actor: Actor,
  input: { employeeId: string; path: string; content: string; expectedRevision?: number },
): Promise<EmployeeKnowledge> {
  requireEnabled(deps);
  const { employeeId, path, content, expectedRevision } = input;
  await authorize(deps.prisma, actor.userId, employeeId, "approve_knowledge");
  refuseCredentials(path, content);
  const row = await system("set", () =>
    deps.prisma.$transaction(async (tx) => {
      await lockEmployee(tx, employeeId);
      await authorize(tx, actor.userId, employeeId, "approve_knowledge");
      const existing = await tx.employeeKnowledge.findUnique({
        where: { employeeId_path: { employeeId, path } },
        select: { revision: true },
      });
      if ((existing?.revision ?? undefined) !== expectedRevision)
        throw stale("This changed since you opened it");
      return writeRevision(tx, { employeeId, path, content, approvedBy: actor.userId });
    }),
  );
  await recordSecurityEvent({
    type: "employee.knowledge_changed",
    userId: actor.userId,
    spaceId: actor.spaceId,
    metadata: { employeeId, knowledgeId: row.id, revision: row.revision, change: "set" },
  });
  return {
    path: row.path,
    content: row.content,
    revision: row.revision,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Takes a path out of the prompt from the next run; its revisions stay. */
export async function retireKnowledge(
  deps: KnowledgeDeps,
  actor: Actor,
  input: { employeeId: string; path: string },
): Promise<{ ok: true }> {
  requireEnabled(deps);
  const { employeeId, path } = input;
  await authorize(deps.prisma, actor.userId, employeeId, "approve_knowledge");
  const retired = await system("retire", () =>
    deps.prisma.employeeKnowledge.updateMany({
      where: { employeeId, path, state: "approved" },
      data: { state: "retired" },
    }),
  );
  if (retired.count !== 1) throw new ORPCError("NOT_FOUND", { message: "Knowledge not found" });
  await recordSecurityEvent({
    type: "employee.knowledge_changed",
    userId: actor.userId,
    spaceId: actor.spaceId,
    metadata: { employeeId, change: "retire" },
  });
  return { ok: true };
}

/**
 * Approve writes the submitted text as the next revision, unless the approved text moved since
 * the proposal was written (the reviewer rejects it and the person offers it again). Reject keeps
 * the reason. Only Owners and Managers decide, so a Collaborator never approves their own text.
 */
export async function decideProposal(
  deps: KnowledgeDeps,
  actor: Actor,
  input: {
    employeeId: string;
    proposalId: string;
    decision: "approve" | "reject";
    reason?: string;
  },
): Promise<{ ok: true }> {
  requireEnabled(deps);
  const { employeeId, proposalId, decision, reason } = input;
  await authorize(deps.prisma, actor.userId, employeeId, "approve_knowledge");
  await system("decide", () =>
    deps.prisma.$transaction(async (tx) => {
      await lockEmployee(tx, employeeId);
      await authorize(tx, actor.userId, employeeId, "approve_knowledge");
      const proposal = await tx.employeeKnowledgeProposal.findFirst({
        where: { id: proposalId, employeeId },
      });
      if (!proposal) throw new ORPCError("NOT_FOUND", { message: "Suggestion not found" });
      if (proposal.status !== "pending") throw stale("This was already decided");
      if (decision === "approve") {
        refuseCredentials(proposal.proposedContent);
        const current = await tx.employeeKnowledge.findUnique({
          where: { employeeId_path: { employeeId, path: proposal.path } },
          select: { revision: true },
        });
        if ((current?.revision ?? null) !== proposal.baseRevision)
          throw stale("The approved text changed since this was suggested");
        await writeRevision(tx, {
          employeeId,
          path: proposal.path,
          content: proposal.proposedContent,
          approvedBy: actor.userId,
        });
      }
      await tx.employeeKnowledgeProposal.update({
        where: { id: proposal.id },
        data: {
          status: decision === "approve" ? "approved" : "rejected",
          decidedBy: actor.userId,
          decidedAt: new Date(),
          reason: decision === "reject" ? reason?.trim() || null : null,
        },
      });
    }),
  );
  await recordSecurityEvent({
    type: "employee.knowledge_decided",
    userId: actor.userId,
    spaceId: actor.spaceId,
    metadata: { employeeId, proposalId, decision },
  });
  return { ok: true };
}
