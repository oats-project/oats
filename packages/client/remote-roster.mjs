import { harnessOf } from "./harness-names.mjs";
import { unsupportedSession, unsupportedSessionOrigin, hasRuntimeError } from "./instance-presentation.mjs";
import { madeByKernel } from "./kernel-made.mjs";
import { waitingOnYouData } from "./waiting-on-you.mjs";
import { attributedHumanData } from "./attributed-human.mjs";
import { retireData } from "./retire-state.mjs";
import { readIdentity } from "./workspace-views.mjs";
import { sameRepo } from "./repo-moves.mjs";
import { hostAdvertises } from "./composed-gate.mjs";
import { PIN_FEATURE } from "./instance-tree.mjs";
import { BOARD_FEATURE, boardData } from "./instance-board.mjs";
/** Projection of the installed CLI's remote roster. Never reads remote paths locally. */
export function remoteWorkspace(group) {
  return {
    id: `remote:${group.id}`, name: group.label || group.server,
    scope: group.target.workspace, roots: [], team: null, remote: true,
    server: group.server, registrationPresent: group.registrationPresent, group,
  };
}

/** The time a caller gives, or a TypeError when it gave none: this module reads no clock. `table` names
 * the function that was called without it (as client-terms.mjs `requireTerms` does for terms). */
function requireTime(at, table) {
  if (typeof at !== "string" || !at) throw new TypeError(`${table}: at must be the time of the call, a non-empty string`);
  return at;
}

/** A remote deployment's panel. `at` is the time the panel is made, an ISO string, and is required: the
 * caller holds the time of its call (panel-views.mjs passes `held.at`) and no clock is read here.
 *
 * A row is the host's row, spread whole, so a row with a `runtimeError` gets its speaker here
 * (`runtimeErrorOrigin`; instance-presentation.mjs names the three) and any other row gets none: a
 * `runtimeErrorOrigin` a host sent never survives, on any path. Which text it is decides:
 *
 *   a Herdr row                          "kernel" for the host's own reason, no key for the stand-in
 *   a reached server                     the host's row text: "kernel" (a host's OATS, relayed)
 *   a server not reached, an error the   "kernel": the mark of kernel-made.mjs, set where the roster's
 *     installed CLI printed                answer is parsed (cli-adapter.mjs `cliRemoteRoster`)
 *   a server not reached, any other      "roster-read": written while the roster was read (a read
 *     error, or none ("Server is           that threw, a timeout, an answer that is not the contract's)
 *     unreachable")
 *
 * No code and no message is read to decide it. The mark is on the error object: a group is held and
 * passed back as it was answered (`remoteRosterState`), and a copy of its `probe.error` reads as
 * "roster-read", never as the kernel's. */
export function remotePanel(group, at) {
  requireTime(at, "remotePanel");
  const ws = remoteWorkspace(group);
  // A row's soul subtitle: its own group's soul list only, a string as the host reported it, never synthesized.
  const described = name => { const soul = (group.souls || []).find((a) => a?.name === name); return typeof soul?.description === "string" ? soul.description : null; };
  // A Herdr-recorded row is unsupported whatever the host's probe said: it cannot open or start.
  const instances = (group.instances || []).map(({ runtime: _released, runtimeErrorOrigin: _sent, retire: sentRetire, sameWork: sentSameWork,
    sameWorkKnown: _gate, pinned: sentPinned, board: sentBoard, ...i }) => {
    const unsupported = unsupportedSession(i);
    const origin = unsupported ? unsupportedSessionOrigin(i) : group.probe.ok || (group.probe.error?.message && madeByKernel(group.probe.error)) ? "kernel" : "roster-read";
    const row = {
      ...i, server: group.server, savedRoute: i.savedRoute === true,
      // The last roster read of this server failed: its rows are last-known, their state unknown.
      serverUnreached: !group.probe.ok,
      home: i.home, agentsRoot: i.agentsRoot || group.agentsRoot,
      workspace: group.target.workspace, repoName: group.label || group.server,
      harness: harnessOf({ runtime: _released, ...i }) || null, model: i.model || null, description: described(i.agent),
      running: group.probe.ok ? i.running : null,
      runtimeError: group.probe.ok ? i.runtimeError : group.probe.error?.message || "Server is unreachable",
      tmux: i.tmux || null, git: i.git || null, task: i.task || "", next: i.next || "",
      // Needs input: only a remote kernel with the feature reports it — validated, never synthesized when absent.
      ...(Object.hasOwn(i, "waitingOnYou") ? { waitingOnYou: waitingOnYouData(i.waitingOnYou) } : {}),
      // The owning human (feature spawn-attribution): the host's label validated again here (attributed-human.mjs),
      // a malformed one null; a host that does not report it leaves it absent.
      ...(Object.hasOwn(i, "attributedHuman") ? { attributedHuman: attributedHumanData(i.attributedHuman) } : {}),
      // #1247: the host's retire state, relayed unchanged when it is in the contract (retire-state.mjs), else absent.
      ...(retireData(sentRetire) ? { retire: retireData(sentRetire) } : {}),
      // #1577: the host's same-work flag, true only (anything else reads unflagged). `sameWorkKnown` is this
      // client's own field (same-work.mjs), never a host's: whatever a host sent under it is dropped.
      ...(sentSameWork === true ? { sameWork: true } : {}),
      // Feature instance-pin: the host's pin, true only (anything else reads unpinned; instance-tree.mjs rowPinned),
      // and only from a host whose own feature list names it (composed-gate.mjs hostAdvertises: the group's
      // probe.features, which a CLI with server-probe-features relays). The kernel relays a row's pinned whatever
      // its host lists, so a stray field from an older host, or an unknown list, never pins a row here.
      ...(sentPinned === true && hostAdvertises(group, PIN_FEATURE) ? { pinned: true } : {}),
      // Feature instance-board: the agent's facts and questions (instance-board.mjs), validated again here, and only
      // from a host whose own feature list names it, as the pin is; anything else leaves the row with no board field,
      // so its tab is today's terminal. `null`: the host has the feature and the home has no board.
      ...(sentBoard !== undefined && hostAdvertises(group, BOARD_FEATURE) ? { board: boardData(sentBoard) } : {}),
      ...(unsupported ? { running: null, runtimeState: "unsupported", runtimeError: unsupported } : {}),
    };
    return hasRuntimeError(row) && origin ? { ...row, runtimeErrorOrigin: origin } : row;
  });
  return {
    workspace: { id: ws.id, name: ws.name, scope: ws.scope, team: null, server: ws.server,
      remote: true, registrationPresent: ws.registrationPresent === true },
    team: null, generatedAt: at,
    running: instances.filter((i) => i.running).length, instances,
    error: group.probe.ok ? null : group.probe.error?.message || "Server is unreachable",
  };
}

