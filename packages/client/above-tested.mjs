/* What a client still does with an oats CLI above its tested bound (oats-project/oats#1879, option 3).

   The locator accepts a released CLI of a later minor or major than the client's own release and flags it
   `aboveTested` (cli-locator.mjs acceptProbe). This module names every operation that stays on then, each
   with its reason, and DENIES EVERYTHING ELSE: an operation not named here, an operation added later
   included, is held back until the Desktop is updated. A new operation is opened above the bound only by
   adding it here, with a reason (the decision's condition 1).

   Why these and not others: the four traced cases on #1879 (schedule edit at 0.40, Remove at 0.49 and
   0.53, the Stop outcome at 0.52) all sit where the Desktop words a consequence itself or writes a whole
   definition. What stays on is a read, a terminal, or a change fenced by the kernel's own answer: Spawn
   applies only the decision its preview showed (`--expect-decision`), and Start, Restart, colour and
   background report only an answer the Desktop reads in full (each fails closed on a shape it does not
   know).

   Enforcement is not the renderer's. Every place an operation enters the backend asks
   `aboveTestedRefusal(cli, operation)` before any CLI process starts: each POST handler of
   packages/desktop/server/oats-web.mjs by (route, action), and each caller in main that runs the CLI for
   an effect (packages/desktop/main.mjs, session-resume-launch.mjs). The renderer reads the same table to
   disable what would be refused, and never decides by itself.

   An operation is a string: `POST <route> <action>` for an HTTP entry whose body names an action (the
   action is the body's `action`, or `<kind>:<action>` for /api/automations), `POST <route>` for one that has
   none, and `main <what>` for an entry outside HTTP. packages/desktop/test/above-tested-inventory.test.mjs
   holds every POST route the server accepts, and every module that executes a command, to a class here.

   Pure data; no node: imports, so the renderer shares it with the server. */
import { aboveTestedNotice, desktopReleaseUrl } from './above-tested-notice.mjs';

/** The refusal's code: the Desktop's own, never the kernel's. */
export const ABOVE_TESTED_CODE = 'cli-above-tested';

/** The reads that stay on, as a named set: every operation of class `read` is one of them. */
export const READS = Object.freeze({
  status: 'the deployment observation (`oats status`, `oats workspace status`, the souls and capabilities catalogs)',
  roster: 'the remote roster and the machines list',
  inspect: 'what a soul, an instance or a capability is (`oats inspect`, `oats capabilities show`, the launch configurations)',
  readiness: '`oats readiness`',
  events: "an instance's events",
  git: "an instance's Git state and diffs, and the forge reads beside them (they run gh, never oats)",
  preview: 'the spawn and launch previews',
  version: 'the `version --json` probe itself',
  'warm reader': 'the warm `oats reader --stdio` the background reads go through',
});

const read = (name) => Object.freeze({ class: 'read', reason: READS[name], read: name });
const allowed = (reason) => Object.freeze({ class: 'allowed', reason });
const held = (reason) => Object.freeze({ class: 'held', reason });

const HELD_WRITE = 'it writes something an older Desktop may word or shape wrongly for a newer kernel';

