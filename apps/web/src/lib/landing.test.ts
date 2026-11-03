import { beforeEach, describe, expect, it } from "vitest";
import { resetLanding, routeSettlesLanding, settleLanding, takeLanding } from "./landing";

describe("landing on Today", () => {
  beforeEach(resetLanding);

  it("sends the first plain visit to Today and later visits to the chat", () => {
    expect(takeLanding()).toBe(true);
    expect(takeLanding()).toBe(false);
  });

  it("stays out of the way once a link chose the destination", () => {
    settleLanding();
    expect(takeLanding()).toBe(false);
  });

  it("starts at Today again after signing out", () => {
    expect(takeLanding()).toBe(true);
    resetLanding();
    expect(takeLanding()).toBe(true);
  });

  it.each([
    ["/app/bot-1", "", true],
    ["/app/g/group-1", "", true],
    ["/app/today", "", true],
    ["/app/board", "", true],
    ["/onboarding", "", true],
    ["/app", "?settings=account", true],
    ["/app", "?mcp_oauth=connected", true],
    ["/app", "", false],
    ["/", "", false],
    ["/sign-in", "?next=/app", false],
    ["/sign-up", "", false],
  ])("%s%s settles the landing: %s", (pathname, search, settles) => {
    expect(routeSettlesLanding(pathname, search)).toBe(settles);
  });
});
