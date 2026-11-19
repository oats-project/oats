/** Which acts a roster row offers, decided from the kernel's row alone. A client draws its menu, its
 * keys or its buttons from this answer: verbs and reasons, never a label, an icon or a key.
 *
 *   instanceActs(instance) -> { blocked: Reason | null, limited: Reason | null, acts: Act[] }
 *   Act    = { verb, enabled, reason: Reason | null, secondary? }
 *   Reason = { code, sentence } and, by code:
 *     { code: 'unaddressable', key, sentence, origin? }   key: the row reason's own (remote-address.mjs rowReason)
 *     { code: 'held', kind, sentence, origin? }           kind: instance-tree.mjs HELD_HOMES's: 'spawning' |
 *                                                         'spawn-incomplete' | 'retiring' | 'retire-failed' | 'retire-incomplete'
 *     { code: 'unsupported-session', sentence, origin? }
 *     { code: 'not-running', sentence }                   an `open` act's only (`openAct`)
 *     { code: 'state-unknown', sentence }                 an `open` act's only
 *     { code: 'no-terminal', sentence, link? }            an `open` act's only: the row runs on a session provider
 *                                                         link: { label, url }, what the provider offers instead
 *
 * A client may switch on `code`, and on `key` or `kind` when it needs to; never on the sentence.
 * The sentences are the ones the shared tables already produce. Two of them can be text this home did
 * not write (an unaddressable row's `runtimeError`, the kernel's reason for a removed session backend): a
 * client shows a sentence only through display-text.mjs `displayLine`.
 *
 * `origin` is there exactly when the sentence is not this home's own (the rule of `rowReason`, whose
 * answer's `origin` is passed on as it is, never decided again here): "kernel", "terminal-probe" or
 * "roster-read" when the row names the speaker of its `runtimeError`, "unattributed" when the row's text
 * stands beside no speaker. It is absent on a sentence this home wrote and on the stand-in for an older
 * kernel's Herdr row. A `held` reason has one ("kernel") only for a failed retire whose row carries the
 * kernel's message or code (#1247, instance-tree.mjs heldHome `said`). A client shows a sentence with an `origin`
 * through its display filter, after instance-presentation.mjs `originLead`'s words when the value names
 * a speaker, and a sentence with none as written, as this home's own.
 *
 * `blocked`: the row offers nothing, and this is why; `acts` is then empty.
 * `limited`: the row offers fewer acts than a home normally does, and this is why. It is about the
 * row, not about one act: **a client adds none of its own acts to a limited row.**
 * `blocked` and `limited` are never both set. An act's own `reason` says why that one act is listed
 * and not enabled; the others stay as they are.
 *
 * `secondary: true` (#1247; absent otherwise): the act stays listed and enabled, behind its usual
 * confirmation, but it is not the row's default or primary affordance. A client keeps it where the row's
 * acts are listed (the Desktop's row menu, the TUI's key) and draws no inline primary control for it,
 * never makes it the default act (the menu's first focus, a key's default) and does not advertise it
 * (the TUI's footer). Only Retire on a retiring row is secondary: a second retire is safe (the kernel
 * refuses it while one runs: E_INSTANCE_RETIRING, E_LIFECYCLE_BUSY) and, while the holder can't be read,
 * may be the only way on.
 *
 * In order, the first that applies:
 *   a remote row the kernel does not report addressable   blocked (unaddressable); no acts
 *   a home the kernel holds, spawning                     blocked (held); no acts
 *   a home the kernel holds, retiring                     limited (held); retire (secondary)
 *   a home the kernel holds, spawn incomplete,            limited (held); retire
 *     retire failed or incomplete
 *   a session backend OATS no longer has                  inspect, start (not enabled, unsupported-session), stop, retire
 *   running === true                                      inspect, restart, stop, retire
 *   running === false                                     inspect, start, stop, retire
 *   running unknown                                       inspect, stop, retire
 * A row on a session provider (instance-presentation.mjs `sessionProvider`: "bb", say) is offered by the
 * same last three lines, from the `running` the kernel reports for it: the kernel starts, stops and retires
 * it through its provider.
 *
 *   openAct(instance) -> { verb: 'open', enabled, reason: Reason | null } | null
 *
 * Whether the row's terminal can be opened, and why not. It is not one of `acts`: it is read from
 * `instanceActs`'s answer, and of the row only from whether it runs on a session provider, so the order
 * above is written once.
 *   blocked or limited is set       null: the row's own reason says why, and a client adds no act
 *   a Herdr-recorded row            not enabled, with Start's own reason (unsupported-session), as below
 *   a row on a session provider     not enabled (no-terminal), whatever its state: it has no terminal.
 *                                   The sentence names where the agent runs ("Runs in a bb thread; open it
 *                                   in bb."), this home's own, built from the provider's name. `link` is
 *                                   the row's `open` (`openLink`: `{ label, url }`, an http(s) url), there
 *                                   only for a row of this machine that carries one: another machine's url
 *                                   is its own loopback. A client may show `link` as an external link (the
 *                                   label through `displayLine`); none attaches, splits or opens a
 *                                   terminal for the row, and none restores a remembered tab for it.
 *   restart is listed, enabled      enabled: the row runs
 *   start is listed, enabled        not enabled (not-running)
 *   start is listed, not enabled    not enabled, with that act's own reason (unsupported-session)
 *   neither is listed               not enabled (state-unknown)
 * A client's own condition for opening a terminal (a recorded session on this machine, say) is the
 * client's, and is not here.
 */
