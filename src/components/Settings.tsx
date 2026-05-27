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

import { getSettings, setAnthropicApiKey, type ApiKeyState } from "../lib/settings";

export default function Settings() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ApiKeyState>({
    hasApiKey: false,
    apiKeyPreview: null,
    unreadable: false,
  });
  const [draft, setDraft] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError("");
    setSaved(false);
    setDraft("");
    setReveal(false);
    getSettings()
      .then(setState)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [open]);

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
