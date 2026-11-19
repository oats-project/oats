// The sidebar's thread list (experimental_threadList): the "oats" block, then the agents tree,
// then every other bb thread. With no snapshot, bb's threads are still all listed and usable.
import type { MouseEvent, ReactNode } from "react";
import {
  ThreadTitle,
  experimental_ThreadActionsContextMenu as ThreadActionsContextMenu,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  experimental_resolveThreadStatus as resolveThreadStatus,
  experimental_usePluginId as usePluginId,
  useBbNavigate,
  useSidebarThreadDraftIds,
  useSidebarThreadRowStatuses,
} from "@get-bb/plugin-sdk/app";
import type {
  PluginSidebarThread,
  PluginThreadActionTarget,
  PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import { codes } from "../kernel/result";
import type { Node } from "../model/types";
import { clean, count, needsYouLabel } from "./format";
import { failureLine, useOats } from "./oats";
import { Button, Dot, plainClick } from "./ui";


export const PAGES = [
  { path: "souls", title: "Souls" },
  { path: "capabilities", title: "Capabilities" },
  { path: "teams", title: "Teams" },
  { path: "machines", title: "Machines" },
] as const;

function target(thread: PluginSidebarThread): PluginThreadActionTarget {
  return {
    id: thread.id,
    projectId: thread.projectId,
    parentThreadId: thread.parentThreadId,
    parentNotifications: thread.parentNotifications,
    archivedAt: thread.archivedAt,
    pinnedAt: thread.pinnedAt,
    sectionId: thread.sectionId,
    isUnread: thread.isUnread,
    status: thread.status,
    environment:
      thread.environment !== null && thread.environment.id !== null
        ? { id: thread.environment.id, path: thread.environment.path }
        : null,
  };
}

const INDENT = ["pl-2", "pl-6", "pl-10"] as const;
const ROW = "flex min-w-0 items-center gap-2 rounded-md py-1.5 pr-2 text-sm text-foreground hover:bg-accent";
const HEADING = "px-2 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground";

export function Sidebar({ activeThreadId, onNavigate }: PluginThreadListProps) {
  const oats = useOats();
  const navigate = useBbNavigate();
  const pluginId = usePluginId();
  const drafts = useSidebarThreadDraftIds();
  const rowStatuses = useSidebarThreadRowStatuses();

  const openThread = (event: MouseEvent, threadId: string) => {
    if (!plainClick(event)) return;
    event.preventDefault();
    navigate.toThread(threadId);
    onNavigate();
  };
  const openPage = (path: string) => {
    navigate.toPluginPanel(path);
    onNavigate();
  };

  /** Every thread row: bb's anchor contract, inside bb's own thread menu. */
  const threadRow = (thread: PluginSidebarThread, className: string, testId: string, children: ReactNode) => (
    <li key={thread.id}>
      <ThreadActionsContextMenu thread={target(thread)}>
        <a
          href={thread.href}
          data-testid={testId}
          data-sidebar-thread-shortcut-target=""
          data-sidebar-thread-id={thread.id}
          aria-current={thread.id === activeThreadId ? "page" : undefined}
          className={`${ROW} ${className} ${thread.id === activeThreadId ? "bg-accent" : ""}`}
          onClick={(event) => openThread(event, thread.id)}
        >
          {children}
        </a>
      </ThreadActionsContextMenu>
    </li>
  );

  const agentRows = (nodes: readonly Node[]): ReactNode[] =>
    nodes.flatMap((node) => {
      const thread = oats.threadById.get(node.thread.id);
      if (thread === undefined) return [];
      return [
        threadRow(
          thread,
          INDENT[node.depth],
          "oats-agent-row",
          <>
            <Dot state={node.state} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className={`truncate ${thread.isUnread ? "font-semibold" : ""}`}>
                <ThreadTitle threadId={thread.id} />
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {clean(oats.soulOf(node.agent))}
                {node.state === "stopped" ? " · stopped" : ""}
              </span>
            </span>
            {node.state === "needs-you" ? (
              <span className="shrink-0 font-semibold text-amber-500" title="needs you" aria-hidden="true">
                ?
              </span>
            ) : thread.isUnread ? (
              <span className="shrink-0 text-xs text-muted-foreground">new</span>
            ) : null}
          </>,
        ),
        ...agentRows(node.children),
      ];
    });

  const plainRow = (thread: PluginSidebarThread) => {
    const status = resolveThreadStatus({
      thread,
      hiddenThreads: [],
      hasUnsubmittedDraft: drafts.has(thread.id),
      rowStatus: rowStatuses.get(thread.id) ?? null,
    });
    return threadRow(
      thread,
      "pl-2",
      "oats-other-row",
      <>
        <span className="flex size-4 shrink-0 items-center justify-center">
          <ThreadStatusGlyph indicator={status.indicator} rowStatus={status.rowStatus} size="compact" />
        </span>
        <span className={`min-w-0 flex-1 truncate ${thread.isUnread ? "font-semibold" : ""}`}>
          <ThreadTitle threadId={thread.id} />
        </span>
      </>,
    );
  };

  if (oats.phase !== "ready") {
    // bb stays fully usable: one line saying what is missing, and bb's threads as usual.
    const listed = oats.threads
      .filter((thread) => !thread.isArchived && !thread.isHidden)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return (
      <div data-testid="oats-sidebar" className="flex flex-col p-1">
        {oats.phase === "loading" ? (
          <p data-testid="oats-status-line" className="px-2 py-1.5 text-xs text-muted-foreground">
            Reading OATS…
          </p>
        ) : (
          <div data-testid="oats-status-line" role="alert" className="flex flex-col items-start gap-1 px-2 py-1.5 text-xs">
            <span className="break-words text-muted-foreground">{clean(failureLine(oats))}</span>
            <span className="flex flex-wrap items-center gap-2">
              <Button onClick={oats.retry}>Retry</Button>
              {oats.code === codes.chooseHost ? (
                <a className="underline" href={`/settings/plugins/${encodeURIComponent(pluginId)}`}>
                  Choose a machine
                </a>
              ) : null}
            </span>
          </div>
        )}
        <ul className="flex flex-col">{listed.map(plainRow)}</ul>
      </div>
    );
  }

  const { view, deployment, agents } = oats;
  const needs = view.needsYou.length;
  return (
    <div data-testid="oats-sidebar" className="flex flex-col p-1">
      <p data-testid="oats-workspace-line" className="truncate px-2 py-1.5 text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">{clean(deployment.workspace)}</span>
        {` · ${clean(deployment.machine)} · ${count(agents.length, "agent")}`}
      </p>
      <ul className="flex flex-col">
        {PAGES.map((page) => (
          <li key={page.path}>
            <button
              type="button"
              data-testid={`oats-page-link-${page.path}`}
              className={`${ROW} w-full pl-6 text-left`}
              onClick={() => openPage(page.path)}
            >
              {page.title}
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        data-testid="oats-needs-line"
        title={`${needsYouLabel(needs)}: open the OATS home`}
        className={`${ROW} w-full pl-2 text-left ${needs > 0 ? "font-semibold" : "text-muted-foreground"}`}
        onClick={() => openPage("home")}
      >
        {needs > 0 ? <Dot state="needs-you" /> : null}
        {needs > 0 ? `${needs} need you` : "nothing needs you"}
      </button>

      <h2 className={HEADING}>Agents</h2>
      {view.roots.length === 0 ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">No OATS agents run in bb yet.</p>
      ) : (
        <ul data-testid="oats-tree" className="flex flex-col">
          {agentRows(view.roots)}
        </ul>
      )}
      <button
        type="button"
        data-testid="oats-new-agent"
        className={`${ROW} w-full pl-2 text-left text-muted-foreground`}
        onClick={() => openPage("souls")}
      >
        + New agent
      </button>

      {view.others.length > 0 ? (
        <>
          <h2 className={HEADING}>Other threads</h2>
          <ul data-testid="oats-others" className="flex flex-col">
            {view.others.flatMap((other) => {
              const thread = oats.threadById.get(other.id);
              return thread === undefined ? [] : [plainRow(thread)];
            })}
          </ul>
        </>
      ) : null}
    </div>
  );
}
