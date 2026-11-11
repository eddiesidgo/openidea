/** A command's text (IN) or what it printed (OUT), opened from the conversation in an editor tab. */
import type { AgentEntry, AgentTask } from "@/bindings";
import { editorService, type EditorInput } from "@/workbench/contributions";

export const TOOL_TEXT_KIND = "agent-tool-text";

export interface ToolTextData {
  title: string;
  text: string;
  /** A file name its language is told by (`command.sh`, `output.txt`). */
  fileName: string;
}

/** Opens a command's IN or OUT in an editor tab (one per tool call and part). */
export function openToolText(
  task: AgentTask,
  entry: Extract<AgentEntry, { type: "tool" }>,
  part: "IN" | "OUT",
  text: string,
): void {
  const data: ToolTextData = {
    title: `${part}: ${entry.title}`.slice(0, 80),
    text,
    fileName: part === "OUT" ? "output.txt" : /^[A-Za-z]:\\/.test(task.cwd) ? "command.ps1" : "command.sh",
  };
  void editorService().openInput({
    kind: TOOL_TEXT_KIND,
    key: `${TOOL_TEXT_KIND}:${task.id}:${entry.id}:${part}`,
    data,
  });
}

export const toolTextTitle = (input: EditorInput) => (input.data as ToolTextData | undefined)?.title ?? "";
