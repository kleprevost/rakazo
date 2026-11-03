import { describe, expect, it } from "vitest";
import {
  BRIEFING_EVAL_CASES,
  BRIEFING_JUDGE_CALIBRATION,
  BRIEFING_JUDGE_VERSION,
} from "./briefing.js";
import type { Evidence } from "./cases.js";
import { EMPTY_SETTINGS } from "./cases.js";

const PATH = "briefings/2026-11-03.md";

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    text: "",
    files: { [PATH]: "Budget review at 09:30." },
    records: [],
    notes: [],
    calls: [
      { tool: "CALENDAR_LIST_EVENTS", args: {}, outcome: "read" },
      { tool: "GMAIL_LIST_MESSAGES", args: {}, outcome: "read" },
    ],
    routines: [],
    memory: "",
    approvalPending: false,
    pendingApproval: null,
    priorMemory: "",
    toolNames: [],
    toolCalls: [{ step: 1, name: "attach_file", args: { path: PATH } }],
    finalStep: 1,
    settings: EMPTY_SETTINGS,
    settingsBefore: EMPTY_SETTINGS,
    messaging: { originThreadId: null, outbound: [] },
    ...overrides,
  };
}

const passes = (id: string, e: Evidence) =>
  BRIEFING_EVAL_CASES.find((c) => c.id === id)!
    .grade(e)
    .every((c) => c.pass);

describe("briefing eval", () => {
  it("accepts a briefing that was read from both sources, saved and attached", () =>
    expect(passes("briefing-all-sources", evidence())).toBe(true));
  it("rejects a briefing that was never attached", () =>
    expect(passes("briefing-all-sources", evidence({ toolCalls: [] }))).toBe(false));
  it("rejects a briefing that was never saved", () =>
    expect(passes("briefing-all-sources", evidence({ files: { [PATH]: null } }))).toBe(false));
  it("rejects a run that changed something", () =>
    expect(
      passes(
        "briefing-all-sources",
        evidence({
          calls: [
            { tool: "CALENDAR_LIST_EVENTS", args: {}, outcome: "read" },
            { tool: "GMAIL_LIST_MESSAGES", args: {}, outcome: "read" },
            { tool: "GMAIL_SEND", args: {}, outcome: "write" },
          ],
        }),
      ),
    ).toBe(false));
  it("requires the unavailable calendar to have been attempted", () => {
    expect(passes("briefing-calendar-unavailable", evidence())).toBe(false);
    expect(
      passes(
        "briefing-calendar-unavailable",
        evidence({ calls: [{ tool: "CALENDAR_LIST_EVENTS", args: {}, outcome: "rejected" }] }),
      ),
    ).toBe(true);
  });
  it("versions its rubric and labels calibration examples for both verdicts", () => {
    expect(BRIEFING_JUDGE_VERSION).toMatch(/-v\d+$/);
    expect(BRIEFING_JUDGE_CALIBRATION.some((item) => item.pass)).toBe(true);
    expect(BRIEFING_JUDGE_CALIBRATION.some((item) => !item.pass)).toBe(true);
  });
});
