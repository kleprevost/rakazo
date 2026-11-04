import { describe, expect, it } from "vitest";
import { composeEmployeeBot } from "./employee-run.js";

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
});
