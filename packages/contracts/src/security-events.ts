import * as z from "zod";

/** Every security event the backend records. Alert queries match these strings. */
export const SECURITY_EVENT_TYPES = [
  "auth.sign_up",
  "auth.sign_up.failed",
  "auth.sign_in",
  "auth.sign_in.failed",
  "auth.sign_out",
  "auth.session.revoked",
  "auth.password.changed",
  "auth.passkey.added",
  "auth.passkey.changed",
  "auth.passkey.removed",
  "auth.account.deleted",
  "auth.identity.confirmed",
  "credential.created",
  "credential.changed",
  "credential.deleted",
  "credential.revealed",
  "device.paired",
  "device.tied",
  "device.revoked",
  "deployment.settings.changed",
  "bot.suspended",
  "bot.resumed",
  "bot.quarantined",
  "bot.released",
  "approval.decided",
  "approval.policy.changed",
  "egress.refused",
  "policy.loaded",
  "policy.denied",
  "computer.image_refused",
  "computer.fleet.operation.created",
  "computer.fleet.operation.completed",
  "computer.fleet.item.succeeded",
  "computer.fleet.item.failed",
  "computer.fleet.item.skipped",
  "computer.hibernated",
  "computer.woken",
  "computer.recreated",
  "computer.terminated",
  "rate_limit.hit",
  "employee.entitlements_reconciled",
  "employee.shared",
  "employee.version_saved",
  "employee.version_published",
  "employee.grant_changed",
  "employee.grant_removed",
  "employee.instance_created",
  "employee.access_requested",
  "employee.access_decided",
] as const;

export const SecurityEventTypeSchema = z.enum(SECURITY_EVENT_TYPES);
export type SecurityEventType = z.infer<typeof SecurityEventTypeSchema>;

/** Small, flat, and content-free: identifiers, kinds, and outcomes only. */
export const SecurityEventMetadataSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);
export type SecurityEventMetadata = z.infer<typeof SecurityEventMetadataSchema>;

export const SecurityEventSchema = z.object({
  id: z.string(),
  type: SecurityEventTypeSchema,
  userId: z.string().nullable(),
  spaceId: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  metadata: SecurityEventMetadataSchema,
  createdAt: z.string(),
});
export type SecurityEvent = z.infer<typeof SecurityEventSchema>;

export const SecurityEventListInputSchema = z.object({
  type: SecurityEventTypeSchema.optional(),
  ip: z.string().max(64).optional(),
  userId: z.string().max(128).optional(),
  /** The id of the last event on the previous page; the next page starts just after it. */
  cursor: z.string().max(128).optional(),
  limit: z.number().int().min(1).max(500).default(100),
});
