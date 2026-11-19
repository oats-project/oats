// What the plugin does to an agent: Stop, Start, Restart and Retire, each through the plugin's
// server and so through OATS. Stop and Retire show the kernel's plan and ask once. The requests
// come from thread menus and from pages; one overlay per app window draws them.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { BbNavigate } from "@get-bb/plugin-sdk/app";
import { clean } from "./format";
import { errorMessage } from "./store";
import type { Contract, Rpc } from "./store";
import { Button, ErrorLine, Modal, Note } from "./ui";

export type PlanVerb = "stop" | "retire";
export type RunVerb = "start" | "restart";

type Request =
  | { kind: "plan"; verb: PlanVerb; instance: string; id: number }
  | { kind: "running"; verb: RunVerb; instance: string }
  | { kind: "failed"; verb: RunVerb; instance: string; message: string };

let current: Request | null = null;
/** A failure that arrived while another request was on screen: shown when that one closes. */
let deferred: Request | null = null;
let sequence = 0;
const listeners = new Set<() => void>();
function set(next: Request | null): void {
  current = next ?? deferred;
  if (next === null) deferred = null;
  for (const listener of [...listeners]) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const get = () => current;

/** For tests: a new app window starts with nothing asked. */
export function resetActs(): void {
  current = null;
  deferred = null;
  listeners.clear();
}

/**
 * A key the kernel uses to make an apply or a spawn idempotent: one per intent, reused when the
 * same intent is retried. `crypto.randomUUID` is absent on a plain-http origin (a phone on the
 * LAN), `getRandomValues` is not.
 */
export function newKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Ask for the kernel's plan to stop or retire an agent; the overlay shows it and asks once. */
export function askPlan(verb: PlanVerb, instance: string): void {
  set({ kind: "plan", verb, instance, id: ++sequence });
}

/** Start or restart an agent through OATS, then open the thread the kernel answers with. */
export async function run(verb: RunVerb, instance: string, rpc: Rpc, navigate: BbNavigate): Promise<void> {
  const mine: Request = { kind: "running", verb, instance };
  set(mine);
  try {
    const { threadId } = await rpc.call(verb, { instance });
    // The person may have moved on to another request meanwhile: their screen is left as it is.
    if (current !== mine) return;
    set(null);
    navigate.toThread(threadId);
  } catch (cause) {
    // The thread menu contains and hides a thrown error: say it here instead, without replacing
    // a dialog the person opened meanwhile.
    const failed: Request = { kind: "failed", verb, instance, message: errorMessage(cause) };
    if (current === mine || current === null) set(failed);
    else deferred = failed;
  }
}

const PLAN = {
  stop: { plan: "stopPlan", apply: "stopApply", title: "Stop", confirm: "Stop agent", done: "stopped" },
  retire: { plan: "retirePlan", apply: "retireApply", title: "Retire", confirm: "Retire agent", done: "retired" },
} as const satisfies Record<PlanVerb, { plan: keyof Contract; apply: keyof Contract; title: string; confirm: string; done: string }>;

type PlanState =
  | { phase: "reading" }
  | { phase: "ready"; revision: string; lines: string[]; key: string; error: string | null; applying: boolean }
  | { phase: "unreadable"; error: string };

function PlanDialog({ request }: { request: Extract<Request, { kind: "plan" }> }) {
  const rpc = useRpc<Contract>();
  const words = PLAN[request.verb];
  const [state, setState] = useState<PlanState>({ phase: "reading" });
  const [attempt, setAttempt] = useState(0);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    let wanted = true;
    setState({ phase: "reading" });
    rpc.call(words.plan, { instance: request.instance }).then(
      (plan) => {
        // A new plan is a new intent: it gets its own idempotency key.
        if (wanted) setState({ phase: "ready", ...plan, key: newKey(), error: null, applying: false });
      },
      (cause: unknown) => {
        if (wanted) setState({ phase: "unreadable", error: errorMessage(cause) });
      },
    );
    return () => {
      wanted = false;
    };
  }, [rpc, words.plan, request.instance, attempt]);

  // Once Confirm is pressed the act is on its way: the dialog stays until OATS answers, so its
  // refusal has a place to show and a closed dialog never reads as "cancelled".
  const applying = state.phase === "ready" && state.applying;
  const cancel = () => {
    if (!applying) set(null);
  };
  const confirm = () => {
    if (state.phase !== "ready" || state.applying) return;
    const { revision, key } = state;
    setState({ ...state, applying: true, error: null });
    rpc.call(words.apply, { instance: request.instance, revision, key }).then(
      () => {
        if (current === request) set(null);
      },
      (cause: unknown) => {
        if (live.current) setState((now) => (now.phase === "ready" ? { ...now, applying: false, error: errorMessage(cause) } : now));
      },
    );
  };

  return (
    <Modal
      title={`${words.title} ${clean(request.instance)}?`}
      onCancel={cancel}
      footer={
        <>
          <Button data-testid="oats-plan-cancel" disabled={applying} onClick={cancel}>
            Cancel
          </Button>
          {state.phase === "ready" && state.error !== null ? (
            <Button data-testid="oats-plan-reread" onClick={() => setAttempt((n) => n + 1)}>
              Read the plan again
            </Button>
          ) : null}
          <Button
            data-testid="oats-plan-confirm"
            variant={request.verb === "retire" ? "destructive" : "primary"}
            disabled={state.phase !== "ready" || state.applying}
            onClick={confirm}
          >
            {applying ? "Working…" : words.confirm}
          </Button>
        </>
      }
    >
      <div data-testid="oats-plan" className="flex flex-col gap-2">
        {state.phase === "reading" ? <Note>Reading the plan from OATS…</Note> : null}
        {state.phase === "unreadable" ? (
          <ErrorLine onRetry={() => setAttempt((n) => n + 1)}>{clean(state.error)}</ErrorLine>
        ) : null}
        {state.phase === "ready" ? (
          <>
            {state.lines.length === 0 ? (
              <Note>OATS gave no detail for this plan.</Note>
            ) : (
              <ul className="flex flex-col gap-1">
                {state.lines.map((line, index) => (
                  <li key={index} className="whitespace-pre-wrap break-words">
                    {clean(line)}
                  </li>
                ))}
              </ul>
            )}
            {state.error === null ? null : <ErrorLine>{clean(state.error)}</ErrorLine>}
          </>
        ) : null}
      </div>
    </Modal>
  );
}

