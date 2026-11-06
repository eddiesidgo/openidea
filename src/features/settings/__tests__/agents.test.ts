import { describe, expect, it } from "vitest";
import { validateSettings } from "../model/schema";

describe("agent chat settings", () => {
  it("defaults every meter but the cost to on and keeps stored values", () => {
    expect(validateSettings({}).agents).toEqual({
      showContextUsage: true,
      showWorkTime: true,
      showUsageLimits: true,
      showCost: false,
      chatAccent: "orange",
    });
    const stored = validateSettings({
      agents: { showUsageLimits: false, showCost: true, showWorkTime: "no", chatAccent: "teal" },
    }).agents;
    expect(stored).toEqual({
      showContextUsage: true,
      showWorkTime: true,
      showUsageLimits: false,
      showCost: true,
      chatAccent: "orange",
    });
    expect(validateSettings({ agents: { chatAccent: "purple" } }).agents.chatAccent).toBe("purple");
  });
});
