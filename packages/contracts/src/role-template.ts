import * as z from "zod";
import { BOT_DESCRIPTION_MAX_LENGTH, BOT_NAME_MAX_LENGTH, BotSchema } from "./domain.js";

/**
 * A role template: a versioned, declarative definition of an AI employee. Data, not code, so a
 * catalog can ship in the repo today and come from an admin later. Everything a template asks for
 * is provider-neutral; the server checks it against central policy before creating anything.
 */
export const ROLE_TEMPLATE_SCHEMA_VERSION = 1;
export const ROLE_TEMPLATE_INSTRUCTIONS_MAX_LENGTH = 12_000;

const slug = z.string().regex(/^[a-z][a-z0-9-]{1,48}$/);

/** The kinds of connected app a role can use; which app serves each is the user's choice. */
export const RoleConnectionKindSchema = z.enum([
  "email",
  "calendar",
  "documents",
  "chat",
  "tickets",
  "crm",
]);
export type RoleConnectionKind = z.infer<typeof RoleConnectionKindSchema>;

export const RoleTemplateSkillSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  description: z.string().trim().min(1).max(500),
  body: z.string().trim().min(1).max(8_000),
});

export const RoleTemplateRoutineSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(4_000),
  /** Five-field cron, read in the hiring user's time zone. */
  cron: z.string().trim().min(1).max(100),
});

export const RoleTemplateSchema = z.strictObject({
  schemaVersion: z.literal(ROLE_TEMPLATE_SCHEMA_VERSION),
  id: slug,
  /** Bumped when the content changes; hired bots keep what they were created with. */
  version: z.number().int().positive(),
  /** The bot's default name. */
  name: z.string().trim().min(1).max(BOT_NAME_MAX_LENGTH),
  /** Short job title shown on the card. */
  role: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(BOT_DESCRIPTION_MAX_LENGTH),
  instructions: z.string().trim().min(1).max(ROLE_TEMPLATE_INSTRUCTIONS_MAX_LENGTH),
  /** Which model the role suits; a hint, the bot keeps the account's default model. */
  modelHint: z.enum(["standard", "deep"]).default("standard"),
  skills: z.array(RoleTemplateSkillSchema).max(12).default([]),
  /** Created paused; the user turns them on. */
  routines: z.array(RoleTemplateRoutineSchema).max(6).default([]),
  /** Built-in tool ids the role relies on (the ids policy rules and approval lists use). */
  tools: z.array(z.string().min(1).max(80)).max(20).default([]),
  connections: z
    .array(
      z.strictObject({
        kind: RoleConnectionKindSchema,
        access: z.enum(["read", "write"]),
        optional: z.boolean().default(false),
      }),
    )
    .max(10)
    .default([]),
  approvals: z
    .strictObject({
      /** Plain-language actions the bot must get a yes for first. */
      askBefore: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
    })
    .default({ askBefore: [] }),
  /** The first message the new bot receives. */
  starterTask: z.string().trim().min(1).max(2_000),
});
export type RoleTemplate = z.infer<typeof RoleTemplateSchema>;

export const RoleTemplateBlockSchema = z.object({
  part: z.enum(["routines", "tool", "connection"]),
  /** The tool id or connection kind; empty for routines. */
  ref: z.string(),
  /** The policy rule that refuses it. */
  rule: z.string(),
});
export type RoleTemplateBlock = z.infer<typeof RoleTemplateBlockSchema>;

export const RoleTemplateListItemSchema = z.object({
  template: RoleTemplateSchema,
  /** Parts central policy refuses; hiring leaves them out. */
  blocked: z.array(RoleTemplateBlockSchema),
});
export type RoleTemplateListItem = z.infer<typeof RoleTemplateListItemSchema>;

export const HireRoleInput = z.strictObject({
  templateId: slug,
  /** Replaces the template's name. */
  name: z.string().trim().min(1).max(BOT_NAME_MAX_LENGTH).optional(),
  /** Client-generated per hire attempt; a retry with the same key returns the same bot. */
  idempotencyKey: z.string().trim().min(8).max(80),
});
export type HireRoleInput = z.infer<typeof HireRoleInput>;

/** Whether the first assignment reached the bot's chat as a queued run. */
export const HireStarterStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("queued") }),
  z.object({ status: z.literal("failed"), reason: z.string() }),
]);
export type HireStarterStatus = z.infer<typeof HireStarterStatusSchema>;

export const HireRoleOutput = z.object({
  bot: BotSchema,
  starter: HireStarterStatusSchema,
  blocked: z.array(RoleTemplateBlockSchema),
});
export type HireRoleOutput = z.infer<typeof HireRoleOutput>;
