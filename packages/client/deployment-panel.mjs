/** What one deployment's observation becomes for a client's panel (#855, 1d): the kernel's roster as
 * rows, the liveness collector's input and its answers, each row as the panel serves it, and the
 * deployment's entry: before the first probe, after a failed read, and observed.
 *
 * Every function takes what it needs and returns a value. Nothing is kept between calls, and nothing
 * here reads a clock, a file or a process: a client runs the collector itself (liveness-main.mjs, as a
 * child, with its own environment and limits) and gives what it printed to `livenessAnswers`, and it
 * passes the time of its call as `at`, an ISO string. Each client keeps its own store of entries.
 * The collector runs only for a kernel without feature status-liveness (`kernelLiveness`): with it, the
 * kernel's rows are the liveness reading and a client projects them with no answers, `panelInstances(rows, [])`.
 *
 * Not for a page: this module imports `node:path`. What a page shows of a deployment that is not
 * observed is in deployment-facts.mjs (`deploymentUnavailableText`), and the Desktop's
 * test/inventory.test.mjs holds that its page reaches no module that imports a Node builtin. */
import { dirname } from 'node:path';
import { livenessOrigin } from './liveness.mjs';
import { knownOrigin, hasRuntimeError, byRuntimeState, instanceColor, sessionProvider } from './instance-presentation.mjs';
import { retireData } from './retire-state.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** The `backend` a row of this machine carries on, or undefined: the row's own, but never "herdr". A Herdr-recorded
 * row of this machine is known by its `sessionTarget` or its `runtimeState` (instance-presentation.mjs
 * `unsupportedSession`), as before session providers; one that only names the backend reads as it always did.
 * deployment-data.mjs already drops it from a kernel's row; this serves the rows that reach the panel another way. */
const localBackend = (row) => (row.backend === 'herdr' ? undefined : row.backend);

/** One row per instance of a roster (deployment-data.mjs `deploymentStatusData`): the kernel's row,
 * with `agent`, `description` and `team` from its soul and `agentsRoot` from the roster, and `soulKey`, the
 * agent row's soul key (`key`, feature launch-preference: a string, or null when no instance records a
 * workspace soul), present only when the agent row has `key`.
 * Needs input: a row keeps the kernel's `waitingOnYou` only when this CLI advertises waiting-on-you.
 * Gate on the feature, never the version: a pre-feature kernel emitting the field is dropped. A row
 * without the key stays without it. */
export function rosterRows(roster, cli) {
  const waitingFeature = Array.isArray(cli?.features) && cli.features.includes("waiting-on-you");
  return roster.agents.flatMap((agent) => agent.instances.map(({ waitingOnYou, ...instance }) => ({
    ...instance, ...(waitingFeature && waitingOnYou !== undefined ? { waitingOnYou } : {}),
    agent: instance.agent || agent.name, description: agent.description || "",
    team: agent.team || null, agentsRoot: roster.root, ...(Object.hasOwn(agent, "key") ? { soulKey: agent.key } : {}),
  })));
}

/** The kernel feature under which `oats status --json` rows carry the complete local liveness reading. */
export const STATUS_LIVENESS_FEATURE = "status-liveness";

/** Whether this CLI's status rows are the liveness reading (feature status-liveness): their `running`,
 * `runtimeState`, `runtimeError` and `tmux` are the kernel's, under its pane rule, and a client runs no
 * collector and probes no terminal. `cli` is the probe record the read was made with, never a later one.
 * Gate on the feature, never the version. Without it the collector runs as before (`livenessInput`,
 * `livenessAnswers`). With it, a row the kernel answered `running: null` stays unknown with the kernel's
 * state and text (origin "kernel", `panelInstances`), and a home with no `tmux` record has none: nothing
 * fills a default session or window, so no terminal opens for it. */
export function kernelLiveness(cli) {
  return Array.isArray(cli?.features) && cli.features.includes(STATUS_LIVENESS_FEATURE);
}

/** The liveness collector's input (liveness.mjs `observeLiveness`), one per row, in the rows' order.
 * `running` is the kernel's answer: the collector leaves a row it answered `null` as the kernel has it. */
