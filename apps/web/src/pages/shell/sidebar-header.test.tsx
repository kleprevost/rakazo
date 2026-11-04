// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("@rakazo/ui-web", () => {
  const Plain = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    Button: ({
      variant: _v,
      size: _s,
      ...props
    }: ComponentProps<"button"> & Record<string, unknown>) => <button type="button" {...props} />,
    Popover: Plain,
    PopoverContent: Plain,
    PopoverTrigger: Plain,
  };
});
vi.mock("../../components/IconTooltip", () => ({
  IconTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../WindowChrome", () => ({ WindowChrome: () => null }));
vi.mock("./bot-picker", () => ({
  BotCreatePicker: ({ onBrowseEmployees }: { onBrowseEmployees?: () => void }) =>
    onBrowseEmployees ? (
      <button type="button" data-testid="browse-employees" onClick={onBrowseEmployees} />
    ) : null,
}));

import { SidebarHeader } from "./sidebar-header";

it("puts Today in the primary navigation and closes the mobile sidebar when it opens", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const navigate = vi.fn();
  const setMobileSidebarOpen = vi.fn();
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <SidebarHeader
          createMenuOpen={false}
          setCreateMenuOpen={() => undefined}
          activityMode={false}
          toggleActivityMode={() => undefined}
          setBotsSidebarCollapsedPref={() => undefined}
          bots={[]}
          setMobileSidebarOpen={setMobileSidebarOpen}
          setPanel={() => undefined}
          navigate={navigate}
          setNewSpaceOpen={() => undefined}
          setCreateBotOpen={() => undefined}
        />,
      ),
    );
    const today = container.querySelector<HTMLButtonElement>('[aria-label="Today"]');
    expect(today).not.toBeNull();
    await act(async () => today?.click());
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/app/today");
    expect(setMobileSidebarOpen).toHaveBeenCalledWith(false);
    const calendar = container.querySelector<HTMLButtonElement>('[aria-label="Calendar"]');
    expect(calendar).not.toBeNull();
    await act(async () => calendar?.click());
    expect(navigate).toHaveBeenLastCalledWith("/app/calendar");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it.each([
  [true, 1],
  [false, 0],
])(
  "offers the employee directory in the create menu only when it is on (%s)",
  async (enabled, count) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const navigate = vi.fn();
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <SidebarHeader
            createMenuOpen
            setCreateMenuOpen={() => undefined}
            activityMode={false}
            toggleActivityMode={() => undefined}
            setBotsSidebarCollapsedPref={() => undefined}
            bots={[]}
            setMobileSidebarOpen={() => undefined}
            setPanel={() => undefined}
            navigate={navigate}
            setNewSpaceOpen={() => undefined}
            setCreateBotOpen={() => undefined}
            sharedEmployeesEnabled={enabled}
          />,
        ),
      );
      const entries = container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="browse-employees"]',
      );
      expect(entries).toHaveLength(count);
      if (enabled) {
        await act(async () => entries[0]?.click());
        expect(navigate).toHaveBeenCalledExactlyOnceWith("/app/employees");
      }
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  },
);