import { heldHome } from './instance-tree.mjs';
import { unsupportedSession, sessionProvider, openLink } from './instance-presentation.mjs';
import { canAddressRemote, rowReason } from './remote-address.mjs';

const act = (verb, reason = null, secondary = false) => ({ verb, enabled: !reason, reason, ...(secondary ? { secondary: true } : {}) });
// An `open` act's own two codes, and the one sentence both carry.
const NOT_RUNNING = 'not-running', STATE_UNKNOWN = 'state-unknown', NO_TERMINAL = 'no-terminal';
const NO_LIVE_TERMINAL = 'No live terminal is reported.';

export function instanceActs(instance) {
  if (!canAddressRemote(instance)) {
    const { key, sentence, origin } = rowReason(instance);
    return { blocked: { code: 'unaddressable', key, sentence, ...(origin !== undefined ? { origin } : {}) }, limited: null, acts: [] };
  }
  // #802: a home the kernel holds starts, stops and opens nothing. Retire only when a spawn or a retire left it
  // half cleaned (the kernel's retire completes it), nothing while its spawn sets up the worktree; while a
  // retire runs (#1247), Retire stays reachable but secondary.
  const held = heldHome(instance);
  if (held) {
    const { sentence, origin } = held.said;
    const reason = { code: 'held', kind: held.kind, sentence, ...(origin !== undefined ? { origin } : {}) };
    return held.retire ? { blocked: null, limited: reason, acts: [act('retire', null, held.retire === 'secondary')] }
      : { blocked: reason, limited: null, acts: [] };
  }
  // A Herdr-recorded row cannot start or restart: Start stays listed, not enabled, with the kernel's reason.
  // Its sentence and its `origin` are the row reason's own (rowReason answers this reason first for such a row).
  const herdr = unsupportedSession(instance) ? rowReason(instance) : null;
  const launch = herdr ? [act('start', { code: 'unsupported-session', sentence: herdr.sentence, ...(herdr.origin !== undefined ? { origin: herdr.origin } : {}) })]
    : instance.running === true ? [act('restart')] : instance.running === false ? [act('start')] : [];
  return { blocked: null, limited: null, acts: [act('inspect'), ...launch, act('stop'), act('retire')] };
}

export function openAct(instance) {
  const { blocked, limited, acts } = instanceActs(instance);
  if (blocked || limited) return null;
  // A session provider's row has no terminal in any state. After the held and unaddressable rows, whose own
  // reason stands; a Herdr-recorded row is no provider's (`sessionProvider`) and keeps Start's reason below.
  const provider = sessionProvider(instance);
  if (provider) {
    const link = instance.server ? null : openLink(instance);
    return act('open', { code: NO_TERMINAL, sentence: `Runs in a ${provider} thread; open it in ${provider}.`, ...(link ? { link } : {}) });
  }
  const restart = acts.find(({ verb }) => verb === 'restart'), start = acts.find(({ verb }) => verb === 'start');
  if (restart?.enabled) return act('open');
  if (start?.enabled) return act('open', { code: NOT_RUNNING, sentence: NO_LIVE_TERMINAL });
  if (start) return act('open', start.reason);
  return act('open', { code: STATE_UNKNOWN, sentence: NO_LIVE_TERMINAL });
}
