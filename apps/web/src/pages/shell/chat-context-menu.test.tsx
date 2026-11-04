// @vitest-environment jsdom

import type { Bot, EmployeeRole } from "@rakazo/contracts";
import { act, Suspense } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createSpaceRpc } from "../../lib/rpc";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children: unknown }) => children,
  };
});
vi.mock("../BotContextMenu", () => ({
  BotContextMenu: ({ onShare }: { onShare?: () => void }) => (
    <div data-testid="menu">
      {onShare ? (
        <button type="button" onClick={onShare}>
          Share
        </button>
      ) : null}
    </div>
  ),
}));

import { ChatContextMenu } from "./chat-context-menu";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const bot = (employeeId: string | null) => ({ id: "bot-1", name: "Ada", employeeId }) as Bot;

async function render(options: {
  enabled: boolean;
  employeeId: string | null;
  role?: EmployeeRole;
}) {
  const list = vi.fn(async () =>
    options.role
      ? [{ id: "emp-1", role: options.role } as Awaited<ReturnType<typeof rpcList>>[number]]
      : [],
  );
  const rpc = { employees: { list } } as unknown as ReturnType<typeof createSpaceRpc>;
  const setShareTarget = vi.fn();
  await act(async () => {
    root.render(
      <Suspense fallback={null}>
        <ChatContextMenu
          rpc={rpc}
          bot={bot(options.employeeId)}
          group={undefined}
          sections={[]}
          spaceId="space-1"
          onClose={() => undefined}
          refreshBots={async () => undefined}
          read={{ markBotRead: vi.fn(), markBotUnread: vi.fn(), toggleGroupUnread: vi.fn() }}
          dialogs={{ setShareTarget } as never}
          openChatSettings={() => undefined}
          navigate={() => undefined}
          sharedEmployeesEnabled={options.enabled}
        />
      </Suspense>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return { list, setShareTarget };
}
declare function rpcList(): Promise<Array<{ id: string; role: EmployeeRole }>>;

const shareItem = () =>
  [...document.querySelectorAll("button")].find((item) => item.textContent === "Share");

describe("ChatContextMenu sharing", () => {
  it("hides Share and asks nothing while the flag is off", async () => {
    const { list } = await render({ enabled: false, employeeId: "emp-1", role: "owner" });
    expect(shareItem()).toBeUndefined();
    expect(list).not.toHaveBeenCalled();
    await render({ enabled: false, employeeId: null });
    expect(shareItem()).toBeUndefined();
  });

  it("offers Share on a private bot", async () => {
    const { setShareTarget } = await render({ enabled: true, employeeId: null });
    await act(async () => shareItem()?.click());
    expect(setShareTarget).toHaveBeenCalledWith(expect.objectContaining({ id: "bot-1" }));
  });

  it.each(["owner", "manager"] as const)("offers Share on a shared bot to a %s", async (role) => {
    await render({ enabled: true, employeeId: "emp-1", role });
    expect(shareItem()).toBeDefined();
  });

  it.each(["collaborator", "viewer"] as const)("hides Share from a %s", async (role) => {
    await render({ enabled: true, employeeId: "emp-1", role });
    expect(shareItem()).toBeUndefined();
  });
});
