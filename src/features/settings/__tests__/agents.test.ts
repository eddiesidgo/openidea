import { describe, expect, it } from "vitest";
import { validateSettings } from "../model/schema";

describe("agent chat settings", () => {
  it("defaults every meter but the cost to on and keeps stored values", () => {
    expect(validateSettings({}).agents).toEqual({
      showContextUsage: true,
      showWorkTime: true,
      showUsageLimits: true,
      showCost: false,
      foldTurns: false,
      smoothText: true,
      thinking: "auto",
      toolCalls: "each",
      expandToolOutput: false,
      sendWith: "enter",
      whileRunning: "queue",
      defaults: {},
      chatAccent: "#d97757",
    });
    const stored = validateSettings({ agents: { showUsageLimits: false, showCost: true, showWorkTime: "no" } }).agents;
    expect(stored).toMatchObject({
      showContextUsage: true,
      showWorkTime: true,
      showUsageLimits: false,
      showCost: true,
    });
  });

  it("keeps a valid accent colour, lower-cased, and drops others", () => {
    const accent = (chatAccent: unknown) => validateSettings({ agents: { chatAccent } }).agents.chatAccent;
    expect(accent("#6B9FF2")).toBe("#6b9ff2");
    expect(accent("#abc")).toBe("#abc");
    for (const bad of ["orange", "#12345", "", 7, null]) expect(accent(bad)).toBe("#d97757");
  });

  it("keeps valid chat choices and per-agent defaults", () => {
    const stored = validateSettings({
      agents: {
        thinking: "collapsed",
        toolCalls: "nope",
        sendWith: "modEnter",
        defaults: { claude: { model: "opus", effort: 3 }, codex: "x" },
      },
    }).agents;
    expect(stored).toMatchObject({
      thinking: "collapsed",
      toolCalls: "each",
      sendWith: "modEnter",
      defaults: { claude: { model: "opus" }, codex: {} },
    });
  });
});
