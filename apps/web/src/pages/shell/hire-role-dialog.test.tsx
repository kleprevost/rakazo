// @vitest-environment jsdom

import type { RoleTemplateListItem } from "@rakazo/contracts";
import { findRoleTemplate } from "@rakazo/core";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return {
    useLingui: () => ({ t, i18n: { locale: "en" } }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});

import { HireRoleDialog } from "./hire-role-dialog";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const executive = findRoleTemplate("executive-assistant")!;
const items = (blocked: RoleTemplateListItem["blocked"] = []): RoleTemplateListItem[] => [
  { template: executive, blocked },
];

async function render(
  load: () => Promise<RoleTemplateListItem[]>,
  onHire: (id: string) => Promise<void> = async () => undefined,
) {
  await act(async () => {
    root.render(<HireRoleDialog load={load} onHire={onHire} onBack={() => undefined} />);
  });
}

function button(text: string) {
  const found = [...document.querySelectorAll("button")].find((element) =>
    element.textContent?.startsWith(text),
  );
  if (!found) throw new Error(`No button ${text}`);
  return found;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}

describe("HireRoleDialog", () => {
  it("previews what hiring creates and hires the chosen role", async () => {
    const onHire = vi.fn(async () => undefined);
    await render(async () => items(), onHire);
    await click(button("Executive Assistant"));
    const preview = document.querySelector('[data-testid="hire-role-preview"]')!.textContent;
    expect(preview).toContain("Morning briefing");
    expect(preview).toContain("executive-briefing");
    expect(preview).toContain("send or forward an email");
    expect(preview).not.toContain("Blocked by your organization");
    await click(button("Hire"));
    expect(onHire).toHaveBeenCalledWith("executive-assistant");
  });

  it("flags parts central policy blocks", async () => {
    await render(async () => items([{ part: "routines", ref: "", rule: "bots.allowRoutines" }]));
    await click(button("Executive Assistant"));
    expect(document.querySelector('[data-testid="hire-role-preview"]')!.textContent).toContain(
      "Blocked by your organization",
    );
  });

  it("shows the error and stays open when hiring fails", async () => {
    await render(
      async () => items(),
      async () => {
        throw new Error("boom");
      },
    );
    await click(button("Executive Assistant"));
    await click(button("Hire"));
    expect(document.querySelector('[data-testid="hire-role-error"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="hire-role-preview"]')).not.toBeNull();
  });
});
