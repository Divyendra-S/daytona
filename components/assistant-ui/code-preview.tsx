"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
  Loader2Icon,
  SearchIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ProjectFileNode } from "@/lib/project-types";

type FileContentResponse =
  | { ok: true; path: string; content: string; language: string }
  | { error: string; binary?: boolean };

const DEFAULT_EXPAND = new Set(["app", "src", "components", "lib", "pages"]);

const highlightLine = (line: string, language: string): ReactNode[] => {
  if (language === "plaintext" || !line) return [line];

  const parts: ReactNode[] = [];
  const pattern =
    language === "json"
      ? /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+\.?\d*)|(\b(?:true|false|null)\b)|([{}[\],])/g
      : /(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\/\/.*$|\/\*[\s\S]*?\*\/)|(\b(?:import|export|from|const|let|var|function|return|if|else|for|while|switch|case|break|continue|class|extends|new|typeof|instanceof|async|await|try|catch|finally|throw|type|interface|enum|default|as|of|in|void|null|undefined|true|false)\b)|(\b(?:string|number|boolean|any|unknown|never|React|HTMLElement)\b)|(#?[A-Za-z_$-][\w$-]*|[{}()[\].,;:?&|!+\-*/%=<>@])/g;

  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = pattern.exec(line)) !== null) {
    if (match.index > last) {
      parts.push(line.slice(last, match.index));
    }

    const [full, stringLike, commentOrColon, keywordOrNumber, typeOrLiteral, punct] =
      match;

    if (language === "json") {
      if (stringLike) {
        parts.push(
          <span
            key={key++}
            className={commentOrColon ? "text-sky-300" : "text-emerald-300"}
          >
            {stringLike}
            {commentOrColon ?? ""}
          </span>,
        );
      } else if (keywordOrNumber) {
        parts.push(
          <span key={key++} className="text-amber-300">
            {keywordOrNumber}
          </span>,
        );
      } else if (typeOrLiteral) {
        parts.push(
          <span key={key++} className="text-violet-300">
            {typeOrLiteral}
          </span>,
        );
      } else {
        parts.push(
          <span key={key++} className="text-zinc-400">
            {punct ?? full}
          </span>,
        );
      }
    } else if (stringLike) {
      parts.push(
        <span key={key++} className="text-emerald-300">
          {stringLike}
        </span>,
      );
    } else if (commentOrColon) {
      parts.push(
        <span key={key++} className="text-zinc-500 italic">
          {commentOrColon}
        </span>,
      );
    } else if (keywordOrNumber) {
      parts.push(
        <span key={key++} className="text-violet-300">
          {keywordOrNumber}
        </span>,
      );
    } else if (typeOrLiteral) {
      parts.push(
        <span key={key++} className="text-sky-300">
          {typeOrLiteral}
        </span>,
      );
    } else {
      parts.push(full);
    }

    last = match.index + full.length;
  }

  if (last < line.length) parts.push(line.slice(last));
  return parts.length > 0 ? parts : [line];
};

const fileIconClass = (name: string) => {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "tsx" || ext === "jsx") return "text-sky-400";
  if (ext === "ts" || ext === "js" || ext === "mjs") return "text-blue-400";
  if (ext === "css" || ext === "scss") return "text-pink-400";
  if (ext === "json") return "text-amber-400";
  if (ext === "md" || ext === "mdx") return "text-zinc-400";
  if (ext === "svg" || ext === "png" || ext === "jpg") return "text-emerald-400";
  return "text-zinc-500";
};

const collectPaths = (
  nodes: ProjectFileNode[],
  query: string,
): Set<string> => {
  const q = query.trim().toLowerCase();
  const matches = new Set<string>();
  if (!q) return matches;

  const walk = (list: ProjectFileNode[], parents: string[]): boolean => {
    let any = false;
    for (const node of list) {
      const selfHit = node.name.toLowerCase().includes(q);
      const childHit = node.children ? walk(node.children, [...parents, node.path]) : false;

      if (selfHit || childHit) {
        matches.add(node.path);
        for (const parent of parents) matches.add(parent);
        any = true;
      }

      // Matching folder: include every descendant so its contents stay visible.
      if (selfHit && node.children) {
        const includeAll = (items: ProjectFileNode[]) => {
          for (const item of items) {
            matches.add(item.path);
            if (item.children) includeAll(item.children);
          }
        };
        includeAll(node.children);
      }
    }
    return any;
  };

  walk(nodes, []);
  return matches;
};