export function remoteAgents(group) {
  if (!group.registrationPresent || !group.probe.ok) return [];
  return (group.souls || []).map(({ runtime: _released, ...a }) => ({
    ...a, server: group.server, remote: true,
    agentsRoot: a.agentsRoot || group.agentsRoot,
    workspace: group.target.workspace, repoName: group.label || group.server,
    // The reported default harness only (a pre-0.27 host's `runtime` is read as it); never a guessed pi.
    harness: harnessOf({ runtime: _released, ...a }) || null, backend: a.backend || "tmux", work: a.work || "checkout",
    kind: a.kind || "persistent", description: a.description || "",
  }));
}

export function unavailableGroups(groups, error) {
  return groups.map((g) => ({ ...g, probe: { ok: false, error }, instances: (g.instances || []).map((i) => ({ ...i, running: null })) }));
}

/** The roster read's failure in words, and as the error an unavailable group carries. */
const ROSTER_UNAVAILABLE = "Remote roster unavailable";
const rosterError = (message) => ({ code: "E_REMOTE_ROSTER", message });

/**
 * What one outcome of `oats server roster --json` makes of the roster a client holds. No state: the
 * client keeps the three values between reads and passes them back as `previous`.
 *
 *   previous: { remoteGroups, rosterAnswered, rosterFailure }
 *   outcome:  { gated: true }     no accepted CLI, or one that does not read other machines
 *                                 (panel-views.mjs `cliReadsRemotes`): the read was not made
 *           | { envelope, asked? } what the CLI answered (cli-adapter.mjs `cliRemoteRoster`); `asked`
 *                                 when the read passed workspace keys (#1124): { keys, keyOf }
 *           | { thrown: string }  the read failed: the message of what was thrown
 *   at:       the caller's time, the one `remotePanel` stamps
 *   ->        { remoteGroups, rosterAnswered, rosterFailure, reported, kept? }
 *
 * `remoteGroups` is the last readable roster: an answer replaces it only when every group of it can be
 * projected (`remotePanel`), and a failed read keeps the groups held, each marked not reached
 * (`unavailableGroups`). `rosterAnswered` says an answer arrived; `rosterFailure` is the failure's
 * sentence, kept only while none has. `reported` is what the client hands to its memory of identities
 * (remote-identity-memory.mjs `observeIdentities`): the groups of an `ok` envelope, else null.
 *
 * An answer read with workspace keys (`asked`) holds only the groups the kernel probed: those registered
 * for one of `keys`, those of unknown workspace and those known only from saved routes. It replaces
 * those. A held registered group it does not list, and whose last-known key (`keyOf(group)`:
 * `lastKnownKey`) is one the read did not ask for, was not probed: it is kept as it was last read, after the answer's
 * groups, and named in `kept` (its id, in order), so the caller keeps its read time (`keptReadTimes`).
 * A held group whose key is unknown, or is one of `keys`, or that is known only from saved routes
 * (`registrationPresent` false: the kernel always probes those), and that the answer does not list is
 * gone, as after any answer. `reported` then holds the kept groups too, so the memory keeps their identities.
 *
 * The sentence of a thrown read carries the message of an error from outside the client: a client
 * shows it through `displayLine` (display-text.mjs) only.
 *
 * What stays the caller's: one read at a time, when it runs, and dropping an answer that was read
 * with a kernel record that is no longer the accepted one. And its own `try`/`catch` around the read
 * and around what it does with `reported`: if that step throws after the caller took the new state, the
 * caller takes `{ thrown: <message> }` next, so the groups it just took are marked not reached.
 */