export function livenessInput(rows) {
  return rows.map((i) => ({ instance: i.instance, running: i.running, tmux: i.tmux, sessionTarget: i.sessionTarget,
    // A row on a session provider is never probed (liveness.mjs): the collector knows it by its `backend`. Never
    // "herdr": a Herdr-recorded row of this machine is known by its `sessionTarget` or its state, as before.
    ...(localBackend(i) !== undefined ? { backend: localBackend(i) } : {}),
    runtimeState: i.runtimeState, runtimeError: i.runtimeError }));
}

/** The collector's answers, one per row. `stdout` is what the collector printed, or `null` when it
 * failed, timed out or could not start. Anything that is not JSON for an array of exactly
 * `rows.length` answers gives every row the unknown answer; no rows give `[]`, whatever was printed.
 *
 * An answer with a `runtimeError` says who made it, in `runtimeErrorOrigin` (instance-presentation.mjs
 * names the speakers). The speaker is decided here, in this process, and never read from what the
 * collector printed: a `runtimeErrorOrigin` in its output is dropped, and the key is set from the row
 * that was sent (liveness.mjs `livenessOrigin`: which answer `observeLiveness` gives is a function of
 * the row alone). So `rows` are the rows whose `livenessInput` the collector was given. The unknown
 * answer written here is the terminal check's own. */
export function livenessAnswers(rows, stdout) {
  if (!rows.length) return [];
  const unknown = () => rows.map(() => ({ running: null, runtimeState: "unreachable", runtimeError: "Terminal status is unavailable", runtimeErrorOrigin: "terminal-probe" }));
  if (typeof stdout !== "string") return unknown();
  try {
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed) || parsed.length !== rows.length) return unknown();
    return parsed.map((printed, index) => {
      if (!record(printed)) return printed;
      const { runtimeErrorOrigin: _printed, ...answer } = printed;
      const origin = hasRuntimeError(answer) ? livenessOrigin(rows[index]) : null;
      return origin ? { ...answer, runtimeErrorOrigin: origin } : answer;
    });
  } catch { return unknown(); }
}

/** A row as the panel serves it: the per-instance contract a client's grouping and overview read.
 * A dropped or misspelt field here is a field no view receives. */
