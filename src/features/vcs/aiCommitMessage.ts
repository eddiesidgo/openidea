/**
 * Generate Commit Message: the agent in use (Agents tool window) writes a message for the
 * changes included in the commit, from their diff and the repository's recent subjects.
 */
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { maybeAgentService } from "@/workbench/contributions";
import { planCommit } from "./changes";
import { useChangelists, withListDefaults } from "./changelists";
import { useCommit } from "./commitStore";
import { rootOf, stripSlash } from "./model";
import { saveAll } from "./ops";
import { currentRepo, refreshNow, useVcs } from "./store";

/** More diff than this is cut: the subject is about the whole, not every line. */
const MAX_DIFF_CHARS = 60_000;
const RECENT_SUBJECTS = 10;

/** The question for the agent: the diff, and recent subjects to follow the repository's style. */
export function commitPrompt(diff: string, recent: readonly string[], truncated: boolean): string {
  const style = recent.length
    ? [
        "Follow the style of the repository's recent commit messages (language, prefixes such as",
        "`feat:` or `fix(scope):`, capitalization):",
        ...recent.map((s) => `- ${s}`),
      ]
    : ["Use an imperative subject line of at most 72 characters."];
  return [
    "Write a git commit message for the changes below.",
    ...style,
    "Start with a concise subject line. Add a blank line and a short body wrapped at 72 characters only when",
    "the change needs explaining (why, not a list of files).",
    "Reply with the commit message only: no introduction, no quotes, no code fences.",
    "Do not use tools: everything you need is below.",
    "",
    truncated ? "Changes (unified diff, cut short):" : "Changes (unified diff):",
    diff,
  ].join("\n");
}

/** The message in an agent's reply: without code fences, quotes or a "Commit message:" label. */
export function cleanCommitMessage(reply: string): string {
  let text = reply.trim();
  const fenced = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(text);
  if (fenced) text = fenced[1]!.trim();
  text = text.replace(/^(?:\*\*)?commit message:?(?:\*\*)?:?\s*\n?/i, "").trim();
  const quoted = /^(["'`])([\s\S]*)\1$/.exec(text);
  if (quoted && !quoted[2]!.includes(quoted[1]!)) text = quoted[2]!.trim();
  return text;
}

/** The unified diff of the included changes of every repository, cut at `MAX_DIFF_CHARS`. */
async function includedDiff(): Promise<{ diff: string; truncated: boolean; repos: Array<string | null> }> {
  await saveAll();
  await refreshNow();
  const { status, root, roots } = useVcs.getState();
  const checks = withListDefaults(status, root ?? "", useChangelists.getState().state, useCommit.getState().checks);
  const included = planCommit(status, checks).included;
  if (!included.length) throw new Error(tx("No changes selected for commit"));
  const byRepo = new Map<string | null, string[]>();
  for (const f of included) {
    const repo = rootOf(f.path, roots) ?? currentRepo();
    byRepo.set(repo, [...(byRepo.get(repo) ?? []), stripSlash(f.path)]);
  }
  const patches = await Promise.all(
    [...byRepo].map(([repo, paths]) => call(commands.vcsCreatePatch(repo, { from: "changes", paths, reverse: false }))),
  );
  const diff = patches.join("\n");
  const truncated = diff.length > MAX_DIFF_CHARS;
  return { diff: truncated ? diff.slice(0, MAX_DIFF_CHARS) : diff, truncated, repos: [...byRepo.keys()] };
}

/** Subjects of the latest commits of `repo`, newest first; none when the log can't be read. */
async function recentSubjects(repo: string | null): Promise<string[]> {
  try {
    const log = await call(
      commands.vcsLog(repo, { branch: null, path: null, author: null, text: null, skip: 0, limit: RECENT_SUBJECTS }),
    );
    return log.map((c) => c.summary.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** The agent that would write the message, when the Agents feature has one installed. */
export const commitMessageAgent = () => maybeAgentService()?.current() ?? null;

/** Asks the agent in use for a message for the included changes. */
export async function generateCommitMessage(signal?: AbortSignal): Promise<string> {
  const service = maybeAgentService();
  const agent = service?.current();
  if (!service || !agent) throw new Error(tx("Install a coding agent in Settings › Tools › Agents first"));
  const { diff, truncated, repos } = await includedDiff();
  const recent = await recentSubjects(repos[0] ?? currentRepo());
  const reply = await service.ask(agent.id, commitPrompt(diff, recent, truncated), signal);
  const message = cleanCommitMessage(reply);
  if (!message) throw new Error(tx("The agent gave no commit message"));
  return message;
}
