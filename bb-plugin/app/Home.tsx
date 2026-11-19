// The OATS home: Needs you, Working, Finished-not-looked-at. A full page (navPanel `home`, the
// phone's page and the target of "N need you") and, on desktop, the same view in a thread's fixed
// tab. Answering is the person's act through bb's SDK; the plugin never types into a session.
import { useEffect, useState } from "react";
import {
  ThreadTitle,
  experimental_useTabVisible as useTabVisible,
  useBbNavigate,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import type { ExperimentalBadge, PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { Node } from "../model/types";
import { flatten } from "../model/view";
import { age, clean, needsYouLabel } from "./format";
import { question } from "./interactions";
import type { Choice, Interaction, Question } from "./interactions";
import { firstLine, useOats } from "./oats";
import type { Oats } from "./oats";
import { PAGES } from "./Sidebar";
import { errorMessage, useRead } from "./store";
import { Button, Dot, ErrorLine, Heading, Note, Page } from "./ui";

/** The home's navigation badge: how many agents need the person. */
export function useHomeBadge(): ExperimentalBadge | null {
  const oats = useOats();
  const n = oats.phase === "ready" ? oats.view.needsYou.length : 0;
  return n === 0 ? null : { count: n, tone: "warning", label: needsYouLabel(n) };
}

type Ready = Extract<Oats, { phase: "ready" }>;

function useOpenThread(): (thread: PluginSidebarThread) => { href: string; onClick(event: React.MouseEvent): void } {
  const navigate = useBbNavigate();
  return (thread) => ({
    href: thread.href,
    onClick: (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      event.preventDefault();
      navigate.toThread(thread.id);
    },
  });
}

/** One agent that needs the person: the question, and where bb lists choices, the answer in place. */
function NeedsYouCard({ node, thread }: { node: Node; thread: PluginSidebarThread }) {
  const sdk = useSdk();
  const open = useOpenThread()(thread);
  const [asked, setAsked] = useState<Question | null>(null);
  const [answering, setAnswering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const pending = thread.hasPendingInteraction;

  useEffect(() => {
    if (!pending) {
      setAsked(null);
      return;
    }
    const controller = new AbortController();
    // From inside a promise, so a client that throws at the call is a failed list like any other.
    Promise.resolve()
      .then(() => sdk.threads.interactions.list({ threadId: thread.id, signal: controller.signal }))
      .then(
      (list) => {
        if (!controller.signal.aborted) setAsked(question(list as readonly Interaction[]));
      },
      () => {
        // bb could not list them: the card keeps its claim text and Open.
        if (!controller.signal.aborted) setAsked(null);
      },
    );
    return () => controller.abort();
  }, [sdk, thread.id, pending, thread.updatedAt]);

  const answer = (choice: Choice) => {
    if (asked === null || answering) return;
    setAnswering(true);
    setError(null);
    Promise.resolve()
      .then(() => sdk.threads.interactions.respond({ threadId: thread.id, interactionId: asked.interactionId, value: choice.value }))
      .then(
      () => {
        setAnswering(false);
        setAsked(null);
      },
      (cause: unknown) => {
        setAnswering(false);
        setError(errorMessage(cause));
      },
    );
  };

  const since = age(node.agent.waiting?.since ?? null, now);
  const text = node.agent.waiting?.message ?? asked?.title ?? "needs your input";
  return (
    <li data-testid="oats-needs-card" className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
      <div className="flex min-w-0 items-center gap-2">
        <Dot state="needs-you" />
        <a {...open} className="min-w-0 flex-1 truncate font-semibold hover:underline">
          <ThreadTitle threadId={thread.id} />
        </a>
        {since === null ? null : <span className="shrink-0 text-xs text-muted-foreground">{since}</span>}
      </div>
      <p className="text-xs text-muted-foreground">{clean(node.agent.soul)}</p>
      <p data-testid="oats-needs-question" className="whitespace-pre-wrap break-words">
        {clean(text)}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {(asked?.choices ?? []).map((choice) => (
          <Button key={String(choice.value)} data-testid="oats-needs-choice" disabled={answering} onClick={() => answer(choice)}>
            {clean(choice.label)}
          </Button>
        ))}
        <a
          {...open}
          data-testid="oats-needs-open"
          className="inline-flex min-h-8 items-center rounded-md border border-border bg-card px-3 py-1 text-sm hover:bg-accent"
        >
          Open
        </a>
      </div>
      {error === null ? null : <ErrorLine>{clean(error)}</ErrorLine>}
    </li>
  );
}

function AgentRows({ nodes, oats, testId }: { nodes: readonly Node[]; oats: Ready; testId: string }) {
  const open = useOpenThread();
  return (
    <ul className="flex flex-col">
      {nodes.flatMap((node) => {
        const thread = oats.threadById.get(node.thread.id);
        if (thread === undefined) return [];
        return [
          <li key={thread.id}>
            <a {...open(thread)} data-testid={testId} className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
              <Dot state={node.state} />
              <span className="min-w-0 flex-1 truncate">
                <ThreadTitle threadId={thread.id} />
              </span>
              <span className="shrink-0 truncate text-xs text-muted-foreground">{clean(node.agent.soul)}</span>
            </a>
          </li>,
        ];
      })}
    </ul>
  );
}

/** Pick an agent, type, send: bb's own send, as the person at the screen. */
function ReplyBox({ oats }: { oats: Ready }) {
  const sdk = useSdk();
  const nodes = flatten(oats.view.roots);
  const [picked, setPicked] = useState<string>("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  if (nodes.length === 0) return null;
  // The agent picked, while it is still in the tree; else the first that needs the person.
  const threadId = nodes.some((node) => node.thread.id === picked)
    ? picked
    : (oats.view.needsYou[0] ?? nodes[0]!).thread.id;

  const send = () => {
    const body = text.trim();
    if (body === "" || sending) return;
    setSending(true);
    setError(null);
    setSent(null);
    Promise.resolve()
      .then(() => sdk.threads.send({ threadId, mode: "auto", input: [{ type: "text", text: body, mentions: [] }] }))
      .then(
      () => {
        setSending(false);
        setText("");
        setSent(threadId);
      },
      (cause: unknown) => {
        setSending(false);
        setError(errorMessage(cause));
      },
    );
  };

  return (
    <form
      data-testid="oats-reply"
      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Reply to
        <select
          data-testid="oats-reply-agent"
          className="min-h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
          value={threadId}
          onChange={(event) => setPicked(event.target.value)}
        >
          {nodes.map((node) => (
            <option key={node.thread.id} value={node.thread.id}>
              {`${clean(node.thread.displayTitle)} · ${clean(node.agent.instance)}`}
            </option>
          ))}
        </select>
      </label>
      <textarea
        data-testid="oats-reply-text"
        aria-label="Message"
        rows={3}
        className="rounded-md border border-border bg-background p-2 text-sm text-foreground"
        placeholder="Write to the agent…"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="flex items-center justify-end gap-2">
        {sent === null ? null : <span role="status" className="text-xs text-muted-foreground">Sent.</span>}
        <Button type="submit" variant="primary" data-testid="oats-reply-send" disabled={sending || text.trim() === ""}>
          {sending ? "Sending…" : "Send"}
        </Button>
      </div>
      {error === null ? null : <ErrorLine>{clean(error)}</ErrorLine>}
    </form>
  );
}

/** The tab's Workspace block: counts that link to the four pages. */
function Workspace({ oats, visible }: { oats: Ready; visible: boolean }) {
  const navigate = useBbNavigate();
  const souls = useRead("souls", { enabled: visible });
  const capabilities = useRead("capabilities", { enabled: visible });
  const teams = useRead("teams", { enabled: visible });
  const machines = useRead("machines", { enabled: visible });
  const counts: Record<(typeof PAGES)[number]["path"], number | undefined> = {
    souls: souls.data?.souls.length,
    capabilities: capabilities.data?.capabilities.length,
    teams: teams.data?.teams.length,
    machines: machines.data?.machines.length,
  };
  return (
    <section className="flex flex-col gap-2">
      <Heading>Workspace</Heading>
      <p className="text-xs text-muted-foreground">{`${clean(oats.deployment.workspace)} · ${clean(oats.deployment.machine)}`}</p>
      <ul className="grid grid-cols-2 gap-2">
        {PAGES.map((page) => (
          <li key={page.path}>
            <button
              type="button"
              data-testid={`oats-workspace-${page.path}`}
              className="flex w-full items-baseline justify-between gap-2 rounded-md border border-border bg-card px-3 py-2 text-left hover:bg-accent"
              onClick={() => navigate.toPluginPanel(page.path)}
            >
              <span>{page.title}</span>
              <span className="text-muted-foreground">{counts[page.path] ?? "…"}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Sections({ oats, where, visible }: { oats: Oats; where: "page" | "tab"; visible: boolean }) {
  if (oats.phase === "loading") return <Note>Reading OATS…</Note>;
  if (oats.phase === "failed") return <ErrorLine onRetry={oats.retry}>{clean(firstLine(oats.message))}</ErrorLine>;
  const { view } = oats;
  return (
    <>
      <section data-testid="oats-home-needs" className="flex flex-col gap-2">
        <Heading n={view.needsYou.length}>Needs you</Heading>
        {view.needsYou.length === 0 ? (
          <Note>Nothing waits on you.</Note>
        ) : (
          <ul className="flex flex-col gap-2">
            {view.needsYou.flatMap((node) => {
              const thread = oats.threadById.get(node.thread.id);
              return thread === undefined ? [] : [<NeedsYouCard key={thread.id} node={node} thread={thread} />];
            })}
          </ul>
        )}
      </section>
      <section data-testid="oats-home-working" className="flex flex-col gap-2">
        <Heading n={view.working.length}>Working</Heading>
        {view.working.length === 0 ? <Note>No agent is working.</Note> : <AgentRows nodes={view.working} oats={oats} testId="oats-working-row" />}
      </section>
      <section data-testid="oats-home-finished" className="flex flex-col gap-2">
        <Heading n={view.finished.length}>Finished, not looked at</Heading>
        {view.finished.length === 0 ? (
          <Note>Nothing new to look at.</Note>
        ) : (
          <AgentRows nodes={view.finished} oats={oats} testId="oats-finished-row" />
        )}
      </section>
      {where === "page" ? <ReplyBox oats={oats} /> : <Workspace oats={oats} visible={visible} />}
    </>
  );
}

/** The full page: the phone's home, and where "N need you" leads. */
export function HomePage() {
  const oats = useOats();
  return (
    <Page testId="oats-home-page">
      <Sections oats={oats} where="page" visible />
    </Page>
  );
}

/** The same view in a thread's fixed side-panel tab, on desktop. */
export function HomeTab() {
  const oats = useOats();
  const visible = useTabVisible();
  return (
    <div data-testid="oats-home-tab" className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-3 text-sm text-foreground">
      <Sections oats={oats} where="tab" visible={visible} />
    </div>
  );
}
