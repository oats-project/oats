/** The inspect boundary: one soul's or one instance home's inspection (`oats inspect --json`), through the
 * kernel's resolver, never a client's copy. A client makes one and asks it:
 *
 *   createInspectBoundary({ invoke, cache, maxAge, exec }) -> { inspect(request, context) }
 *
 *   invoke   the CLI call (cli-adapter.mjs `cliCapability`, the default)
 *   cache    an inspect cache the client made (inspect-cache.mjs `createInspectCache`); null: every inspect
 *            reaches the CLI
 *   maxAge   seconds the kernel may reuse remote observations on a miss (a local inspect only)
 *   exec     how the CLI is run (cli-adapter.mjs `runJson`'s `io.exec`); without it, execFile
 *
 *   request  { action: 'inspect', selector: { soul, agentsRoot } | { home }, refresh?, instructions?, skills?, composedSkills?, board? }
 *   context  { workspace, cli, agents, instances, localCwd, catalogKey }
 *
 * It resolves the kernel's result with `observedAt` and `refreshing`, and throws an Error with a stable `code`
 * (and, for a host's refusal, a `reason`; for a refusal whose details name team labels, those `labels`).
 *
 * The boundary HOLDS NOTHING: what it keeps between calls is the cache it is given, which the client owns. A
 * client may make one boundary and keep it (the TUI: its own exec and cache) or make one per call (the
 * Desktop's capabilities.mjs, with the backend's cache): both are the same boundary only while that holds.
 * Never add a field, a map or a flight here; put it in the cache, or in a factory the client owns.
 *
 * The admission (`capabilityAdmission`: which workspace, which CLI, which action and flags, which one soul or
 * home) and the refusal of a failed answer (`capabilityFailure`) are this module's too, and the Desktop's
 * provider operations (capabilities.mjs, `run`) call the same two: a request is admitted one way, whatever it asks. */
import { dirname } from 'node:path';
import { cliCapability, operationArgs } from './cli-adapter.mjs';
import { inspectKey } from './inspect-cache.mjs';
import { observationData } from './deployment-data.mjs';
import { OBSERVE_MAX_AGE_FEATURE } from './deployment-contract.mjs';
import { hostComposes, hostReportsSkills, hostComposesSkills, hostAdvertises, PROBE_FEATURES_FEATURE } from './composed-gate.mjs';
import { BOARD_FEATURE } from './instance-board.mjs';
import { canAddressRemote, unaddressableSentence, hostReason, shownLabel, unroutableReason } from './remote-address.mjs';

const fail = (message, code = 'E_BAD_ARGS') => { throw Object.assign(new Error(message), { code }); };

const TEAM_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Admit a capability request in its context, or throw. `actions`: the actions the caller serves (an inspect
 * boundary serves only 'inspect'); any other is the same refusal as an unknown one. Returns what the call needs:
 * `{ action, server, label, refresh, instructions, skills, composedSkills, board, soul, agentsRoot, home, context, key }`, where
 * `context` is the --dir the CLI runs in and `key` the inspect cache's key for the subject. */
