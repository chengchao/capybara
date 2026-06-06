import { EyeIcon, EyeOffIcon, SettingsIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { MODELS, modelLabel } from "@/lib/models";
import { getSettings, setAnthropicApiKey, setModel, type SettingsState } from "@/lib/settings";
import { type Theme, useTheme } from "@/lib/theme";

// A horizontal set of mutually-exclusive choices (used for model + theme).
function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: { id: T; label: string; hint?: string }[];
  onChange: (id: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid auto-cols-fr grid-flow-col gap-1.5">
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            onClick={() => onChange(o.id)}
            className={`flex flex-col items-start rounded-md border px-3 py-2 text-left disabled:opacity-50 ${
              active ? "border-agent/50 bg-agent/10 text-agent" : "hover:bg-muted"
            }`}
          >
            <span className="text-sm font-medium">{o.label}</span>
            {o.hint && <span className="text-[11px] text-muted-foreground">{o.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}

const THEME_OPTIONS: { id: Theme; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "System" },
];

export default function Settings({
  model,
  onModelChange,
}: {
  model: string;
  onModelChange: (model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<SettingsState>({
    hasApiKey: false,
    apiKeyPreview: null,
    unreadable: false,
    model,
  });
  const [draft, setDraft] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [theme, setTheme] = useTheme();

  useEffect(() => {
    if (!open) return;
    setError("");
    setSaved(false);
    setDraft("");
    setReveal(false);
    getSettings()
      .then((s) => {
        setState(s);
        // Re-sync the parent's model with the authoritative effective model in
        // case it changed since the initial fetch (env override, another window),
        // so the picker and InfoPane don't show a stale value.
        onModelChange(s.model);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [open, onModelChange]);

  async function save(key: string) {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const next = await setAnthropicApiKey(key);
      setState(next);
      setDraft("");
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function chooseModel(id: string) {
    if (id === model || savingModel) return;
    setSavingModel(true);
    setError("");
    try {
      const next = await setModel(id);
      onModelChange(next.model);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingModel(false);
    }
  }

  // Always surface the effective model, even if it's an env override outside the
  // offered list, so the active choice is never hidden.
  const modelOptions = MODELS.some((m) => m.id === model)
    ? MODELS
    : [{ id: model, label: modelLabel(model), hint: "active (override)" }, ...MODELS];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Settings" className="fixed top-3 right-3">
          <SettingsIcon />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Your Anthropic API key is stored locally on this machine and used for all model calls.
            Get a key at <code>console.anthropic.com</code>.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 text-left">
          <label htmlFor="anthropic-key" className="text-sm font-medium">
            Anthropic API key
          </label>
          <div className="flex gap-2">
            <Input
              id="anthropic-key"
              type={reveal ? "text" : "password"}
              value={draft}
              autoFocus
              className="flex-1 font-mono"
              placeholder={state.hasApiKey ? `Stored: ${state.apiKeyPreview}` : "sk-ant-…"}
              onChange={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && draft.trim() && !busy) save(draft.trim());
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={reveal ? "Hide key" : "Show key"}
              onClick={() => setReveal((v) => !v)}
            >
              {reveal ? <EyeOffIcon /> : <EyeIcon />}
            </Button>
          </div>
          {state.unreadable && !error && (
            <p className="text-sm text-destructive">
              A key is saved but couldn&apos;t be unlocked from your system keychain. Re-enter it
              below, or remove it.
            </p>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {saved && !error && <p className="text-sm text-green-600">Saved.</p>}
        </div>

        <div className="flex flex-col gap-2 text-left">
          <span className="text-sm font-medium">Model</span>
          <Segmented
            value={model}
            options={modelOptions}
            disabled={savingModel}
            onChange={chooseModel}
          />
          <p className="text-[11px] text-muted-foreground">Applies to your next task.</p>
        </div>

        <div className="flex flex-col gap-2 text-left">
          <span className="text-sm font-medium">Appearance</span>
          <Segmented value={theme} options={THEME_OPTIONS} onChange={setTheme} />
        </div>

        <DialogFooter>
          {(state.hasApiKey || state.unreadable) && (
            <Button
              type="button"
              variant="ghost"
              className="text-destructive"
              disabled={busy}
              onClick={() => save("")}
            >
              Remove
            </Button>
          )}
          <Button
            type="button"
            disabled={busy || draft.trim() === ""}
            onClick={() => save(draft.trim())}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
