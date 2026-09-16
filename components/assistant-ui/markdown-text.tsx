"use client";

import {
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
} from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";
import { memo } from "react";

import CodeBlock from "@/components/primitives/CodeBlock";
import { cn } from "@/lib/utils";

const MarkdownTextImpl = () => {
  return (
    <MarkdownTextPrimitive
      remarkPlugins={[remarkGfm]}
      className="aui-md"
      components={defaultComponents}
    />
  );
};

export const MarkdownText = memo(MarkdownTextImpl);

const defaultComponents = memoizeMarkdownComponents({
  h1: ({ className, ...props }) => (
    <h1
      className={cn(
        "aui-md-h1 mt-6 mb-3 scroll-m-20 text-[20px] font-semibold tracking-tight text-ink first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h2: ({ className, ...props }) => (
    <h2
      className={cn(
        "aui-md-h2 mt-6 mb-2 scroll-m-20 text-[17px] font-semibold tracking-tight text-ink first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h3: ({ className, ...props }) => (
    <h3
      className={cn(
        "aui-md-h3 mt-5 mb-2 scroll-m-20 text-[15px] font-semibold text-ink first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h4: ({ className, ...props }) => (
    <h4
      className={cn(
        "aui-md-h4 mt-4 mb-2 scroll-m-20 text-[14px] font-semibold text-ink first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h5: ({ className, ...props }) => (
    <h5
      className={cn(
        "aui-md-h5 mt-4 mb-2 text-[14px] font-medium text-ink first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  h6: ({ className, ...props }) => (
    <h6
      className={cn(
        "aui-md-h6 mt-4 mb-2 text-[13px] font-medium text-ink-2 first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  p: ({ className, ...props }) => (
    <p
      className={cn(
        "aui-md-p my-3 leading-[1.65] first:mt-0 last:mb-0",
        className,
      )}
      {...props}
    />
  ),
  a: ({ className, ...props }) => (
    <a
      className={cn(
        "aui-md-a font-medium text-accent-ink underline decoration-accent-ink/30 underline-offset-2 transition-colors hover:decoration-current",
        className,
      )}
      {...props}
    />
  ),
  blockquote: ({ className, ...props }) => (
    <blockquote
      className={cn(
        "aui-md-blockquote my-3 border-l-2 border-line-strong pl-4 text-ink-2",
        className,
      )}
      {...props}
    />
  ),
  ul: ({ className, ...props }) => (
    <ul
      className={cn(
        "aui-md-ul my-3 ml-5 list-disc marker:text-ink-3 [&>li]:mt-1.5",
        className,
      )}
      {...props}
    />
  ),
  ol: ({ className, ...props }) => (
    <ol
      className={cn(
        "aui-md-ol my-3 ml-5 list-decimal marker:text-ink-3 [&>li]:mt-1.5",
        className,
      )}
      {...props}
    />
  ),
  hr: ({ className, ...props }) => (
    <hr className={cn("aui-md-hr my-5 border-line", className)} {...props} />
  ),
  table: ({ className, ...props }) => (
    <table
      className={cn(
        "aui-md-table my-4 w-full border-separate border-spacing-0 overflow-hidden rounded-card text-[13px] shadow-card",
        className,
      )}
      {...props}
    />
  ),
  th: ({ className, ...props }) => (
    <th
      className={cn(
        "aui-md-th border-b border-line bg-inset px-3 py-2 text-left font-medium text-ink-2 [[align=center]]:text-center [[align=right]]:text-right",
        className,
      )}
      {...props}
    />
  ),
  td: ({ className, ...props }) => (
    <td
      className={cn(
        "aui-md-td border-b border-line px-3 py-2 text-left [[align=center]]:text-center [[align=right]]:text-right",
        className,
      )}
      {...props}
    />
  ),
  tr: ({ className, ...props }) => (
    <tr
      className={cn("aui-md-tr [&:last-child>td]:border-b-0", className)}
      {...props}
    />
  ),
  sup: ({ className, ...props }) => (
    <sup
      className={cn("aui-md-sup [&>a]:text-xs [&>a]:no-underline", className)}
      {...props}
    />
  ),
  // Only reached when a plugin turns a code block's content into elements; plain fences use SyntaxHighlighter.
  pre: ({ className, ...props }) => (
    <pre
      className={cn(
        "aui-md-pre my-4 overflow-x-auto rounded-card bg-surface p-3 font-mono text-[12.5px] text-ink-2 shadow-card",
        className,
      )}
      {...props}
    />
  ),
  code: function Code({ className, ...props }) {
    const isCodeBlock = useIsMarkdownCodeBlock();
    return (
      <code
        className={cn(
          !isCodeBlock &&
            "aui-md-inline-code rounded-[5px] bg-field px-1 py-px font-mono text-[0.9em] text-ink shadow-hairline",
          className,
        )}
        {...props}
      />
    );
  },
  /** Fenced code as Beautiful UI's CodeBlock, which carries its own language label and Copy. */
  SyntaxHighlighter: ({ language, code }) => (
    <div className="my-4">
      <CodeBlock
        filename={language === "unknown" ? "text" : language}
        code={code}
        lines={code.replace(/\n$/, "").split("\n")}
      />
    </div>
  ),
  CodeHeader: () => null,
});
