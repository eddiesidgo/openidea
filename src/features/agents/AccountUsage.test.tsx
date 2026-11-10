import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { AccountUsageButton } from "./AccountUsage";
import { useAgents } from "./store";

afterEach(() => useAgents.setState({ accounts: new Map(), limits: new Map(), providers: [] }));

describe("Account & Usage", () => {
  it("says where the account and usage come from before any agent reported them", () => {
    render(<AccountUsageButton />);
    fireEvent.click(screen.getByRole("button", { name: "Account & Usage" }));
    expect(screen.getByRole("dialog", { name: "Account & Usage" }).textContent).toContain("once a task has started");
  });

  it("shows the account an agent is signed in to and its usage-limit windows", () => {
    useAgents.setState({
      accounts: new Map([
        [
          "claude",
          { email: "me@example.com", organization: "Acme", subscription: "Claude Pro", apiProvider: "firstParty" },
        ],
      ]),
      limits: new Map([
        [
          "claude",
          [
            { window: "five_hour", usedPercent: 38.4, resetsMs: Date.now() + 3_600_000 },
            { window: "seven_day", usedPercent: 100, resetsMs: null },
          ],
        ],
      ]),
    });
    render(<AccountUsageButton />);
    fireEvent.click(screen.getByRole("button", { name: "Account & Usage" }));
    const agent = within(screen.getByRole("region", { name: "claude" }));
    for (const text of ["Claude.ai", "me@example.com", "Acme", "Claude Pro", "Manage usage…"])
      expect(agent.getByText(text)).toBeTruthy();
    const meters = agent.getAllByRole("meter");
    expect(meters.map((m) => [m.getAttribute("aria-label"), m.getAttribute("aria-valuenow")])).toEqual([
      ["5-hour limit", "38"],
      ["Weekly limit", "100"],
    ]);
    expect(agent.getAllByText(/^Resets /)).toHaveLength(1);
  });
});
