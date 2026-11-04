// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";

const submit = vi.hoisted(() => vi.fn());
const mine = vi.hoisted(() => vi.fn());
vi.mock("../../lib/rpc", () => ({
  rpc: { skillPublishing: { submit, mine }, skills: { updateDraft: vi.fn(), save: vi.fn() } },
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button {...props} />
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Label: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
}));
vi.mock("../ai/primitives", () => ({
  BuiCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { SkillDraftCard } from "./SkillDraftCard";

const block = (status: "draft" | "saved") => ({
  kind: "skill_draft" as const,
  skillId: "skill-1",
  name: "Export",
  goal: "Export the weekly list",
  status,
  playbook: {
    whenToUse: "Mondays",
    inputs: [],
    steps: ["Open the CRM"],
    howToCheck: "",
    whatToReturn: "",
    approvalBoundaries: "",
    failureHandling: "",
  },
});

async function mount(status: "draft" | "saved") {
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () =>
    createRoot(host).render(
      <SkillDraftCard block={block(status)} onRefresh={async () => {}} onAddRoutine={() => {}} />,
    ),
  );
  return host;
}
const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll("button")].find((el) => el.textContent === label);

beforeEach(() => {
  document.body.innerHTML = "";
  submit.mockReset();
  submit.mockResolvedValue({ versionId: "v1", number: 1 });
  mine.mockReset();
  mine.mockResolvedValue([]);
});

it("offers Publish only once the skill is saved", async () => {
  expect(button(await mount("draft"), "Publish")).toBeUndefined();
  document.body.innerHTML = "";
  expect(button(await mount("saved"), "Publish")).toBeDefined();
});

it("submits the saved skill and then shows Submitted", async () => {
  const host = await mount("saved");
  await act(async () => button(host, "Publish")!.click());
  expect(submit).toHaveBeenCalledWith({ skillId: "skill-1" });
  expect(button(host, "Submitted")?.disabled).toBe(true);
});

it("shows where the latest offer stands", async () => {
  mine.mockResolvedValue([
    { sourceSkillId: "skill-1", number: 1, status: "approved", reason: null },
    { sourceSkillId: "skill-1", number: 2, status: "rejected", reason: "Too broad" },
    { sourceSkillId: "other", number: 3, status: "submitted", reason: null },
  ]);
  const host = await mount("saved");
  expect(host.textContent).toContain("Not approved: Too broad");
  expect(host.textContent).not.toContain("Waiting for review");
});
