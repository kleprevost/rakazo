import { describe, expect, it } from "vitest";
import {
  composeEmployeeBot,
  EMPLOYEE_KNOWLEDGE_PROMPT_MAX_CHARS,
  formatEmployeeKnowledge,
} from "./employee-run.js";

const bot = {
  description: "own description",
  instructions: "",
  disabledBuiltinTools: [] as string[],
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
};
const version = {
  role: "Support analyst",
  instructions: "Answer politely.",
  capabilityPolicy: {},
  modelPolicy: {},
};

describe("composeEmployeeBot", () => {
  it("uses the definition's role and instructions", () => {
    expect(composeEmployeeBot(bot, version, [version.instructions])).toMatchObject({
      description: "Support analyst",
      instructions: "Answer politely.",
    });
  });

  it("keeps the role of the person's bot when the definition has none", () => {
    expect(composeEmployeeBot(bot, { ...version, role: " " }, []).description).toBe(
      "own description",
    );
  });

  it("puts the person's own note after the definition", () => {
    const composed = composeEmployeeBot({ ...bot, instructions: "Call me Sam." }, version, []);
    expect(composed.instructions.startsWith("Answer politely.")).toBe(true);
    expect(composed.instructions).toContain("Call me Sam.");
  });

  it("drops a note that is only a copy of a published definition", () => {
    const owner = { ...bot, instructions: "Old definition." };
    const composed = composeEmployeeBot(owner, version, ["Old definition.", "Answer politely."]);
    expect(composed.instructions).toBe("Answer politely.");
  });

  it("only ever adds to the tools switched off", () => {
    const composed = composeEmployeeBot(
      { ...bot, disabledBuiltinTools: ["web_fetch"] },
      { ...version, capabilityPolicy: { disabledBuiltinTools: ["shell", "web_fetch", 7] } },
      [],
    );
    expect(composed.disabledBuiltinTools.sort()).toEqual(["shell", "web_fetch"]);
  });

  it("applies the model policy only where the person chose no model", () => {
    const policy = { ...version, modelPolicy: { modelProvider: "p", modelId: "m" } };
    expect(composeEmployeeBot(bot, policy, [])).toMatchObject({ modelProvider: "p", modelId: "m" });
    expect(
      composeEmployeeBot({ ...bot, modelProvider: "mine", modelId: "mine-1" }, policy, []),
    ).toMatchObject({ modelProvider: "mine", modelId: "mine-1" });
  });

  it("forces isolated memory and no cross-space messaging", () => {
    expect(composeEmployeeBot(bot, version, [])).toMatchObject({
      crossSpaceCommunication: false,
      memoryScope: "isolated",
    });
  });

  it("places approved knowledge after the definition and before the personal note", () => {
    const composed = composeEmployeeBot(
      { ...bot, instructions: "Call me Sam." },
      version,
      [],
      [
        { path: "b.md", content: "Second." },
        { path: "a.md", content: "First." },
      ],
    );
    const text = composed.instructions;
    expect(text.indexOf("### a.md")).toBeLessThan(text.indexOf("### b.md"));
    expect(text.indexOf(version.instructions)).toBeLessThan(text.indexOf("### a.md"));
    expect(text.indexOf("### b.md")).toBeLessThan(text.indexOf("Call me Sam."));
  });

  it("adds nothing without knowledge and skips a document that does not fit whole", () => {
    expect(formatEmployeeKnowledge([])).toBe("");
    const big = "x".repeat(EMPLOYEE_KNOWLEDGE_PROMPT_MAX_CHARS);
    const out = formatEmployeeKnowledge([
      { path: "big.md", content: big },
      { path: "small.md", content: "Fits." },
    ]);
    expect(out).toContain("Fits.");
    expect(out).not.toContain("xxxx");
  });
});