const RUN = { start: { doing: "Starting", failed: "Start" }, restart: { doing: "Restarting", failed: "Restart" } } as const;

/**
 * The plugin's one overlay (experimental_appOverlay): nothing until something is asked. It draws
 * the plan dialogs of Stop and Retire, the running line of Start and Restart, and their failure.
 */
export function ActsOverlay() {
  const request = useSyncExternalStore(subscribe, get, get);
  const rpc = useRpc<Contract>();
  const navigate = useBbNavigate();
  if (request === null) return null;
  if (request.kind === "plan") return <PlanDialog key={request.id} request={request} />;
  if (request.kind === "running") {
    return (
      <div
        role="status"
        data-testid="oats-act-running"
        className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground shadow-lg"
      >
        {`${RUN[request.verb].doing} ${clean(request.instance)} through OATS…`}
      </div>
    );
  }
  return (
    <Modal
      title={`${RUN[request.verb].failed} ${clean(request.instance)} failed`}
      onCancel={() => set(null)}
      footer={
        <>
          <Button data-testid="oats-act-close" onClick={() => set(null)}>
            Close
          </Button>
          <Button
            data-testid="oats-act-again"
            variant="primary"
            onClick={() => void run(request.verb, request.instance, rpc, navigate)}
          >
            Try again
          </Button>
        </>
      }
    >
      <ErrorLine>{clean(request.message)}</ErrorLine>
    </Modal>
  );
}