export function capabilityAdmission(request, { workspace, cli, agents = [], instances = [], catalogKey = null }, actions = ['inspect', 'run']) {
  if (!workspace) fail('Select a known workspace', 'E_WORKSPACE_UNKNOWN');
  // The probe integer is the gate (operationsApi 2: inspect on the workspace model).
  if (!cli?.ok || cli.operationsApi !== 2) {
    fail('Update the installed OATS CLI (inspection needs operations API 2)', 'cli-no-operations');
  }
  const server = workspace.server || undefined;
  // A remote workspace's refusals carry a structured reason (remote-address.mjs) naming the server.
  const label = workspace.name || server;
  if (workspace.remote && (!server || !workspace.registrationPresent || !cli.remote?.includes('operations'))) {
    const error = Object.assign(new Error('This workspace needs a registered server and remote operations support'), { code: 'cli-no-operations' });
    // This computer's OATS can't route inspection to a registered server: nothing was sent.
    if (server && workspace.registrationPresent) error.reason = unroutableReason(label);
    throw error;
  }
  const { action, selector = {} } = request;
  // Read-only plus provider operations: a v2 soul is edited in its repository,
  // and workspace model v2 removed `oats use` (capabilities are declared).
  if (!actions.includes(action)) fail('Unknown capability action');
  // Declared operation arguments only travel with a run (the kernel refuses undeclared ones).
  if (request.args !== undefined && (action !== 'run' || !operationArgs(request.args))) fail('Invalid operation arguments');
  // refresh (bypass the cached observation) is an inspect concern only.
  if (request.refresh !== undefined && (action !== 'inspect' || typeof request.refresh !== 'boolean')) fail('Invalid refresh flag');
  const refresh = request.refresh === true;
  // instructions (feature soul-composed-instructions): a soul's composed AGENTS.md, inspect of a soul only. The
  // adapter sends it only to a CLI whose probe advertises it. Routed, it travels only when this client's roster row
  // for the workspace says the host composes (composed-gate.mjs: the host's own probe.features, relayed by a CLI with
  // server-probe-features); otherwise it is dropped and the read is today's. The renderer's ask is never the proof.
  if (request.instructions !== undefined && (action !== 'inspect' || typeof request.instructions !== 'boolean' || selector.soul === undefined)) fail('Invalid instructions flag');
  const instructions = request.instructions === true && (!server || hostComposes(cli, workspace.group));
  // skills (feature soul-skills): a soul's own skills (`souls[0].skills`), inspect of a soul only, gated the same way:
  // the adapter sends it only to a CLI that advertises it, and routed only when the held roster row says the host
  // reports them (composed-gate.mjs hostReportsSkills); otherwise it is dropped and the read is today's.
  if (request.skills !== undefined && (action !== 'inspect' || typeof request.skills !== 'boolean' || selector.soul === undefined)) fail('Invalid skills flag');
  const skills = request.skills === true && (!server || hostReportsSkills(cli, workspace.group));
  // composedSkills (feature soul-composed-skills): every skill a spawn gives the instance (`souls[0].composedSkills`),
  // the same way again: inspect of a soul only; routed only when the held row says the host lists them (hostComposesSkills).
  if (request.composedSkills !== undefined && (action !== 'inspect' || typeof request.composedSkills !== 'boolean' || selector.soul === undefined)) fail('Invalid composed skills flag');
  const composedSkills = request.composedSkills === true && (!server || hostComposesSkills(cli, workspace.group));
  // board (feature instance-board): the agent's board with each fact's history and each question's context
  // (`inspect --home --board`), inspect of a home only, read-only. Sent only to a CLI that advertises the feature;
  // routed only when the held roster row says the host has it too (its own probe.features, relayed by a CLI with
  // server-probe-features); otherwise it is dropped and the read is today's, which carries no history.
  if (request.board !== undefined && (action !== 'inspect' || typeof request.board !== 'boolean' || selector.home === undefined)) fail('Invalid board flag');
  const has = feature => !!cli?.ok && Array.isArray(cli.features) && cli.features.includes(feature);
  const board = request.board === true && has(BOARD_FEATURE) && (!server || (has(PROBE_FEATURES_FEATURE) && hostAdvertises(workspace.group, BOARD_FEATURE)));
  let soul, agentsRoot, home, key;
  let context = workspace.scope;
  if (selector.home !== undefined) {
    if (selector.soul !== undefined || selector.agentsRoot !== undefined || selector.context !== undefined) fail('Select a soul or an instance home');
    const matches = instances.filter(i => i.home === selector.home);
    if (matches.length !== 1) fail('Select one existing home in this workspace');
    const instance = matches[0];
    if (server && !canAddressRemote(instance)) fail(unaddressableSentence({ ...instance, repoName: workspace.name || server }), 'E_SNAPSHOT_UNKNOWN');
    home = instance.home;
    // The owning agents root and the recorded work repository may differ.
    // --home is authoritative; the CLI derives its captured context.
    context = undefined;
    // Identity coordinates: a restarted or re-spawned seat under the same home is another subject.
    key = inspectKey({ deployment: workspace.scope, server, kind: 'home', home, instance: instance.instance,
      identity: [instance.createdAt, instance.startedAt, instance.soul, instance.modules], board });
  } else if (selector.soul !== undefined) {
    const matches = agents.filter(a => a.name === selector.soul && a.agentsRoot === selector.agentsRoot);
    if (matches.length !== 1) fail('Select one soul and its agents root in this workspace');
    const agent = matches[0];
    soul = agent.name; agentsRoot = agent.agentsRoot;
    context = dirname(agentsRoot);
    key = inspectKey({ deployment: workspace.scope, server, kind: 'soul', soul, agentsRoot, catalogKey, instructions, skills, composedSkills });
  } else fail('Select a soul or an instance home (inspection has no scope subject)');
  return { action, server, label, refresh, instructions, skills, composedSkills, board, soul, agentsRoot, home, context, key };
}

