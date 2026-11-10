/** POST /api/workspace-sync — the Desktop's workspace-v2 sync surface.
 *   { action: "read", refresh? } → `oats capabilities` (the catalog table)
 *   { action: "sync" }           → `oats sync` (resolve, fetch and write the lock)
 * A read answers from the capability catalog (packages/client/capability-catalog.mjs)
 * when one is given and the deployment's workspace status is already
 * observed: the held table comes back at once, with `observedAt` (when the
 * kernel observed the remotes) and `refreshing` (a re-read is running behind
 * it); refresh:true forces a live kernel read. Without a catalog, or before
 * the first observation, the read goes straight to the kernel as before.
 * Results RESOLVE with a stable shape; nothing here re-derives kernel logic.
 * There is no package approval: declaring a package in `packages:` is the
 * trust decision (packages-no-approval). */
import { cliWorkspace, workspaceGate, workspaceFailure } from '../../client/workspace-cli.mjs';
import { syncData, capabilitiesData, observationData } from '../../client/deployment-data.mjs';
import { DESKTOP_TERMS } from '../renderer/desktop-terms.mjs';

export const WORKSPACE_SYNC_API = 1;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const MESSAGES = {
  E_WORKSPACE_UNKNOWN: 'Select a registered local deployment.',
  E_SYNC_BUSY: 'A sync is already running for this deployment. Wait for it to finish.',
  E_BAD_ARGS: 'The workspace request was not valid.',
};
export function syncFailure(code, status = 'unavailable', message) {
  return { workspaceSyncApi: WORKSPACE_SYNC_API, status, report: null, capabilities: null,
    reason: { code, message: message || MESSAGES[code] || workspaceFailure(code, DESKTOP_TERMS).reason.message } };
}
/** A kernel error envelope (its own E_* code), as opposed to a Desktop-side
 * transport/probe failure from workspace-cli.mjs. */
const LOCAL_CODES = new Set(['E_CLI_UNAVAILABLE', 'E_WORKSPACE_FEATURE', 'E_CLI_FAILED', 'E_CLI_PROTOCOL', 'E_CLI_TIMEOUT', 'E_CLI_OUTPUT_LIMIT']);
const kernelRefusal = result => typeof result?.reason?.code === 'string' && !LOCAL_CODES.has(result.reason.code)
  && typeof result.reason.message === 'string';
const cliStamp = cli => JSON.stringify([cli?.bin ?? null, cli?.version ?? null]);

/** The kernel's stamp (a malformed one is no stamp), else the read's completion time. */
const observedStamp = (document, now) => observationData(document).observedAt ?? new Date(now()).toISOString();

/** `catalog` is a capability catalog; `observed(deployment)` yields that
 * deployment's projected workspace status (the catalog key) or null; `maxAge`
 * (seconds) is what a non-forced miss may accept from the kernel's cache. */
