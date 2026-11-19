// Who this agent is (experimental_threadHeaderRow): chips on one line under the thread's header.
// The line scrolls sideways and never wraps: a wrapping row was six lines tall on a phone.
import {
  experimental_useAppPanel as useAppPanel,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import type { ExperimentalThreadHeaderRowProps } from "@get-bb/plugin-sdk/app";
import { clean, count, homeTail } from "./format";
import { useOats } from "./oats";
import { Chip, plainClick } from "./ui";

/** The fixed thread tab that shows the OATS home on desktop. */
export const HOME_TAB = { id: "home", context: { kind: "thread" }, availability: "fixed" } as const;

/** bb's own breakpoint for its compact (phone) layout. */
export const COMPACT_VIEWPORT_QUERY = "(max-width: 767px)";
export function isCompactViewport(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(COMPACT_VIEWPORT_QUERY).matches
    : false;
}

export function IdentityRow({ threadId }: ExperimentalThreadHeaderRowProps) {
  const oats = useOats();
  const navigate = useBbNavigate();
  const panel = useAppPanel();
  if (oats.phase !== "ready") return null;
  const node = oats.nodeByThread.get(threadId);
  if (node === undefined) return null; // not an OATS agent: take no space

  const { agent } = node;
  const parent = agent.parent === null ? undefined : oats.nodeByInstance.get(agent.parent);
  const parentThread = parent === undefined ? undefined : oats.threadById.get(parent.thread.id);
  const children = oats.agents.filter((other) => other.parent === agent.instance).length;
  const identity = agent.address ?? agent.alias;

  const openHome = () => {
    // On a phone the home is a full page. On desktop it is the thread's fixed tab; where bb
    // declines to open it, the page is the same view.
    if (isCompactViewport() || !panel.openTab({ tab: HOME_TAB })) navigate.toPluginPanel("home");
  };

  return (
    <div
      data-testid="oats-identity-row"
      className="flex items-center gap-1.5 overflow-x-auto whitespace-nowrap border-b border-border px-3 py-1.5"
    >
      <Chip title="soul">
        <span data-testid="oats-chip-soul">{clean(oats.soulOf(agent))}</span>
      </Chip>
      <Chip title="instance">
        <span data-testid="oats-chip-instance">{clean(agent.instance)}</span>
      </Chip>
      {identity === null ? null : (
        <Chip title={agent.team === null ? "aweb identity" : `aweb identity, team ${clean(agent.team)}`}>
          <span data-testid="oats-chip-alias">{`✓ ${clean(identity)}`}</span>
        </Chip>
      )}
      {agent.parent !== null ? (
        <Chip title="parent">
          {parentThread === undefined ? (
            <span data-testid="oats-chip-parent">{`parent · ${clean(agent.parent)}`}</span>
          ) : (
            <a
              data-testid="oats-chip-parent"
              href={parentThread.href}
              className="underline"
              onClick={(event) => {
                if (!plainClick(event)) return;
                event.preventDefault();
                navigate.toThread(parentThread.id);
              }}
            >
              {`parent · ${clean(agent.parent)}`}
            </a>
          )}
        </Chip>
      ) : agent.human !== null ? (
        <Chip title="started by">
          <span data-testid="oats-chip-parent">{`parent · ${clean(agent.human)}`}</span>
        </Chip>
      ) : null}
      {children > 0 ? (
        <Chip>
          <span data-testid="oats-chip-children">{count(children, "child", "children")}</span>
        </Chip>
      ) : null}
      <Chip title={agent.home}>
        <span data-testid="oats-chip-home">{`home · ${clean(homeTail(agent.home))}`}</span>
      </Chip>
      <button
        type="button"
        data-testid="oats-chip-oats"
        title="Open the OATS home"
        className="inline-flex shrink-0 items-center whitespace-nowrap rounded-md border border-border bg-card px-2 py-0.5 text-xs font-semibold text-foreground hover:bg-accent"
        onClick={openHome}
      >
        OATS
      </button>
    </div>
  );
}