/** Every operation, by its name (see the header for the form). Anything not here is held back. */
export const OPERATIONS = Object.freeze({
  // ── Spawn: the preview the apply is bound to, and the apply that the kernel fences.
  'POST /api/spawn prepare': allowed('Spawn: prepares the apply from the preview it is bound to'),
  'POST /api/spawn apply': allowed('Spawn: applies only the decision its preview showed (--expect-decision); a drift is E_DECISION_STALE'),
  'POST /api/spawn result': read('preview'),
  'POST /api/spawn execution-server': held('an execution-server spawn is not fenced by --expect-decision'),
  'POST /api/workspace-spawn-preview preview': allowed('Spawn: the preview, a read'),
  'POST /api/workspace-spawn-preview suggest': allowed('Spawn: a suggested task, a read'),
  'POST /api/workspace-spawn-preview suggest-name': allowed('Spawn: a suggested name, a read'),
  // ── Start and Restart: an answer the Desktop reads in full, nothing worded by the Desktop.
  'POST /api/start': allowed('Start: the kernel starts the session and answers what it started'),
  'POST /api/restart': allowed('Restart: the kernel restarts the session and answers what it started'),
  // ── An instance's own record.
  'POST /api/instance-color': allowed("colour: one field of the instance's own record, the answer read in full"),
  'POST /api/instance-background': allowed("background: one field of the instance's own record, the answer read in full"),
  // ── Reads.
  'POST /api/instance-git git': read('git'),
  'POST /api/instance-git diff': read('git'),
  'POST /api/instance-events read': read('events'),
  'POST /api/workspace-readiness read': read('readiness'),
  'POST /api/capabilities inspect': read('inspect'),
  'POST /api/capabilities show': read('inspect'),
  'POST /api/capabilities file': read('inspect'),
  'POST /api/workspace-sync read': read('status'),
  'POST /api/launch-configs list': read('inspect'),
  'POST /api/launch-configs preview': read('preview'),
  'POST /api/workspace-teams list': read('inspect'),
  'POST /api/workspace-soul-teams show': read('inspect'),
  'POST /api/automations trigger:list': read('status'),
  'POST /api/automations trigger:status': read('status'),
  'POST /api/automations schedule:list': read('status'),
  'POST /api/forge-connections': read('git'),
  'POST /api/instance-forge': read('git'),
  'POST /api/forge-roster': read('git'),
  'POST /api/instance-review-threads preview': read('git'),
  'POST /api/models': read('preview'),
  'POST /api/cli/reprobe': read('version'),
  'POST /api/remote-roster/refresh': read('roster'),
  'POST /api/window-state': read('status'),
  'POST /api/windows': read('roster'),
  'main deployments list': read('status'),
  // ── Terminals.
  'POST /api/instance-review-threads send': allowed("terminals: pastes the review threads into the agent's own terminal, as typing there does"),
  'main terminal attach': allowed('terminals: attaches to a session the kernel names'),
  'main terminal viewer': allowed('terminals: a linked, locked viewer of a session'),
  'main terminal upload': allowed("terminals: files attached to the agent's own terminal, as a paste there does"),
  // ── Held back: named so their reason is on record; anything unnamed is held back too.
  'POST /api/instance-lifecycle plan': held('Stop and Remove: the dialog words what the kernel will do (the 0.49, 0.52 and 0.53 cases on #1879)'),
  'POST /api/instance-lifecycle apply': held('Stop and Remove: the dialog words what the kernel will do (the 0.49, 0.52 and 0.53 cases on #1879)'),
  'POST /api/retire': held('Remove'),
  'POST /api/schedules': held('a schedule write replaces a whole definition (the 0.40 case on #1879)'),
  'POST /api/automations schedule:enable': held(HELD_WRITE),
  'POST /api/automations schedule:disable': held(HELD_WRITE),
  'POST /api/automations schedule:test': held('runs the schedule'),
  'POST /api/automations schedule:run': held('runs the schedule'),
  'POST /api/automations schedule:reconcile': held(HELD_WRITE),
  'POST /api/automations schedule:describe': held("writes the schedule's description"),
  'POST /api/automations trigger:enable': held(HELD_WRITE),
  'POST /api/automations trigger:disable': held(HELD_WRITE),
  'POST /api/automations trigger:test': held('runs the trigger'),
  'POST /api/automations trigger:describe': held("writes the trigger's description"),
  'POST /api/workspace-sync sync': held('writes the lock'),
  'POST /api/capabilities run': held('runs a provider operation'),
  'POST /api/workspace-teams add': held(HELD_WRITE),
  'POST /api/workspace-teams remove': held(HELD_WRITE),
  'POST /api/workspace-teams default': held(HELD_WRITE),
  'POST /api/workspace-soul-teams add': held(HELD_WRITE),
  'POST /api/workspace-soul-teams remove': held(HELD_WRITE),
  'POST /api/workspace-soul-teams default': held(HELD_WRITE),
  'POST /api/workspace-soul-teams clear-default': held(HELD_WRITE),
  'POST /api/launch-configs set': held(HELD_WRITE),
  'POST /api/launch-configs remove': held(HELD_WRITE),
  'POST /api/server-connect': held('connects a machine (and messaging) for the workspace'),
  'POST /api/server-check': held('server check'),
  'POST /api/server-remove': held('removes a machine'),
  'POST /api/server-forget': held("forgets a remote row's saved route"),
  'main session-resume': held('the launch sweep starts sessions the Desktop did not ask for'),
  'main deployments add': held("writes this computer's deployments list"),
  'main deployments import': held("writes this computer's deployments list"),
  'main deployments remove': held("writes this computer's deployments list"),
  'main workspace onboard': held('creates a deployment'),
});

/** Every module under packages/client/, packages/desktop/ and packages/desktop/server/ that starts a process,
 * by the class of the most that it runs: a module that can run a held-back operation is `held`, and its
 * reason says where that operation is refused. The inventory test finds such modules by what their code
 * names (child_process, execFile, an injected exec, spawn or probe); an unclassified one fails it. */
