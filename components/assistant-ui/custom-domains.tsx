"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  Loader2Icon,
  XIcon,
} from "lucide-react";
import type { ProjectDomain } from "@/lib/project-types";

type DomainsAnswer = {
  enabled: boolean;
  cnameTarget: string;
  domains: ProjectDomain[];
};

/** How often a pending domain is looked at again: DNS and a certificate take minutes. */
const POLL_MS = 10_000;

/** Second-level labels that are part of the suffix, as in `myshop.co.uk`. */
const SUFFIX_LABELS = new Set(["co", "com", "org", "net", "ac", "gov", "edu"]);

/**
 * What goes in a DNS host's "Name" box: the hostname without the user's
 * registered domain. A guess without the public suffix list, right for the
 * usual shapes.
 */
const recordName = (hostname: string) => {
  const labels = hostname.split(".");
  const suffix =
    labels.length > 2 && SUFFIX_LABELS.has(labels.at(-2) ?? "") ? 3 : 2;
  return labels.slice(0, -suffix).join(".") || "@";
};

const CopyValue = ({ value }: { value: string }) => {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs hover:bg-muted/70"
      title="Copy"
    >
      {value}
      {copied ? (
        <CheckIcon className="size-3" />
      ) : (
        <CopyIcon className="size-3" />
      )}
    </button>
  );
};

const DomainState = ({ domain }: { domain: ProjectDomain }) => {
  if (domain.status === "active") {
    return (
      <span className="flex items-center gap-1 text-xs text-emerald-500">
        <CheckCircle2Icon className="size-3" />
        Active
      </span>
    );
  }
  if (domain.status === "failed") {
    return (
      <span className="flex items-center gap-1 text-xs text-destructive">
        <AlertCircleIcon className="size-3" />
        Failed
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground">
      <Loader2Icon className="size-3 animate-spin" />
      Waiting for DNS
    </span>
  );
};

/**
 * The user's own domains for a project: connect one, see the DNS record it
 * needs, and watch it go from pending to active. Loaded only while the publish
 * dialog is open, since every look at a pending domain asks Cloudflare.
 */
export function CustomDomains({
  projectId,
  open,
}: {
  projectId: string;
  open: boolean;
}) {
  const [answer, setAnswer] = React.useState<DomainsAnswer | null>(null);
  const [hostname, setHostname] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const url = `/api/projects/${projectId}/domains`;

  const request = React.useCallback(
    async (init?: RequestInit) => {
      const response = await fetch(url, init);
      const body = (await response.json().catch(() => null)) as
        | (DomainsAnswer & { error?: string })
        | null;
      if (!response.ok || !body) {
        throw new Error(body?.error ?? "Something went wrong.");
      }
      setAnswer(body);
    },
    [url],
  );

  React.useEffect(() => {
    setAnswer(null);
    setError(null);
  }, [projectId]);

  const isPending =
    answer?.domains.some((domain) => domain.status === "pending") ?? false;

  React.useEffect(() => {
    if (!open) return;
    // A failed refresh keeps what is shown; the next one tries again.
    const refresh = () => void request().catch(() => {});
    refresh();
    if (!isPending) return;
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [open, isPending, request]);

  const change = async (method: "POST" | "DELETE", target: string) => {
    setBusy(true);
    setError(null);
    try {
      await request({
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hostname: target }),
      });
      if (method === "POST") setHostname("");
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Something went wrong.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (!answer?.enabled && !answer?.domains.length) return null;

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">Custom domain</p>

      {answer.domains.map((domain) => (
        <div key={domain.hostname} className="rounded-md border">
          <div className="flex items-center gap-3 px-3 py-2">
            {domain.status === "active" ? (
              <a
                href={`https://${domain.hostname}`}
                target="_blank"
                rel="noreferrer"
                className="flex min-w-0 flex-1 items-center gap-1.5 text-sm hover:underline"
              >
                <span className="truncate">{domain.hostname}</span>
                <ExternalLinkIcon className="size-3 shrink-0 text-muted-foreground" />
              </a>
            ) : (
              <span className="min-w-0 flex-1 truncate text-sm">
                {domain.hostname}
              </span>
            )}
            <DomainState domain={domain} />
            <button
              type="button"
              onClick={() => void change("DELETE", domain.hostname)}
              disabled={busy}
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="Remove this domain"
            >
              <XIcon className="size-3" />
            </button>
          </div>

          {domain.status !== "active" && (
            <div className="space-y-1.5 border-t px-3 py-2 text-xs text-muted-foreground">
              <p>At your domain provider, add this DNS record:</p>
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>
                  Type <CopyValue value="CNAME" />
                </span>
                <span>
                  Name <CopyValue value={recordName(domain.hostname)} />
                </span>
                <span>
                  Value <CopyValue value={answer.cnameTarget} />
                </span>
              </p>
              <p>It goes live by itself, usually within a few minutes.</p>
              {domain.error && (
                <p className="text-destructive">{domain.error}</p>
              )}
            </div>
          )}
        </div>
      ))}

      {answer.enabled && (
        <div className="flex gap-2">
          <Input
            value={hostname}
            onChange={(event) => setHostname(event.target.value)}
            placeholder="www.yourdomain.com"
            spellCheck={false}
            disabled={busy}
            onKeyDown={(event) => {
              if (event.key === "Enter" && hostname.trim() && !busy) {
                void change("POST", hostname);
              }
            }}
          />
          <Button
            variant="outline"
            onClick={() => void change("POST", hostname)}
            disabled={busy || !hostname.trim()}
          >
            {busy && <Loader2Icon className="size-3.5 animate-spin" />}
            Connect
          </Button>
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
