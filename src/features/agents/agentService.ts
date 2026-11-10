/** The Agents feature's [`AgentService`]: one-off questions to the agent in use. */
import { call, commands, nextRequestId } from "@/platform/ipc";
import type { AgentService } from "@/workbench/contributions";
import { HOME, useAgents } from "./store";

export const agentService: AgentService = {
  current() {
    const s = useAgents.getState();
    // The conversation typed in last, else the agent New Task starts with.
    const task = s.lastComposer !== HOME ? s.tasks.get(s.lastComposer) : undefined;
    const id = task?.provider ?? s.draft.provider;
    const provider = s.providers.find((p) => p.id === id);
    return provider?.installed ? { id: provider.id, name: provider.name } : null;
  },

  async ask(provider, question, signal) {
    const request = nextRequestId();
    const abort = () => void commands.cancelRequest(request).catch(() => {});
    signal?.addEventListener("abort", abort, { once: true });
    try {
      return await call(commands.agentAsk(provider, question, request));
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  },
};