/** The CLI call's options for an admitted request (cli-adapter.mjs `cliCapability`). */
export function capabilityCall(request, { action, server, refresh, instructions, skills, composedSkills, board, soul, agentsRoot, home, context }, { workspace, cli, localCwd, maxAge }) {
  return {
    action, context, server, soul, agentsRoot, home,
    operation: request.operation, ...(request.args !== undefined ? { args: request.args } : {}), ...(instructions ? { instructions } : {}),
    ...(skills ? { skills } : {}), ...(composedSkills ? { composedSkills } : {}), ...(board ? { board } : {}),
    localCwd: server ? localCwd : context || workspace.scope,
    // --max-age travels only on a LOCAL inspect (reuse is local only: the kernel refuses it with --server)
    // and only when the probe declared observe-max-age (the adapter's call).
    ...(action === 'inspect' && !server && (refresh || maxAge !== undefined) ? { maxAge: refresh ? 0 : maxAge } : {}),
    features: cli.features,
  };
}

/** The Error a failed answer is thrown as, for an admitted request's `server` and `label`. */
export function capabilityFailure(envelope, { server, label }) {
  const code = envelope.error?.code || 'E_OPERATION_FAILED';
  const error = Object.assign(new Error(envelope.error?.message || 'Capability operation failed'), { code });
  // A host's (or the remote transport's) refusal: its code verbatim, a headline naming the server and the
  // kernel's message through the display filter (hostReason; null for a code not in the kernel's shape).
  const reason = server ? hostReason({ code, message: envelope.error?.message }, label, `${shownLabel(label, true)} refused this request.`) : null;
  if (reason) error.reason = reason;
  // The team labels a refusal's details name (the teams contract's conflict, sent by kernels before 0.30) travel
  // with it, bounded: 2 to 16, each a team label. Which codes a client reads them for is the client's own.
  const labels = envelope.error?.details?.labels;
  if (Array.isArray(labels) && labels.length >= 2 && labels.length <= 16
    && labels.every(l => typeof l === 'string' && TEAM_LABEL.test(l))) error.labels = [...labels];
  return error;
}

export function createInspectBoundary({ invoke = cliCapability, cache = null, maxAge, exec } = {}) {
  const io = exec ? { exec } : {};
  return {
    async inspect(request, context) {
      const { workspace, cli, localCwd } = context;
      const admitted = capabilityAdmission(request, context, ['inspect']);
      const { server, refresh, key, board } = admitted;
      const call = () => invoke(cli.bin, capabilityCall(request, admitted, { workspace, cli, localCwd, maxAge }), io);
      let envelope, observedAt, refreshing = false;
      if (cache) {
        // A remote workspace has no state key and no invalidation signal here: its inspections are shared
        // between concurrent requests but never served from an earlier visit (store: false).
        // Live (observes the remotes afresh): a refresh, a routed inspect (reuse is local only, so it never carries
        // --max-age), or any read on a kernel without the feature. A refresh joins only a live flight.
        const live = refresh || !!server || !(Array.isArray(cli.features) && cli.features.includes(OBSERVE_MAX_AGE_FEATURE));
        // A board read is never stored: its facts change while the view is open, and the view reads it on a change.
        ({ envelope, observedAt, refreshing } = await cache.read(key, { deployment: workspace.scope, refresh, produce: call, store: !server && !board, live }));
      } else {
        envelope = await call();
        if (envelope.ok) observedAt = observationData(envelope).observedAt ?? new Date().toISOString();
      }
      if (!envelope.ok) throw capabilityFailure(envelope, admitted);
      return { ...envelope.result, observedAt, refreshing };
    },
  };
}
