/* Beautiful UI — Task Rows. https://www.beautifului.dev
 * MIT License, Copyright (c) 2026 Shane Levine.
 *
 * Adapted for Adorable, where the agent's plan (updatePlanTool) supplies the rows: no
 * scripted status run or demo rows; a row is done, running, or pending (its number in a still
 * ring); the List look only; and no expandable detail, since plan tasks carry none. */
"use client";

function SpinnerRing({
  active,
  children,
}: {
  active?: boolean;
  children?: React.ReactNode;
}) {
  const size = 24,
    stroke = 2;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        className="absolute inset-0"
        style={active ? { animation: "spin 1.1s linear infinite" } : undefined}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--line)"
          strokeWidth={stroke}
        />
        {active && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--ink-3)"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${c * 0.28} ${c * 0.72}`}
          />
        )}
      </svg>
      <span className="relative text-[10.5px] font-semibold text-ink tabular-nums">
        {children}
      </span>
    </span>
  );
}

const CheckBadge = (
  <span
    className="flex size-5.5 shrink-0 items-center justify-center rounded-full bg-green text-white"
    style={{ animation: "pop-in 300ms cubic-bezier(0.23,1,0.32,1) both" }}
  >
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 6L9 17l-5-5" />
    </svg>
  </span>
);

export type TaskRow = {
  key: string;
  label: string;
  status: "done" | "running" | "pending";
  /** the number shown in the ring until the task is done */
  step: number;
};

export type TaskRowsLabels = {
  completed: string;
};

export default function TaskRows({
  rows,
  labels,
  className,
}: {
  rows: TaskRow[];
  labels?: Partial<TaskRowsLabels>;
  className?: string;
}) {
  const copy = { completed: "Completed", ...labels };
  return (
    <div
      className={`flex w-full max-w-110 flex-col self-start overflow-hidden rounded-card bg-surface shadow-card${className ? ` ${className}` : ""}`}
    >
      {rows.map((row, i) => (
        <div
          key={row.key}
          className="flex h-11 items-center gap-2.5 border-b border-line px-2.5 last:border-0"
          style={{
            animation: `fade-up 450ms cubic-bezier(0.23,1,0.32,1) ${i * 80}ms both`,
          }}
        >
          <span className="flex size-6 shrink-0 items-center justify-center">
            {row.status === "done" ? (
              CheckBadge
            ) : (
              <SpinnerRing active={row.status === "running"}>
                {row.step}
              </SpinnerRing>
            )}
          </span>
          <span
            className={`min-w-0 flex-1 truncate text-[13px] font-medium ${row.status === "pending" ? "text-ink-2" : "text-ink"}`}
          >
            {row.label}
          </span>
          {row.status === "done" && (
            <span className="inline-flex h-5.5 items-center rounded-full bg-green-tint px-2 text-[11.5px] font-medium text-green">
              {copy.completed}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
