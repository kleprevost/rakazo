import { describe, expect, it, vi } from "vitest";
import { keepEasyAuthFresh } from "./easy-auth";

function harness() {
  let tick: () => void = () => {};
  let focus: () => void = () => {};
  let clock = 0;
  const refresh = vi.fn(async () => undefined);
  const target = {
    setInterval: ((fn: () => void) => {
      tick = fn;
      return 1;
    }) as unknown as Window["setInterval"],
    addEventListener: ((_: string, fn: () => void) => {
      focus = fn;
    }) as unknown as Window["addEventListener"],
  };
  keepEasyAuthFresh(refresh, target, () => clock);
  return {
    refresh,
    tick: () => tick(),
    focus: () => focus(),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("keepEasyAuthFresh", () => {
  it("refreshes on the timer", () => {
    const h = harness();
    h.tick();
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes on focus only once the interval has passed", () => {
    const h = harness();
    h.advance(10 * 60_000);
    h.focus();
    expect(h.refresh).not.toHaveBeenCalled();
    h.advance(25 * 60_000);
    h.focus();
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });

  it("swallows refresh failures", async () => {
    const h = harness();
    h.refresh.mockRejectedValueOnce(new Error("offline"));
    expect(() => h.tick()).not.toThrow();
  });
});
