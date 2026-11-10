/**
 * Account & Usage: for each agent that reported them, who it is signed in as and the
 * usage-limit windows of that account (Claude Code reports both).
 */
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { AgentAccount, AgentLimit } from "@/bindings";
import { useTx } from "@/platform/i18n";
import { openExternalUrl } from "@/platform/openUrl";
import { Icon, IconButton, Popup, T } from "@/ui";
import { limitName } from "./composerModel";
import { providerIcon } from "./model";
import { useAgents } from "./store";
import styles from "./AccountUsage.module.css";

/** Where an agent's account shows its usage, when it has such a page. */
const USAGE_PAGES: Record<string, string> = { claude: "https://claude.ai/settings/usage" };

/** How an account's requests are served, by Claude Code's `apiProvider`. */
const API_PROVIDERS: Record<string, string> = {
  bedrock: "Amazon Bedrock",
  vertex: "Google Vertex AI",
  foundry: "Microsoft Foundry",
};

export function AccountUsageButton({ className }: { className?: string }) {
  const tx = useTx();
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton
        ref={ref}
        icon="account"
        title="Account & Usage"
        className={className}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      />
      <Popup
        open={open}
        anchor={ref}
        // Opened from the message box at the bottom of the conversation.
        placement="top-end"
        onClose={() => setOpen(false)}
        aria-label={tx("Account & Usage")}
        className={styles.popup}
      >
        <div className={styles.title}>
          <T>Account & Usage</T>
        </div>
        <AccountUsage />
      </Popup>
    </>
  );
}

function AccountUsage() {
  const accounts = useAgents((s) => s.accounts);
  const limits = useAgents((s) => s.limits);
  const providers = useAgents((s) => s.providers);
  const now = useNow(30_000);
  const ids = [...new Set([...accounts.keys(), ...limits.keys()])];
  if (!ids.length) {
    return (
      <div className={styles.empty}>
        <T>Agents show their account and usage here once a task has started (Claude Code reports both).</T>
      </div>
    );
  }
  return (
    <>
      {ids.map((id) => (
        <AgentAccountUsage
          key={id}
          id={id}
          name={providers.find((p) => p.id === id)?.name ?? id}
          account={accounts.get(id) ?? null}
          limits={limits.get(id) ?? []}
          now={now}
        />
      ))}
    </>
  );
}

function AgentAccountUsage(props: {
  id: string;
  name: string;
  account: AgentAccount | null;
  limits: AgentLimit[];
  now: number;
}) {
  const tx = useTx();
  const { account, limits } = props;
  const page = USAGE_PAGES[props.id];
  const auth = account && authMethod(account, tx);
  return (
    <section className={styles.agent} aria-label={props.name}>
      <div className={styles.agentName}>
        <Icon name={providerIcon(props.id)} size={14} />
        {props.name}
      </div>
      {account && (
        <>
          <div className={styles.section}>
            <T>Account</T>
          </div>
          {auth && <Row label={tx("Auth method")} value={auth} />}
          {account.email && <Row label={tx("Email")} value={account.email} />}
          {account.organization && <Row label={tx("Organization")} value={account.organization} />}
          {account.subscription && <Row label={tx("Plan")} value={account.subscription} />}
        </>
      )}
      <div className={styles.section}>
        <T>Usage</T>
      </div>
      {limits.length ? (
        limits.map((l) => <Limit key={l.window} limit={l} now={props.now} />)
      ) : (
        <div className={styles.empty}>
          <T>The usage limits appear after the agent's next reply.</T>
        </div>
      )}
      {page && (
        <button type="button" className={styles.link} onClick={() => void openExternalUrl(page)}>
          <T>Manage usage…</T>
        </button>
      )}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <span className={styles.value} title={value}>
        {value}
      </span>
    </div>
  );
}

function Limit({ limit, now }: { limit: AgentLimit; now: number }) {
  const tx = useTx();
  const percent = Math.min(100, Math.max(0, Math.round(limit.usedPercent ?? 0)));
  const resets = limit.resetsMs != null && limit.resetsMs > now ? resetLabel(limit.resetsMs, now) : null;
  return (
    <div className={styles.limit}>
      <div className={styles.limitHead}>
        <span>{limitName(limit.window)}</span>
        <span>{percent}%</span>
      </div>
      <div
        className={clsx(styles.bar, percent >= 100 && styles.full)}
        role="meter"
        aria-label={limitName(limit.window)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      {resets && <div className={styles.reset}>{tx`Resets ${resets}`}</div>}
    </div>
  );
}

/** "Claude.ai" for a subscription, the cloud for Bedrock and the like, else "API key". */
function authMethod(account: AgentAccount, tx: ReturnType<typeof useTx>): string | null {
  const api = account.apiProvider;
  if (api && API_PROVIDERS[api]) return API_PROVIDERS[api];
  if (api && api !== "firstParty") return api;
  if (account.subscription) return "Claude.ai";
  return api === "firstParty" ? tx("API key") : null;
}

/** "at 1:00 PM" today, "Fri, Nov 13 at 5:00 AM" later. */
function resetLabel(ms: number, now: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (new Date(now).toDateString() === d.toDateString()) return `· ${time}`;
  const day = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return `· ${day} ${time}`;
}

function useNow(interval: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(t);
  }, [interval]);
  return now;
}
