/** Presentation of the existing /api/panel roster, not an activity/Git resolver. */
import { instanceId, distinguishingRootTags } from '../../client/instance-tree.mjs';
import { eventsTimestamp } from '../../client/instance-events-contract.mjs';
import { canAddressRemote } from '../../client/remote-address.mjs';
import { knownOrigin, hasRuntimeError, instanceColor } from '../../client/instance-presentation.mjs';
import { keptFailure } from '../../client/deployment-facts.mjs';
import { retireData } from '../../client/retire-state.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
const soulText = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\0\n\r]/.test(value);
const identityFields = ['home', 'agentsRoot', 'server'];
const displayed = ['agent', 'repoName', 'harness', 'branch', 'model', 'backend']; // model/backend preserve existing Start/Restart handoffs
const reported = ['runtimeState', 'runtimeError']; // the kernel's unsupported state and its reason, shown on disabled controls

export function projectActivePanel(panel) {
  if (!object(panel) || !Array.isArray(panel.instances)) throw new Error('The server did not report a roster.');
  if (panel.workspace != null && (!object(panel.workspace) || typeof panel.workspace.id !== 'string')) throw new Error('The roster did not report a valid workspace identity.');
  if (panel.error != null && typeof panel.error !== 'string') throw new Error('The server reported an unreadable roster error.');
  // A kept failure (the last read failed, the rows are the last observation): the shared home's one rule,
  // never a test of the message. Its rows' state is unknown.
  const kept = keptFailure(panel);
  const seen = new Set();
  const instances = panel.instances.map(raw => {
    if (!object(raw) || typeof raw.instance !== 'string' || !raw.instance) throw new Error('The roster contains an invalid instance identity.');
    for (const key of identityFields) if (raw[key] != null && (typeof raw[key] !== 'string' || raw[key].includes('\0'))) throw new Error('The roster contains an invalid instance address.');
    const instance = { instance: raw.instance, running: kept ? null : raw.running === true ? true : raw.running === false ? false : null,
      remote: raw.remote === true || panel.workspace?.remote === true,
      // addressable stays absent when this computer's OATS (before 0.31) reports none: the saved route then decides.
      ...(typeof raw.addressable === 'boolean' ? { addressable: raw.addressable } : {}), savedRoute: raw.savedRoute === true,
      missingRemotely: raw.missingRemotely === true, serverUnreached: raw.serverUnreached === true,
      createdAt: eventsTimestamp(raw.createdAt) ? raw.createdAt : null };
    // #802: the kernel's hold on the home (a spawn setting up its worktree, a home left half cleaned), as /api/panel
    // forwards it (true only): instance-tree.mjs heldHome gates the canvas's actions on it.
    for (const key of ['spawnInProgress', 'rollbackIncomplete', 'retirePending']) if (raw[key] === true) instance[key] = true;
    // #1247: the retire's state as /api/panel forwards it, read again (a value out of the contract is absent).
    const retire = retireData(raw.retire);
    if (retire) instance.retire = retire;
    for (const key of [...identityFields, ...displayed, ...reported]) instance[key] = text(raw[key]);
    // Who made the row's runtimeError, as /api/panel forwards it: only beside that text as it was reported (a
    // non-empty string), and only one of the three speakers (packages/client/instance-presentation.mjs). The
    // backend is where the mark is made and guarded.
    if (hasRuntimeError(raw) && knownOrigin(raw.runtimeErrorOrigin)) instance.runtimeErrorOrigin = raw.runtimeErrorOrigin;
    for (const key of ['parentInstance', 'siblingInstance']) instance[key] = typeof raw[key] === 'string' ? raw[key] : '';
    // #1421 §2: the instance's colour, a palette name only (instanceColor), for the canvas's dot; in the signature, so a change redraws.
    const color = instanceColor(raw);
    if (color) instance.color = color;
    // #1579: the row's own background flag, exactly true, for the sidebar's Background section; in the signature, so a change redraws.
    if (raw.background === true) instance.background = true;
    // Feature instance-pin: the row's own pin, exactly true, for the roster's order and the pin mark; in the signature, so a change redraws.
    if (raw.pinned === true) instance.pinned = true;
    // The exact soul the instance records (Go to soul): its soul key (string, or null when none is recorded) and
    // its soul source's repoKey, each kept only as a well-formed string, never guessed from the agent name.
    if (raw.soulKey === null || soulText(raw.soulKey)) instance.soulKey = raw.soulKey;
    if (object(raw.soul) && soulText(raw.soul.repoKey)) instance.soul = { repoKey: raw.soul.repoKey };
    const id = instanceId(instance);
    if (seen.has(id)) throw new Error('The roster contains duplicate instance identities; actions are unavailable.');
    seen.add(id);
    // TASK/STATE/transcript text, PR guesses, aggregate git stats, and any
    // unnegotiated activity/group-name fields are intentionally not consumed.
    return instance;
  });
  instances.sort((a, b) => instanceId(a).localeCompare(instanceId(b)));
  return { instances, workspace: object(panel.workspace) ? panel.workspace : null,
    workspaces: Array.isArray(panel.workspaces) ? panel.workspaces.filter(w => object(w) && typeof w.id === 'string') : [],
    // `error` is the kept failure's message as a string (possibly empty), or null when none is kept;
    // `errorOrigin` who made it, "kernel" or absent (packages/client/deployment-facts.mjs `keptFailure`).
    generatedAt: text(panel.generatedAt), error: kept ? kept.message : null, ...(kept?.origin ? { errorOrigin: kept.origin } : {}) };
}

export function activeSignature(panel) {
  // Time and unrelated metadata must not destroy a focused popup on each poll.
  return JSON.stringify([panel.workspace?.id, panel.workspace?.server, panel.workspace?.remote, panel.instances]);
}

export function canAddressInstance(instance) {
  if (!instance) return false;
  const absolute = value => typeof value === 'string' && value.startsWith('/') && !value.includes('\0');
  if (instance.home && !absolute(instance.home)) return false; // never fall back from a malformed primary address
  if (instance.agentsRoot && !absolute(instance.agentsRoot)) return false;
  return !!(absolute(instance.home) || absolute(instance.agentsRoot))
    && (!(instance.remote || instance.server) || (typeof instance.server === 'string' && !!instance.server && canAddressRemote(instance)));
}

/** Display-only disambiguation, never a grouping key or a filesystem target. */
export function activeTargetLabel(instance, roster) {
  const twins = roster.filter(row => row.instance === instance.instance);
  const host = instance.server || (instance.remote ? 'host unknown' : 'local');
  if (twins.length < 2) return instance.server || instance.remote ? `@${host}` : '';
  const onHost = twins.filter(row => (row.server || '') === (instance.server || ''));
  const sameRoot = onHost.filter(row => row.agentsRoot === instance.agentsRoot);
  const scopes = sameRoot.length > 1 ? sameRoot.map(row => row.home) : onHost.map(row => row.agentsRoot || row.home);
  const scope = sameRoot.length > 1 ? instance.home : instance.agentsRoot || instance.home;
  const tag = distinguishingRootTags(scopes).get(scope) || scope || 'address unknown';
  return `${host} · ${tag}`;
}
