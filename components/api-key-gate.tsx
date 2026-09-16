"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  ExternalLinkIcon,
  KeyIcon,
  Loader2Icon,
  SettingsIcon,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type ApiKeyStatus = {
  hasGlobalKey: boolean;
  hasUserKey: boolean;
};

const OPENROUTER_KEYS_URL = "https://openrouter.ai/settings/keys";

/* ------------------------------------------------------------------ */
/*  Gate – shown when no API key is configured anywhere                */
/* ------------------------------------------------------------------ */

export function ApiKeyGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = React.useState<ApiKeyStatus | null>(null);
  const [loading, setLoading] = React.useState(true);

  const checkStatus = React.useCallback(async () => {
    try {
      const res = await fetch("/api/api-key");
      if (res.ok) {
        const data = (await res.json()) as ApiKeyStatus;
        setStatus(data);
      }
    } catch {
      // fail open if we can't reach the endpoint
      setStatus({ hasGlobalKey: true, hasUserKey: false });
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void checkStatus();
  }, [checkStatus]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2Icon className="size-5 animate-spin text-muted-foreground/40" />
      </div>
    );
  }

  // If there's a global key OR the user already saved one, render the app
  if (status?.hasGlobalKey || status?.hasUserKey) {
    return <>{children}</>;
  }

  // Otherwise show setup screen
  return <ApiKeySetupScreen onSaved={checkStatus} />;
}

/* ------------------------------------------------------------------ */
/*  Full-screen setup                                                  */
/* ------------------------------------------------------------------ */

function ApiKeySetupScreen({ onSaved }: { onSaved: () => void }) {
  const [apiKey, setApiKey] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const handleSave = async () => {
    const key = apiKey.trim();
    if (!key) {
      setError("Please enter an API key");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const res = await fetch("/api/api-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: key }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to save");
        return;
      }
      onSaved();
    } catch {
      setError("Failed to save API key");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-background">
      <div className="mx-auto w-full max-w-md space-y-8 px-6">
        {/* Logo / icon */}
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-muted">
            <KeyIcon className="size-7 text-muted-foreground" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Add your OpenRouter API key
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              AI Builder needs an OpenRouter API key to work. Your key is stored
              securely in an HTTP-only cookie and never shared.
            </p>
          </div>
        </div>

        <div className="space-y-4">
          {/* Key input */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              API key
            </label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setError(null);
              }}
              placeholder="sk-or-..."
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSave();
              }}
              autoFocus
            />
            {error && (
              <p className="mt-1.5 text-[13px] text-destructive">{error}</p>
            )}
          </div>

          {/* Save button */}
          <Button
            className="w-full"
            onClick={handleSave}
            disabled={saving || !apiKey.trim()}
          >
            {saving ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              "Continue"
            )}
          </Button>

          {/* Get key link */}
          <div className="flex items-center justify-center text-xs text-muted-foreground">
            <a
              href={OPENROUTER_KEYS_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
            >
              Get OpenRouter key
              <ExternalLinkIcon className="size-3" />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Settings dialog – for changing/deleting key from within the app    */
/* ------------------------------------------------------------------ */

export function ApiKeySettingsDialog() {
  const [open, setOpen] = React.useState(false);
  const [status, setStatus] = React.useState<ApiKeyStatus | null>(null);
  const [apiKey, setApiKey] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setApiKey("");
    setError(null);
    void (async () => {
      const res = await fetch("/api/api-key");
      if (res.ok) {
        setStatus((await res.json()) as ApiKeyStatus);
      }
    })();
  }, [open]);

  const handleSave = async () => {
    const key = apiKey.trim();
    if (!key) {
      setError("Please enter an API key");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const res = await fetch("/api/api-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: key }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to save");
        return;
      }
      setOpen(false);
    } catch {
      setError("Failed to save API key");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await fetch("/api/api-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete" }),
      });
      setOpen(false);
      // Reload to trigger the gate check
      window.location.reload();
    } catch {
      // ignore
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground"
          title="API key settings"
        >
          <SettingsIcon className="size-4" />
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>API Key Settings</DialogTitle>
          <DialogDescription>
            {status?.hasGlobalKey
              ? "A global OpenRouter key is configured. You can optionally override it with your own."
              : "Your OpenRouter key is stored in an HTTP-only cookie."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-1">
          {/* Key input */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              {status?.hasUserKey ? "Replace API key" : "API key"}
            </label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setError(null);
              }}
              placeholder={
                status?.hasUserKey ? "Enter new key to replace…" : "sk-or-..."
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSave();
              }}
            />
            {error && (
              <p className="mt-1.5 text-[13px] text-destructive">{error}</p>
            )}
          </div>

          <div className="flex items-center justify-between gap-2">
            <a
              href={OPENROUTER_KEYS_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              OpenRouter
              <ExternalLinkIcon className="size-3" />
            </a>

            <div className="flex items-center gap-2">
              {status?.hasUserKey && !status?.hasGlobalKey && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={handleDelete}
                  disabled={deleting}
                >
                  {deleting ? "Removing…" : "Remove key"}
                </Button>
              )}
              <Button
                size="sm"
                onClick={handleSave}
                disabled={saving || !apiKey.trim()}
              >
                {saving ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  "Save"
                )}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