export function panelInstance(i) {
  return {
    instance: i.instance, agent: i.agent, description: i.description,
    // The reported harness only (harness-names.mjs reads a released kernel's runtime); never a guessed default.
    repo: i.repo, work: i.work, branch: i.branch || null, harness: i.harness || null,
    model: i.model || null, running: i.running, createdAt: i.createdAt,
    home: i.home, agentsRoot: i.agentsRoot,
    workspace: dirname(i.agentsRoot), repoName: (i.repo || dirname(i.agentsRoot)).split("/").pop(),
    parentInstance: i.parentInstance || null,
    // Agent relations (kernel contract, final): siblingInstance links a
    // declared sibling to a ROOT anchor; relation/relativeTo record what
    // was declared at spawn. Forwarded for cluster grouping and the
    // cluster-first overview.
    siblingInstance: i.siblingInstance || null,
    relation: i.relation || null,
    relativeTo: i.relativeTo || null,
    ...(i.sessionTarget ? { sessionTarget: i.sessionTarget } : {}),
    runtimeState: i.runtimeState, runtimeError: i.runtimeError,
    // Who made that text: only beside a `runtimeError`, and only one of the three speakers.
    ...(hasRuntimeError(i) && knownOrigin(i.runtimeErrorOrigin) ? { runtimeErrorOrigin: i.runtimeErrorOrigin } : {}),
    tmux: i.tmux, git: null,
    // Session providers: the row's backend ("tmux" or a provider's name), the provider's capability and thread
    // id, and the link it offers in place of a terminal, each as deployment-data.mjs validated it; absent stays
    // absent. instance-presentation.mjs `sessionProvider` and instance-acts.mjs `openAct` read them. "herdr" is no
    // backend of a row of this machine (`localBackend`).
    ...(localBackend(i) !== undefined ? { backend: localBackend(i) } : {}),
    ...(i.session !== undefined ? { session: i.session } : {}),
    ...(i.open !== undefined ? { open: i.open } : {}),
    // Workspace-model v2 facts exactly as `oats status --json` reported them:
    // module drift rows (or the recorded map when the workspace is
    // unreachable), the soul source and the served identity. Identity is
    // present only when a provider reported one — never synthesized.
    ...(i.modules !== undefined ? { modules: i.modules } : {}),
    ...(i.soul !== undefined ? { soul: i.soul } : {}),
    // The soul key the instance was spawned from (rosterRows), as the roster reported it: string or null; absent stays absent.
    ...(i.soulKey !== undefined ? { soulKey: i.soulKey } : {}),
    ...(i.identity !== undefined ? { identity: i.identity } : {}),
    // desktop-facts: the last session start, where the model came from, the messaging identity's address.
    ...(i.startedAt !== undefined ? { startedAt: i.startedAt } : {}),
    ...(i.modelFrom !== undefined ? { modelFrom: i.modelFrom } : {}),
    ...(i.identityAddress !== undefined ? { identityAddress: i.identityAddress } : {}),
    ...(i.retirePending ? { retirePending: true } : {}),
    // #1247: the retire's state, validated again here (retire-state.mjs): a value out of the contract is absent.
    ...(retireData(i.retire) ? { retire: retireData(i.retire) } : {}),
    ...(i.rollbackIncomplete ? { rollbackIncomplete: true } : {}),
    // #802: a spawn setting up its worktree (deployment-data.mjs keeps it as true only).
    ...(i.spawnInProgress === true ? { spawnInProgress: true } : {}),
    // Session resume: how the last session ended, as deployment-data.mjs validated it (SESSION_ENDS); absent stays
    // absent. The resume trigger reads it (session-resume-trigger.mjs lostLocalHomes).
    ...(i.sessionEnd !== undefined ? { sessionEnd: i.sessionEnd } : {}),
    // The kernel's related-work flags (deployment-data.mjs keeps each as true only); related-work.mjs reads them.
    ...(i.relatedWork === true ? { relatedWork: true } : {}),
    ...(i.sameWork === true ? { sameWork: true } : {}),
    ...(i.captured ? { captured: true } : {}),
    // Needs input (PR K): the validated claim (or null, unknown) as status reported it; absent stays absent.
    // The client's liveness is merged before projection, so running/runtimeState beside it are the probe's.
    ...(i.waitingOnYou !== undefined ? { waitingOnYou: i.waitingOnYou } : {}),
    // The owning human (feature spawn-attribution): the label deployment-data.mjs validated, or null; absent stays absent.
    ...(i.attributedHuman !== undefined ? { attributedHuman: i.attributedHuman } : {}),
    // Feature instance-color: the row's colour as instanceColor reads it, present only when it is one.
    ...(instanceColor(i) !== null ? { color: instanceColor(i) } : {}),
    // Feature instance-background (#1579): exactly true, else absent (instance-tree.mjs backgroundPlacement).
    ...(i.background === true ? { background: true } : {}),
    // Feature instance-pin: exactly true, else absent (instance-tree.mjs rowPinned).
    ...(i.pinned === true ? { pinned: true } : {}),
    // Feature instance-board: the board deployment-data.mjs validated (instance-board.mjs), or null; absent stays absent.
    ...(i.board !== undefined ? { board: i.board } : {}),
    team: i.team || null,
  };
}

/** The panel's rows: each row merged with its liveness answer and projected, in the roster's order
 * (`byRuntimeState`: running, unknown, stopped; by name within each).
 * `answers` are `livenessAnswers`', or `[]` under status-liveness (`kernelLiveness`): each row then as the kernel gave it.
 *
 * The merged row's `runtimeErrorOrigin` is set here or removed, whatever the row carried: when the
 * answer holds the `runtimeError`, the answer's speaker; when the answer has none and the kernel's row
 * had one (a probed row the kernel reported with a text), the text is the kernel's, so "kernel".
 *
 * A row on a session provider (instance-presentation.mjs `sessionProvider`) takes nothing from its answer: the
 * collector knows nothing of it, so whatever it printed for the row, and the unknown answer written for every row
 * when the collector failed (`livenessAnswers`), is left out. Its `running`, `runtimeState` and `runtimeError` are
 * the kernel's, whole, and its text's speaker is the kernel. */
