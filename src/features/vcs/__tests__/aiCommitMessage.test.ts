import { describe, expect, it } from "vitest";
import { cleanCommitMessage, commitPrompt } from "../aiCommitMessage";

describe("Generate Commit Message", () => {
  it("asks for the repository's style and gives the diff", () => {
    const prompt = commitPrompt("diff --git a/x b/x", ["feat(db): add Oracle", "fix: wrap lines"], false);
    expect(prompt).toContain("- feat(db): add Oracle\n- fix: wrap lines");
    expect(prompt).toContain("Changes (unified diff):\ndiff --git a/x b/x");
    expect(prompt).toContain("Reply with the commit message only");
    const fresh = commitPrompt("d", [], true);
    expect(fresh).toContain("imperative subject line");
    expect(fresh).toContain("cut short");
  });

  it("keeps only the message of the agent's reply", () => {
    expect(cleanCommitMessage("```\nfix: a\n\nWhy.\n```")).toBe("fix: a\n\nWhy.");
    expect(cleanCommitMessage("```text\nfix: a\n```")).toBe("fix: a");
    expect(cleanCommitMessage("Commit message:\nfeat: b")).toBe("feat: b");
    expect(cleanCommitMessage('"chore: c"')).toBe("chore: c");
    expect(cleanCommitMessage('fix "quoted" word')).toBe('fix "quoted" word');
    expect(cleanCommitMessage("  plain  ")).toBe("plain");
  });
});