export const CLI_MODULES = Object.freeze({
  'packages/client/cli-adapter.mjs': held('every verb the backend runs; each is refused where it enters, the POST handlers of oats-web.mjs'),
  'packages/client/cli-locator.mjs': read('version'),
  'packages/client/deployment-list-cli.mjs': held("its add, import and remove write this computer's deployments list; refused in main (main deployments …)"),
  'packages/client/deployment-read-cli.mjs': read('status'),
  'packages/client/file-output-exec.mjs': held('the runner of the session resume sweep, refused in session-resume-launch.mjs (main session-resume)'),
  'packages/client/lifecycle-cli.mjs': held('Stop and Remove; refused at POST /api/instance-lifecycle'),
  'packages/client/session-attach.mjs': allowed('terminals: attach'),
  'packages/client/session-resume-cli.mjs': held('the session resume sweep; refused in session-resume-launch.mjs (main session-resume)'),
  'packages/client/spawn-apply-cli.mjs': allowed('Spawn apply, fenced by --expect-decision'),
  'packages/client/spawn-preview-cli.mjs': allowed('Spawn preview, a read'),
  'packages/client/terminal-exec.mjs': allowed('terminals: the run of an attach'),
  'packages/client/tmux-status.mjs': read('status'),
  'packages/client/warm-reader.mjs': read('warm reader'),
  'packages/client/workspace-cli.mjs': held('its sync and onboard write; refused at POST /api/workspace-sync sync and in main (main workspace onboard)'),
  'packages/desktop/forge-cli.mjs': read('git'),
  'packages/desktop/instance-events-cli.mjs': read('events'),
  'packages/desktop/local-tmux-io.mjs': allowed('terminals: the local tmux the viewers run on'),
  'packages/desktop/login-path.mjs': read('version'),
  'packages/desktop/main.mjs': held('runs the deployments list, onboard and the resume sweep; each refused where main calls it'),
  'packages/desktop/readiness-cli.mjs': read('readiness'),
  'packages/desktop/terminal-attachments.mjs': allowed("terminals: files attached to an agent's terminal (main terminal upload)"),
  'packages/desktop/terminal-io.mjs': allowed('terminals: the terminal broker'),
  'packages/desktop/server/oats-web.mjs': held('the POST handlers, each refused by (route, action) before it runs anything'),
  'packages/desktop/server/review-paste.mjs': allowed("terminals: the paste into the agent's own terminal"),
});

/** The operation's name, as OPERATIONS keys it: `POST <route> <action>`, `POST <route>` when the entry has
 * no action. An action that is not a short printable word names no operation (held back). */
export function postOperation(route, action) {
  if (action === undefined) return `POST ${route}`;
  return `POST ${route} ${typeof action === 'string' && /^[a-z][a-z:-]{0,63}$/.test(action) ? action : '?'}`;
}

/** Whether `operation` stays on above the tested bound: a read, or allowed. False for anything else. */
export function permittedAboveTested(operation) {
  const entry = Object.hasOwn(OPERATIONS, operation) ? OPERATIONS[operation] : null;
  return entry?.class === 'read' || entry?.class === 'allowed';
}

/** The notice for an accepted CLI above the tested bound, or null when `cli` is not one: what the card's
 * place shows, and what every refusal carries. */
export function aboveTestedState(cli) {
  if (cli?.ok !== true || cli.aboveTested !== true || typeof cli.version !== 'string' || typeof cli.testedThrough !== 'string') return null;
  return { message: aboveTestedNotice({ cliVersion: cli.version, testedThrough: cli.testedThrough }), release: desktopReleaseUrl(cli.version), version: cli.version };
}

/** The one gate: null, or the refusal of `operation` while `cli` is above its tested bound, carrying the
 * notice sentence, the release to install and this module's own code. Called before any CLI process
 * starts. A CLI whose flag is set but whose record is incomplete is refused too: no notice is invented,
 * nothing runs. */
export function aboveTestedRefusal(cli, operation) {
  if (cli?.aboveTested !== true || permittedAboveTested(operation)) return null;
  const state = aboveTestedState(cli);
  return { code: ABOVE_TESTED_CODE, message: state?.message ?? 'This Desktop is older than the installed oats CLI: install the OATS Desktop of its version.',
    ...(state ? { release: state.release } : {}), operation };
}

/** The operation each roster act runs (instance-acts.mjs verbs): Stop and Remove open the lifecycle plan,
 * Start and Restart their own route. `inspect` and `open` are reads and terminals, and run none of these. */
export const ACT_OPERATIONS = Object.freeze({ start: 'POST /api/start', restart: 'POST /api/restart',
  stop: 'POST /api/instance-lifecycle plan', retire: 'POST /api/instance-lifecycle plan' });

/** A roster row's acts (instance-acts.mjs `instanceActs`) with each act held back above the tested bound made
 * not enabled, its reason the notice sentence (`{ code, sentence }`, as an act's reason is read). The same
 * answer otherwise. */
export function heldBackActs(offer, cli) {
  if (cli?.aboveTested !== true || !Array.isArray(offer?.acts)) return offer;
  return { ...offer, acts: offer.acts.map((act) => {
    const refused = Object.hasOwn(ACT_OPERATIONS, act.verb) ? aboveTestedRefusal(cli, ACT_OPERATIONS[act.verb]) : null;
    return refused && act.enabled ? { ...act, enabled: false, reason: { code: refused.code, sentence: refused.message } } : act;
  }) };
}