export function panelInstances(rows, answers) {
  return rows.map((row, index) => {
    const answer = sessionProvider(row) ? undefined : answers[index], { runtimeErrorOrigin: _carried, ...merged } = { ...row, ...answer };
    const origin = record(answer) && Object.hasOwn(answer, "runtimeError") ? answer.runtimeErrorOrigin : "kernel";
    return panelInstance(hasRuntimeError(merged) ? { ...merged, runtimeErrorOrigin: origin } : merged);
  }).sort(byRuntimeState);
}

/** A deployment's entry before the first CLI probe has settled, when there is no verdict to report:
 * the entry already held, or a pending one. */
export function pendingEntry(previous, at) {
  return previous || { deployment: { status: "pending" }, instances: [], generatedAt: at };
}

/** A deployment's entry after a read that failed with `reason` (deployment-contract.mjs).
 * A transient busy or stale read keeps the entry held, as it is. A remote the kernel could not read
 * (a cache problem, the network, a timeout) does not erase what was observed: the last observation
 * stays, marked with the failure, the kernel's message and its bounded cause (Spec D); an `error`, an
 * `errorOrigin` and an `errorCause` it already carried are replaced, the origin and the cause removed
 * when this reason has none.
 * Every other failure, and each of those without an entry to keep, is shown as unavailable with the
 * reason, never as an empty roster.
 *
 * The kept entry's `error` is always a string: the reason's message, or "" when it carries none. That
 * `error` is a string is the fact "a failure is kept" (deployment-facts.mjs `keptFailure`, the one place
 * that reads it); what the string holds decides nothing.
 * `errorOrigin: "kernel"` stands beside it when the reason is one the installed CLI printed (the reader's
 * `origin: 'kernel'`, deployment-read-cli.mjs), and is absent for any other reason: who shows `error`
 * names its speaker from this key (instance-presentation.mjs `originLead`), and shows a message with no
 * origin as its own, never under the kernel's name. The key is written here only, from the reason given:
 * one the entry already carried never survives. */
export function failedEntry(previous, reason, at) {
  if (previous && ["E_DEPLOYMENT_BUSY", "E_DEPLOYMENT_STALE"].includes(reason?.code)) return previous;
  if (previous?.deployment?.status === "observed" && reason?.code === "E_REMOTE_UNREADABLE") {
    const { error: _error, errorCause: _cause, errorOrigin: _origin, ...kept } = previous;
    const cause = reason.cause;
    return { ...kept, error: typeof reason.message === "string" ? reason.message : "", ...(reason.origin === "kernel" ? { errorOrigin: "kernel" } : {}),
      ...(cause ? { errorCause: { code: reason.code, ...cause } } : {}) };
  }
  return { deployment: { status: "unavailable", reason }, instances: [], generatedAt: at };
}

/** An observed deployment's entry: the observer's answer (deployment-observer.mjs: `roster`,
 * `workspaceStatus`, `observedAt`) and the panel's rows (`panelInstances`). `souls` are the roster's
 * souls without their instances. A client adds its own facts to `deployment` after the call. */
export function observedEntry({ roster, workspaceStatus, observedAt }, instances, at) {
  return {
    deployment: { status: "observed", root: roster.root, workspace: workspaceStatus.workspace, workspaceStatus,
      reachable: roster.workspace ?? null, withheld: roster.withheld,
      souls: roster.agents.map(({ instances: _instances, ...soul }) => soul) },
    instances, generatedAt: at, observedAt,
  };
}

/** The deployment facts a view may show: the header observation, reachability and any unavailable
 * reason. Pending when there is none; as it is when not observed; without the private soul rows
 * (`souls`) and the catalog's key when observed. */
export function publicDeployment(deployment) {
  if (!deployment) return { status: "pending" };
  if (deployment.status !== "observed") return deployment;
  const { souls: _souls, catalogKey: _catalogKey, ...rest } = deployment;
  return rest;
}
