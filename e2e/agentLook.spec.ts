/**
 * The agent conversation laid out as in the Claude Code extension for VS Code: prompts in a
 * framed box, replies as plain text, each tool call a compact row on a status timeline,
 * permission requests as numbered choices, and the composer's mode / send controls.
 * `OPENIDEA_LOOK_SHOTS=<dir>` also saves screenshots there.
 */
import { expect, test, type Page } from "@playwright/test";
import type { AgentEntry, AgentTask } from "../src/bindings";

const task: AgentTask = {
  id: "look",
  title: "Fix the login redirect",
  status: "needsInput",
  isolation: "local",
  provider: "claude",
  model: "claude-opus-5-5",
  cwd: "/dev/acme-api",
  branch: null,
  base: null,
  baseCommit: null,
  error: null,
  createdMs: 0,
  updatedMs: 0,
  config: [
    {
      id: "mode",
      name: "Mode",
      description: null,
      category: "mode",
      current: "default",
      values: [
        { value: "default", name: "Ask before edits", description: null },
        { value: "acceptEdits", name: "Edit automatically", description: null },
        { value: "plan", name: "Plan mode", description: null },
      ],
      via: "option",
    },
    {
      id: "model",
      name: "Model",
      description: null,
      category: "model",
      current: "opus",
      values: [
        { value: "opus", name: "Opus 5.5", description: null },
        { value: "sonnet", name: "Sonnet 5.5", description: null },
      ],
      via: "option",
    },
  ],
  commands: [],
  usage: { used: 48_000, size: 200_000, cost: null },
  queue: [],
};

const entries: AgentEntry[] = [
  {
    type: "user",
    text: "The login page redirects to /home even when a `next` parameter is given. Fix it.",
    attachments: [],
    steered: false,
    sentMs: null,
    doneMs: null,
  },
  { type: "thought", text: "Find where the redirect target is chosen after login." },
  {
    type: "tool",
    id: "grep",
    title: "Grep redirect",
    kind: "search",
    status: "completed",
    locations: [],
    output: "src/auth/login.ts:42:  return redirect('/home');",
    diffs: [],
  },
  {
    type: "tool",
    id: "read",
    title: "Read src/auth/login.ts",
    kind: "read",
    status: "completed",
    locations: [],
    output: null,
    diffs: [],
  },
  {
    type: "agent",
    text: "The handler ignores `next`. I'll read it from the query and only allow **relative** paths:\n\n```ts\nconst target = safeNext(req.query.next) ?? '/home';\n```",
  },
  {
    type: "tool",
    id: "edit",
    title: "Edit src/auth/login.ts",
    kind: "edit",
    status: "completed",
    locations: [],
    output: null,
    diffs: [{ path: "/dev/acme-api/src/auth/login.ts", added: 6, removed: 1 }],
  },
  {
    type: "tool",
    id: "test",
    title: "npm test -- login",
    kind: "execute",
    status: "failed",
    locations: [],
    output: "1 failing: redirects to next",
    diffs: [],
    input: "cd /dev/acme-api\nnpm test -- login",
  },
  {
    type: "permission",
    id: 1,
    title: "Edit src/auth/login.test.ts",
    options: [
      { id: "allow", kind: "allow_once", name: "Allow" },
      { id: "allow-always", kind: "allow_always", name: "Allow for this session" },
      { id: "reject", kind: "reject_once", name: "Reject" },
    ],
    chosen: null,
  },
];

async function open(page: Page, theme: "dark" | "light") {
  await page.goto("/");
  await page.getByRole("tree", { name: "Project" }).waitFor();
  await page.evaluate(
    async ({ task, entries, theme }) => {
      const path = "/src/features/agents/store.ts";
      const store = await import(path);
      const themePath = "/src/workbench/theme.ts";
      (await import(themePath)).previewTheme(theme);
      store.useAgents.setState({
        loaded: true,
        tasks: new Map([[task.id, task]]),
        entries: new Map([[task.id, entries]]),
      });
      store.openTaskInEditorLocation(task.id);
    },
    { task, entries, theme },
  );
  await page.getByText("The handler ignores").waitFor();
}

async function shot(page: Page, name: string) {
  const dir = process.env.OPENIDEA_LOOK_SHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, animations: "disabled" });
}