export function remoteRosterState(previous, outcome, at) {
  requireTime(at, "remoteRosterState");
  if (outcome.gated) return { remoteGroups: [], rosterAnswered: false, rosterFailure: previous.rosterFailure, reported: null };
  /** A read with no answer to keep: the groups held, marked; the sentence only while no answer has ever arrived. */
  const failed = (message) => ({
    remoteGroups: unavailableGroups(previous.remoteGroups, rosterError(message)), rosterAnswered: previous.rosterAnswered,
    rosterFailure: previous.rosterAnswered ? previous.rosterFailure : message, reported: null,
  });
  if (!Object.hasOwn(outcome, "envelope")) return failed(`${ROSTER_UNAVAILABLE}: ${outcome.thrown}`);
  try {
    const env = outcome.envelope;
    const incoming = env.ok && Array.isArray(env.result?.groups)
      ? env.result.groups : unavailableGroups(previous.remoteGroups, env.error || rosterError(ROSTER_UNAVAILABLE));
    for (const group of incoming) remotePanel(group, at); // validate before replacing the last readable roster
    if (env.ok && outcome.asked) {
      const listed = new Set(incoming.map((g) => g?.id)), keys = [...outcome.asked.keys];
      // Only a registered group can be outside the read: one known only from saved routes is always probed.
      const kept = previous.remoteGroups.filter((g) => {
        if (listed.has(g.id) || g.registrationPresent !== true) return false;
        const key = outcome.asked.keyOf(g);
        return key !== null && !keys.some((asked) => sameRepo(asked, key));
      });
      const groups = [...incoming, ...kept];
      return { remoteGroups: groups, rosterAnswered: true, rosterFailure: null, reported: groups, kept: kept.map((g) => g.id) };
    }
    if (env.ok) return { remoteGroups: incoming, rosterAnswered: true, rosterFailure: null, reported: incoming };
    return { remoteGroups: incoming, rosterAnswered: previous.rosterAnswered,
      rosterFailure: previous.rosterAnswered ? previous.rosterFailure : env.error?.message || ROSTER_UNAVAILABLE, reported: null };
  } catch (e) {
    // An answer that cannot be read, or a group of it that cannot be projected: as a read that threw.
    return failed(`${ROSTER_UNAVAILABLE}: ${e.message}`);
  }
}

/** The panel of each group, keyed as a client's snapshot keys it: [[`remote:<group id>`, panel], …], every one made at `at`,
 * except a group kept from an earlier read (`readAt`, a Map of group id → its read time: `keptReadTimes`), which is
 * stamped with the time it was read: a read that did not probe it never makes it look newer. */
export function remotePanelEntries(remoteGroups, at, readAt = null) {
  requireTime(at, "remotePanelEntries");
  return remoteGroups.map((group) => { const panel = remotePanel(group, readAt?.get(group.id) ?? at); return [panel.workspace.id, panel]; });
}

/** The workspace key a held group was last known by (#1124): the key its last reached read reported,
 * else the one remembered for it (`remembered.get`, remote-identity-memory.mjs `identityMemory`), else
 * null: unknown. Any reported key counts, member-derived included: a registration records the key the
 * host reports, whatever its `keyFrom`. */
export function lastKnownKey(group, remembered) {
  const reported = group?.probe?.ok === true ? readIdentity(group.workspace) : { status: "none" };
  if (reported.status === "identity") return typeof reported.identity.key === "string" ? reported.identity.key : null;
  const key = remembered?.get(group?.id)?.workspace?.key;
  return typeof key === "string" ? key : null;
}

/** The read time of each kept group after one outcome (#1124): `times` is the Map held before it,
 * `state` what `remoteRosterState` answered, `answeredAt` the time of the answer before this one (when a
 * group first kept was last read). Only an answer changes it: a kept group keeps its time, or takes
 * `answeredAt` when it was read by that answer; a group read now has none. A failed read, which marks
 * every held group not reached, changes nothing; a gated one holds no group. */
export function keptReadTimes(times, state, answeredAt) {
  if (!state.reported) return state.remoteGroups.length ? times : new Map();
  return new Map((state.kept || []).map((id) => [id, times.get(id) ?? answeredAt]));
}

export function spawnedWorkspace(groups, result) {
  if (!result.server || !result.target) return undefined;
  const group = groups.find((g) => g.server === result.server && g.registrationPresent
    && g.target.sshHost === result.target.sshHost && g.target.workspace === result.target.workspace);
  return group ? remoteWorkspace(group).id : undefined;
}
