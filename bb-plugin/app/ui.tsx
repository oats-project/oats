// The plugin's few drawing primitives, on bb's theme tokens only (light and dark follow bb).
import { useEffect, useId, useRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { AgentState } from "../model/types";
import { STATE_WORD } from "./format";

const DOT: Record<AgentState, string> = {
  "needs-you": "bg-amber-500",
  working: "bg-green-500",
  idle: "border border-muted-foreground",
  stopped: "bg-muted-foreground",
  error: "bg-destructive",
  unreachable: "bg-destructive",
};

/** The status dot. Its accessible name is the state's word. */
export function Dot({ state }: { state: AgentState }) {
  return (
    <span
      role="img"
      aria-label={STATE_WORD[state]}
      title={STATE_WORD[state]}
      data-state={state}
      className={`inline-block size-2 shrink-0 rounded-full ${DOT[state]}`}
    />
  );
}

export function Chip({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-border bg-card px-2 py-0.5 text-xs text-foreground"
    >
      {children}
    </span>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "destructive" | "ghost";
};
const BUTTON: Record<NonNullable<ButtonProps["variant"]>, string> = {
  default: "border border-border bg-card text-foreground hover:bg-accent",
  primary: "border border-transparent bg-primary text-primary-foreground hover:opacity-90",
  destructive: "border border-transparent bg-destructive text-white hover:opacity-90",
  ghost: "border border-transparent text-foreground hover:bg-accent",
};
export function Button({ variant = "default", className = "", type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex min-h-8 shrink-0 items-center justify-center gap-1 rounded-md px-3 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-50 ${BUTTON[variant]} ${className}`}
      {...rest}
    />
  );
}

/** A section heading with its count. */
export function Heading({ children, n }: { children: ReactNode; n?: number }) {
  return (
    <h2 className="flex items-baseline gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      <span>{children}</span>
      {n === undefined ? null : <span className="font-normal normal-case">{n}</span>}
    </h2>
  );
}

/** One muted line: an empty section, a loading state. */
export function Note({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

/** A kernel refusal or a failed call, printed unchanged. */
export function ErrorLine({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
      <span className="min-w-0 whitespace-pre-wrap break-words">{children}</span>
      {onRetry === undefined ? null : <Button onClick={onRetry}>Retry</Button>}
    </div>
  );
}

/** The frame of a full page (a navPanel): scrolls by itself, padded, readable width. */
export function Page({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <div data-testid={testId} className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 text-sm text-foreground">{children}</div>
    </div>
  );
}

/**
 * A modal dialog drawn by the plugin: a centred card on a dimmed page, a sheet at the bottom of a
 * phone. Escape and a click on the dimmed page cancel; focus moves into it and stays in it.
 */
export function Modal({
  title,
  children,
  footer,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  footer: ReactNode;
  onCancel: () => void;
}) {
  const titleId = useId();
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    card.current?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4"
      data-testid="oats-modal"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="flex max-h-[85vh] w-full flex-col gap-3 rounded-t-lg border border-border bg-background p-4 text-sm text-foreground shadow-lg outline-none sm:max-w-lg sm:rounded-lg"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onCancel();
            return;
          }
          if (event.key !== "Tab") return;
          // keep Tab inside the dialog
          const stops = card.current?.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], input, textarea, select");
          if (stops === undefined || stops.length === 0) return;
          const first = stops[0]!;
          const last = stops[stops.length - 1]!;
          if (event.shiftKey && (document.activeElement === first || document.activeElement === card.current)) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <h2 id={titleId} className="text-base font-semibold">
          {title}
        </h2>
        <div className="min-h-0 overflow-y-auto">{children}</div>
        <div className="flex flex-wrap justify-end gap-2">{footer}</div>
      </div>
    </div>
  );
}
