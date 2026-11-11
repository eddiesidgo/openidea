/** The agent conversation's accent (Settings › Agents › Chat) as `--agent-accent`, kept current. */
import { useProject } from "@/platform/project";
import { resolveAgentSettings } from "./agentSettings";

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const VAR = "--agent-accent";

/** Sets `--agent-accent` on the document and follows the setting; returns the disposer. */
export function followChatAccent(): () => void {
  const root = document.documentElement;
  let shown = "";
  const apply = () => {
    const accent = resolveAgentSettings(useProject.getState().settings?.agents).chatAccent;
    const value = HEX.test(accent) ? accent : "";
    if (value === shown) return;
    shown = value;
    if (value) root.style.setProperty(VAR, value);
    else root.style.removeProperty(VAR);
  };
  apply();
  const off = useProject.subscribe(apply);
  return () => {
    off();
    root.style.removeProperty(VAR);
  };
}
