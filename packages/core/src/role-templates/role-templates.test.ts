import type { RoleTemplate } from "@rakazo/contracts";
import { BOT_INSTRUCTIONS_MAX_LENGTH, RoleTemplateSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { nextCronDate } from "../cron.js";
import {
  evaluateRoleTemplate,
  findRoleTemplate,
  ROLE_TEMPLATES,
  roleTemplateInstructions,
} from "./index.js";

const executive = findRoleTemplate("executive-assistant") as RoleTemplate;

describe("role template catalog", () => {
  it("ships the four roles with unique ids", () => {
    expect(ROLE_TEMPLATES.map((template) => template.id)).toEqual([
      "executive-assistant",
      "chief-of-staff",
      "research-analyst",
      "operations-assistant",
    ]);
    expect(new Set(ROLE_TEMPLATES.map((template) => template.id)).size).toBe(ROLE_TEMPLATES.length);
  });

  it.each(ROLE_TEMPLATES.map((template) => [template.id, template] as const))(
    "%s is internally consistent",
    (_id, template) => {
      expect(RoleTemplateSchema.safeParse(template).success).toBe(true);
      expect(roleTemplateInstructions(template).length).toBeLessThanOrEqual(
        BOT_INSTRUCTIONS_MAX_LENGTH,
      );
      for (const routine of template.routines) {
        expect(() => nextCronDate(routine.cron, new Date(), "UTC")).not.toThrow();
        // A routine prompt names the skills it uses; they must ship with the template.
        for (const mention of routine.prompt.matchAll(/using the ([a-z0-9-]+) skill/g)) {
          expect(template.skills.map((skill) => skill.name)).toContain(mention[1]);
        }
      }
      const names = template.skills.map((skill) => skill.name);
      expect(new Set(names).size).toBe(names.length);
    },
  );

  it("starts the executive assistant read-only with approvals for consequential actions", () => {
    expect(executive.connections.filter((c) => c.access === "write")).toEqual([]);
    expect(executive.approvals.askBefore.length).toBeGreaterThan(0);
    expect(roleTemplateInstructions(executive)).toContain("send or forward an email");
    expect(executive.routines.map((routine) => routine.name)).toContain("Morning briefing");
  });

  // Structure checks only; whether a briefing is faithful is judged by the opt-in briefing eval.
  it("ships a briefing that is saved as an artifact by the morning routine", () => {
    expect(executive.version).toBeGreaterThanOrEqual(2);
    const skill = executive.skills.find((item) => item.name === "executive-briefing");
    expect(skill?.body).toContain("write_file");
    expect(skill?.body).toContain("attach_file");
    const routine = executive.routines.find((item) => item.name === "Morning briefing");
    expect(routine?.prompt).toContain("executive-briefing");
    expect(executive.starterTask).toContain("executive-briefing");
    // The previous skill name is not reused, so owners who already have it keep it untouched.
    expect(executive.skills.map((item) => item.name)).not.toContain("daily-briefing");
  });
});

describe("RoleTemplateSchema", () => {
  const valid = ROLE_TEMPLATES[0] as RoleTemplate;

  it("rejects unknown keys, a bad id and an unknown schema version", () => {
    expect(RoleTemplateSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(RoleTemplateSchema.safeParse({ ...valid, id: "Not A Slug" }).success).toBe(false);
    expect(RoleTemplateSchema.safeParse({ ...valid, schemaVersion: 2 }).success).toBe(false);
  });

  it("requires a starter task and instructions", () => {
    expect(RoleTemplateSchema.safeParse({ ...valid, starterTask: " " }).success).toBe(false);
    expect(RoleTemplateSchema.safeParse({ ...valid, instructions: "" }).success).toBe(false);
  });

  it("rejects a connection kind it does not know", () => {
    const bad = { ...valid, connections: [{ kind: "teleport", access: "read" }] };
    expect(RoleTemplateSchema.safeParse(bad).success).toBe(false);
  });

  it("defaults optional lists", () => {
    const { skills: _s, routines: _r, tools: _t, connections: _c, approvals: _a, ...rest } = valid;
    const parsed = RoleTemplateSchema.parse(rest);
    expect(parsed.skills).toEqual([]);
    expect(parsed.approvals.askBefore).toEqual([]);
    expect(parsed.modelHint).toBe(valid.modelHint);
  });
});

describe("evaluateRoleTemplate", () => {
  it("blocks nothing without a policy", () => {
    expect(evaluateRoleTemplate(undefined, executive)).toEqual([]);
  });

  it("flags routines, tools and connections the policy refuses", () => {
    const blocked = evaluateRoleTemplate(
      {
        version: 1,
        bots: { allowRoutines: false },
        tools: { deny: ["web_*"] },
        integrations: { allowConnectors: [] },
      },
      executive,
    );
    expect(blocked).toContainEqual({
      part: "routines",
      ref: "",
      rule: "bots.allowRoutines",
    });
    expect(blocked).toContainEqual({ part: "tool", ref: "web_search", rule: "tools.deny" });
    expect(blocked).toContainEqual({
      part: "connection",
      ref: "email",
      rule: "integrations.allowConnectors",
    });
  });

  it("does not flag connections when connectors are only restricted to some apps", () => {
    const blocked = evaluateRoleTemplate(
      { version: 1, integrations: { allowConnectors: ["somewhere"] } },
      executive,
    );
    expect(blocked).toEqual([]);
  });
});