for (const theme of ["dark", "light"] as const) {
  test(`the conversation reads like Claude Code for VS Code in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 900 });
    await open(page, theme);
    await shot(page, `look-${theme}`);
    const stream = page.locator('[class*="_stream_"]').first();
    // Your message: a framed box across the conversation, with no author label.
    const layout = await stream.evaluate((el) => {
      const prompt = el.querySelector<HTMLElement>('[class*="_userMessage_"] > [class*="_user_"]')!;
      const style = getComputedStyle(prompt);
      return {
        promptWidth: prompt.getBoundingClientRect().width,
        rowWidth: prompt.closest('[class*="_conversationRow_"]')!.getBoundingClientRect().width,
        promptBorder: style.borderTopWidth,
        text: el.textContent ?? "",
        dots: [...el.children].map((row) => row.getAttribute("data-dot")),
      };
    });
    expect(layout.promptWidth).toBeGreaterThan(layout.rowWidth - 2);
    expect(layout.promptBorder).toBe("1px");
    expect(layout.text).not.toContain("You");
    // The accent (Claude's orange by default) frames your message and the message box.
    const prompt = stream.locator('[class*="_userMessage_"] > [class*="_user_"]').first();
    await expect(prompt).toHaveCSS("border-top-color", "rgb(217, 119, 87)");
    const box = page.locator('[class*="_composer_"]').last();
    await expect(box).toHaveCSS("box-shadow", /^rgb\(217, 119, 87\) /);
    // Another accent from Settings › Agents › Chat applies at once.
    await page.evaluate(async () => {
      const path = "/src/platform/project.ts";
      const { useProject } = await import(path);
      const settings = useProject.getState().settings;
      useProject.setState({ settings: { ...settings, agents: { ...settings?.agents, chatAccent: "#6b9ff2" } } });
    });
    await expect(prompt).toHaveCSS("border-top-color", "rgb(107, 159, 242)");
    await expect(box).toHaveCSS("box-shadow", /^rgb\(107, 159, 242\) /);
    await page.evaluate(async () => {
      const path = "/src/platform/project.ts";
      const { useProject } = await import(path);
      const settings = useProject.getState().settings;
      useProject.setState({ settings: { ...settings, agents: { ...settings?.agents, chatAccent: "#d97757" } } });
    });
    // Hovered, its actions show inside its box (a row clips what overflows it).
    await prompt.hover();
    const copy = stream.locator('[class*="_userMessage_"]').first().getByRole("button", { name: "Copy" });
    await expect(copy).toHaveCSS("opacity", "1");
    const inside = await copy.evaluate((el) => {
      const b = el.getBoundingClientRect();
      const r = el.closest('[class*="_userMessage_"]')!.querySelector('[class*="_user_"]')!.getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return b.top >= r.top && b.right <= r.right && !!hit && el.contains(hit);
    });
    expect(inside).toBe(true);
    await shot(page, `look-hover-${theme}`);
    // The agent's side is a timeline: a dot per block, by its kind and state.
    expect(layout.dots).toEqual([null, "thought", "completed", "completed", "text", "completed", "failed", null]);
    // A tool call: its name, then its argument; a command is Bash's.
    await expect(stream.locator('[class*="_toolVerb_"]')).toHaveText(["Grep", "Read", "Edit", "Bash"]);
    await expect(stream.locator('[class*="_toolArg_"]').last()).toHaveText("npm test -- login");
    // The permission request: Claude Code's numbered choices, answered with their number.
    const choices = page.getByRole("region", { name: /Edit|tool/ }).locator('[class*="_permissionOption_"]');
    await expect(choices).toHaveText(["Yes", "Yes, don't ask again this session", "No"]);
    await page.evaluate(async () => {
      const path = "/src/platform/ipc.ts";
      const { commands } = await import(path);
      commands.agentRespond = async (_task: string, _permission: number, option: string) => {
        (window as unknown as { answer: string }).answer = option;
        return { status: "ok", data: null };
      };
    });
    await stream.click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("2");
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { answer?: string }).answer))
      .toBe("allow-always");

    // A command unfolds into its IN (the whole command) and OUT, each opening in the editor.
    await stream.getByText("npm test -- login", { exact: true }).click();
    const io = stream.locator('[class*="_commandIO_"]');
    await expect(io.locator('[class*="_ioLabel_"]')).toHaveText(["IN", "OUT"]);
    await expect(io.locator('[class*="_ioText_"]')).toHaveText([
      "cd /dev/acme-api\nnpm test -- login",
      "1 failing: redirects to next",
    ]);
    await shot(page, `look-io-${theme}`);
    await io.locator('[class*="_ioPart_"]').first().hover();
    await io.getByRole("button", { name: "Open Command in Editor" }).click();
    await expect(page.getByRole("tab", { name: /IN: npm test -- login/ })).toBeVisible();
    await expect(page.locator(".cm-content").last()).toContainText("npm test -- login");
    await shot(page, `look-in-editor-${theme}`);
  });
}