function FileTreeNode({
  node,
  depth,
  selectedPath,
  expanded,
  filterPaths,
  filtering,
  onSelect,
  onToggle,
}: {
  node: ProjectFileNode;
  depth: number;
  selectedPath: string | null;
  expanded: Set<string>;
  filterPaths: Set<string>;
  filtering: boolean;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}) {
  if (filtering && !filterPaths.has(node.path)) return null;

  const isDir = node.type === "directory";
  const isOpen = expanded.has(node.path) || (filtering && filterPaths.has(node.path));
  const isSelected = selectedPath === node.path;

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          if (isDir) onToggle(node.path);
          else onSelect(node.path);
        }}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[13px] transition-colors",
          isSelected
            ? "bg-sky-500/20 text-sky-100 ring-1 ring-sky-500/40"
            : "text-zinc-300 hover:bg-white/5 hover:text-zinc-100",
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        aria-label={isDir ? `${isOpen ? "Collapse" : "Expand"} ${node.name}` : node.name}
        aria-expanded={isDir ? isOpen : undefined}
      >
        {isDir ? (
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-zinc-500 transition-transform duration-200 ease-[cubic-bezier(.215,.61,.355,1)]",
              isOpen && "rotate-90",
            )}
          />
        ) : (
          <span className="size-3.5 shrink-0" />
        )}
        {isDir ? (
          isOpen ? (
            <FolderOpenIcon className="size-3.5 shrink-0 text-amber-400/90" />
          ) : (
            <FolderIcon className="size-3.5 shrink-0 text-amber-400/80" />
          )
        ) : (
          <FileIcon className={cn("size-3.5 shrink-0", fileIconClass(node.name))} />
        )}
        <span className="truncate">{node.name}</span>
      </button>
      {isDir && isOpen && node.children?.map((child) => (
        <FileTreeNode
          key={child.path}
          node={child}
          depth={depth + 1}
          selectedPath={selectedPath}
          expanded={expanded}
          filterPaths={filterPaths}
          filtering={filtering}
          onSelect={onSelect}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}

export function CodePreview({
  projectId,
  active,
}: {
  projectId: string;
  active: boolean;
}) {
  const [tree, setTree] = useState<ProjectFileNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(true);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [content, setContent] = useState<string | null>(null);
  const [language, setLanguage] = useState("plaintext");
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);

  const loadTree = useCallback(async () => {
    setTreeLoading(true);
    setTreeError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/files`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Failed to load files");
      const data = (await response.json()) as { tree?: ProjectFileNode[] };
      const nextTree = data.tree ?? [];
      setTree(nextTree);
      setRefreshToken((token) => token + 1);

      const initial = new Set<string>();
      for (const node of nextTree) {
        if (node.type === "directory" && DEFAULT_EXPAND.has(node.name)) {
          initial.add(node.path);
        }
      }
      setExpanded((prev) => (prev.size > 0 ? prev : initial));

      setSelectedPath((current) => {
        if (current) return current;
        const firstFile =
          nextTree.find((n) => n.type === "file") ??
          nextTree
            .flatMap((n) => n.children ?? [])
            .find((n) => n.type === "file");
        return firstFile?.path ?? null;
      });
    } catch {
      setTreeError("Could not load project files.");
    } finally {
      setTreeLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setSelectedPath(null);
    setExpanded(new Set());
    setQuery("");
    setContent(null);
  }, [projectId]);

  useEffect(() => {
    if (!active) return;
    void loadTree();
  }, [active, loadTree]);

  useEffect(() => {
    if (!active) return;
    const handleRefresh = () => {
      void loadTree();
    };
    window.addEventListener("ai-builder:projects-updated", handleRefresh);

    const handleThreadState = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string | null; isRunning?: boolean }>)
        .detail;
      if (!detail || detail.isRunning) return;
      if (detail.projectId && detail.projectId !== projectId) return;
      void loadTree();
    };
    window.addEventListener(
      "ai-builder:thread-state",
      handleThreadState as EventListener,
    );

    return () => {
      window.removeEventListener("ai-builder:projects-updated", handleRefresh);
      window.removeEventListener(
        "ai-builder:thread-state",
        handleThreadState as EventListener,
      );
    };
  }, [active, loadTree, projectId]);

  useEffect(() => {
    if (!active || !selectedPath) return;

    let cancelled = false;
    setContentLoading((wasLoading) => wasLoading || content === null);
    setContentError(null);

    void (async () => {
      try {
        const response = await fetch(
          `/api/projects/${projectId}/files?path=${encodeURIComponent(selectedPath)}`,
          { cache: "no-store" },
        );
        const data = (await response.json()) as FileContentResponse;
        if (cancelled) return;
        if (!response.ok || !("ok" in data) || !data.ok) {
          setContent(null);
          setContentError(
            "error" in data ? data.error : "Could not read this file.",
          );
          return;
        }
        setContent(data.content);
        setLanguage(data.language);
      } catch {
        if (!cancelled) {
          setContent(null);
          setContentError("Could not read this file.");
        }
      } finally {
        if (!cancelled) setContentLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // content is intentionally omitted: used only to avoid a loading flash on soft refresh
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, projectId, selectedPath, refreshToken]);

  const filterPaths = useMemo(
    () => collectPaths(tree, query),
    [tree, query],
  );
  const filtering = query.trim().length > 0;

  const handleSelectFile = useCallback((path: string) => {
    setSelectedPath((current) => {
      if (current !== path) {
        setContent(null);
        setContentError(null);
        setContentLoading(true);
      }
      return path;
    });
  }, []);

  const handleToggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleCopy = useCallback(async () => {
    if (!content) return;
    await navigator.clipboard.writeText(content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }, [content]);

  const handleDownload = useCallback(() => {
    if (!content || !selectedPath) return;
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = selectedPath.split("/").pop() ?? "file.txt";
    anchor.click();
    URL.revokeObjectURL(url);
  }, [content, selectedPath]);

  const lines = content?.split("\n") ?? [];

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-[rgb(24,24,27)] text-zinc-100">
      <aside className="flex w-[260px] shrink-0 flex-col border-r border-white/10">
        <div className="border-b border-white/10 p-2">
          <label className="relative block">
            <span className="sr-only">Search code</span>
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-zinc-500" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search code…"
              spellCheck={false}
              autoComplete="off"
              name="code-search"
              className="h-8 w-full rounded-md border border-white/10 bg-white/5 pr-2.5 pl-8 text-xs text-zinc-200 outline-none placeholder:text-zinc-500 focus:border-sky-500/50 focus:ring-1 focus:ring-sky-500/30"
            />
          </label>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {treeLoading ? (
            <div className="flex items-center justify-center gap-2 px-3 py-8 text-xs text-zinc-500">
              <Loader2Icon className="size-3.5 animate-spin" />
              Loading files…
            </div>
          ) : treeError ? (
            <p className="px-3 py-4 text-xs text-red-300">{treeError}</p>
          ) : tree.length === 0 ? (
            <p className="px-3 py-4 text-xs text-zinc-500">No files yet.</p>
          ) : (
            tree.map((node) => (
              <FileTreeNode
                key={node.path}
                node={node}
                depth={0}
                selectedPath={selectedPath}
                expanded={expanded}
                filterPaths={filterPaths}
                filtering={filtering}
                onSelect={handleSelectFile}
                onToggle={handleToggle}
              />
            ))
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-white/10 px-3">
          <div className="flex min-w-0 flex-1 items-center">
            {selectedPath ? (
              <div className="inline-flex max-w-full items-center rounded-t-md border border-b-0 border-white/10 bg-[rgb(30,30,34)] px-3 py-1.5 text-xs text-zinc-200">
                <span className="truncate">{selectedPath}</span>
              </div>
            ) : (
              <span className="text-xs text-zinc-500">Select a file</span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <span className="mr-1 rounded-full border border-white/10 px-2 py-0.5 text-[10px] font-medium tracking-wide text-zinc-400 uppercase">
              Read only
            </span>
            <button
              type="button"
              onClick={() => void handleCopy()}
              disabled={!content}
              className="inline-flex size-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100 disabled:opacity-40"
              aria-label="Copy file"
              title="Copy"
            >
              {copied ? (
                <CheckIcon className="size-3.5 text-emerald-400" />
              ) : (
                <CopyIcon className="size-3.5" />
              )}
            </button>
            <button
              type="button"
              onClick={handleDownload}
              disabled={!content}
              className="inline-flex size-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100 disabled:opacity-40"
              aria-label="Download file"
              title="Download"
            >
              <DownloadIcon className="size-3.5" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto bg-[rgb(18,18,20)]">
          {contentLoading ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-zinc-500">
              <Loader2Icon className="size-4 animate-spin" />
              Loading…
            </div>
          ) : contentError ? (
            <div className="flex h-full items-center justify-center px-6 text-sm text-zinc-400">
              {contentError}
            </div>
          ) : content !== null ? (
            <pre className="min-w-full p-0 font-mono text-[12.5px] leading-6">
              <code className="grid grid-cols-[auto_1fr]">
                {lines.map((line, index) => (
                  <span key={index} className="contents">
                    <span className="select-none px-3 text-right text-zinc-600 tabular-nums">
                      {index + 1}
                    </span>
                    <span className="whitespace-pre pr-4 text-zinc-200">
                      {highlightLine(line, language)}
                      {"\n"}
                    </span>
                  </span>
                ))}
              </code>
            </pre>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-zinc-500">
              Choose a file to inspect the generated code.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