export function createWorkspaceSyncBoundary({ invoke = (cli, options) => cliWorkspace(cli, options, DESKTOP_TERMS), catalog = null, observed = () => null, maxAge, now = () => Date.now() } = {}) {
  const running = new Set();              // deployments with a sync in flight
  const reads = new Map();                // stamp → pending catalog read (coalesced)

  function context(workspace, cli) {
    if (!workspace || workspace.remote || workspace.server || typeof workspace.scope !== 'string') return { failure: syncFailure('E_WORKSPACE_UNKNOWN') };
    const gate = workspaceGate(cli, DESKTOP_TERMS);
    if (gate) return { failure: syncFailure(gate.reason.code) };
    return { deployment: workspace.scope, cli: { ok: true, bin: cli.bin, version: cli.version, workspaceApi: cli.workspaceApi, features: [...cli.features] } };
  }
  function refusal(result) {
    return { workspaceSyncApi: WORKSPACE_SYNC_API, status: 'refused', report: null, capabilities: null, reason: result.reason };
  }
  async function heldRead(ctx, workspaceStatus, refresh) {
    const entry = await catalog.read(ctx.deployment, ctx.cli, workspaceStatus, refresh ? { refresh: true } : maxAge !== undefined ? { maxAge } : {});
    const refreshing = entry?.refreshing ?? false;
    if (entry?.capabilities && !entry.reason) return { workspaceSyncApi: WORKSPACE_SYNC_API, status: 'ok', report: null, capabilities: entry.capabilities, reason: null, observedAt: entry.observedAt, refreshing };
    // The latest read failed: today's failure shape (the renderer shows the error and Retry, exactly as before), with the
    // last good table beside it for a renderer that can label a stale table — additive, never mistaken for a healthy one.
    const reason = entry?.reason || { code: 'E_CLI_FAILED', message: '', kernel: false };
    const failure = reason.kernel ? refusal({ reason: { code: reason.code, message: reason.message } }) : syncFailure(reason.code);
    return { ...failure, observedAt: null, refreshing, lastGood: entry?.capabilities ? { capabilities: entry.capabilities, observedAt: entry.observedAt } : null };
  }
  async function read(ctx, refresh) {
    const workspaceStatus = catalog ? observed(ctx.deployment) : null;
    if (catalog && workspaceStatus) return heldRead(ctx, workspaceStatus, refresh);
    const key = JSON.stringify([ctx.deployment, cliStamp(ctx.cli)]);
    if (!reads.has(key)) {
      const options = { action: 'capabilities', context: ctx.deployment, ...(refresh ? { maxAge: 0 } : maxAge !== undefined ? { maxAge } : {}) };
      reads.set(key, Promise.resolve().then(() => invoke(ctx.cli, options))
        .then(result => {
          if (!result?.ok) return { ...(kernelRefusal(result) ? refusal(result) : syncFailure(result?.reason?.code || 'E_CLI_FAILED')), observedAt: null, refreshing: false };
          try { return { workspaceSyncApi: WORKSPACE_SYNC_API, status: 'ok', report: null, capabilities: capabilitiesData(result.document), reason: null, observedAt: observedStamp(result.document, now), refreshing: false }; }
          catch { return { ...syncFailure('E_CLI_PROTOCOL'), observedAt: null, refreshing: false }; }
        }, () => ({ ...syncFailure('E_CLI_FAILED'), observedAt: null, refreshing: false }))
        .finally(() => reads.delete(key)));
    }
    return structuredClone(await reads.get(key));
  }
  async function mutate(ctx, options) {
    if (running.has(ctx.deployment)) return syncFailure('E_SYNC_BUSY', 'busy');
    running.add(ctx.deployment);
    try {
      let result;
      try { result = await invoke(ctx.cli, options); } catch { result = workspaceFailure('E_CLI_FAILED', DESKTOP_TERMS); }
      // The kernel refused (integrity, drift, discovery…): its code/message verbatim, and the case it names (why).
      if (!result?.ok) return kernelRefusal(result) ? refusal(result) : syncFailure(result?.reason?.code || 'E_CLI_FAILED');
      let report;
      try { report = syncData(result.document, ctx.deployment); } catch { return syncFailure('E_CLI_PROTOCOL'); }
      catalog?.forget(ctx.deployment); // the lock moved: the held table is for the old state
      return { workspaceSyncApi: WORKSPACE_SYNC_API, status: 'ok', report, capabilities: null, reason: null };
    } finally { running.delete(ctx.deployment); }
  }
  return async function workspaceSyncRequest(request, { workspace, cli } = {}) {
    if (!record(request) || !['read', 'sync'].includes(request.action)) return syncFailure('E_BAD_ARGS');
    const allowed = request.action === 'read' ? ['action', 'refresh'] : ['action'];
    if (Object.keys(request).some(key => !allowed.includes(key))) return syncFailure('E_BAD_ARGS');
    if (Object.hasOwn(request, 'refresh') && typeof request.refresh !== 'boolean') return syncFailure('E_BAD_ARGS');
    const ctx = context(workspace, cli);
    if (ctx.failure) return ctx.failure;
    if (request.action === 'read') return read(ctx, request.refresh === true);
    return mutate(ctx, { action: 'sync', context: ctx.deployment });
  };
}
