import { modelLabel } from "@/lib/models";
import type { Conversation } from "@/lib/transcript";
import { toolCounts } from "@/lib/transcript";
import type { VmStatus } from "@/lib/vm";

function Section({
  title,
  children,
  last,
}: {
  title: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div className={last ? "px-5 py-4" : "border-b px-5 py-4"}>
      <h4 className="mb-2.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        {title}
      </h4>
      {children}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between py-0.5 text-xs">
      <span className="text-muted-foreground">{k}</span>
      <span className="font-mono">{v}</span>
    </div>
  );
}

function vmLabel(vm: VmStatus): { dot: string; text: string } {
  if (vm.kind === "running") return { dot: "bg-emerald-500", text: "running" };
  if (vm.kind === "failed") return { dot: "bg-destructive", text: "failed" };
  return { dot: "bg-agent", text: "starting…" };
}

export function InfoPane({
  conversation,
  vm,
  model,
  onClose,
}: {
  conversation: Conversation;
  vm: VmStatus;
  model: string;
  onClose: () => void;
}) {
  const counts = toolCounts(conversation);
  const label = vmLabel(vm);
  return (
    <aside className="flex h-full flex-col overflow-auto border-l bg-sidebar text-sidebar-foreground">
      <div className="flex h-13 flex-none items-center border-b px-5 text-sm font-semibold">
        Conversation
        <button
          type="button"
          aria-label="Close info"
          onClick={onClose}
          className="ml-auto text-muted-foreground hover:text-foreground"
        >
          ›
        </button>
      </div>

      <Section title="Granted folders">
        {conversation.grants.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            None yet — Capybara will ask when it needs access to a folder.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {conversation.grants.map((dir) => (
              <li key={dir} className="flex items-center gap-2 text-xs">
                <svg
                  className="size-3.5 shrink-0 text-host"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                </svg>
                <span className="truncate font-mono">{dir}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Session">
        <Row k="ID" v={conversation.sessionId ? `${conversation.sessionId.slice(0, 8)}…` : "—"} />
        <Row k="Model" v={model ? modelLabel(model) : "—"} />
      </Section>

      <Section title="Sandbox">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Lima VM</span>
          <span className="inline-flex items-center gap-1.5 font-mono">
            <span className={`size-1.5 rounded-full ${label.dot}`} />
            {label.text}
          </span>
        </div>
        {vm.kind === "failed" && (
          <p className="mt-2 font-mono text-[11px] break-words text-destructive">{vm.reason}</p>
        )}
        <p className="mt-2 font-mono text-[11px] text-vm">bash runs here, isolated from the host</p>
      </Section>

      <Section title="Tools this task" last>
        <div className="flex flex-wrap gap-1.5">
          {["Read", "Glob", "Write", "Bash"].map((name) => (
            <span
              key={name}
              className="rounded-md border px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
            >
              {name} <span className="font-semibold text-foreground">{counts[name] ?? 0}</span>
            </span>
          ))}
        </div>
      </Section>
    </aside>
  );
}
