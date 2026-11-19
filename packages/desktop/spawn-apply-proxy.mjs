/** Normalized spawn IPC, including ordinary legacy requests: frame/epoch custody
 * cannot be bypassed by an alias or by omitting the transaction discriminator. */
import { apiUrl, apiInit, requestPath } from './api-url.mjs';
import { trustedForgeFrame } from './forge-proxy.mjs';
import { record, absolute, NAMING_TIMEOUT_MS } from '../client/spawn-preview-contract.mjs';
import { spawnPrepareInput, spawnRefInput, spawnApplyView, spawnApplyFailure } from '../client/spawn-apply-contract.mjs';
export async function proxySpawnApply(event, pathname, opts, { rendererURL, connection, fetch: fetcher } = {}) {
  let frame, start, dispatched = false, mutation = false, legacy = false, input;
  const owns = () => { try { return trustedForgeFrame(event, rendererURL) && event.sender.mainFrame === frame; } catch { return false; } };
  const current = () => { try { const c = connection(); return !c.transition && c.epoch === start?.epoch; } catch { return false; } };
  const fail = (code, status = 503) => {
    const unknown = mutation && dispatched;
    const body = spawnApplyFailure(unknown ? 'E_OUTCOME_UNKNOWN' : code, { spawnRef: input?.spawnRef, status: unknown ? 'unknown' : 'unavailable' });
    return { ok: false, status, body: { ...body, code: body.reason.code, error: body.reason.message } };
  };
  try { frame = event?.senderFrame; } catch { return fail('E_FORBIDDEN_FRAME', 403); }
  if (!owns()) return fail('E_FORBIDDEN_FRAME', 403);
  try {
    if (opts?.method !== 'POST') return fail('E_BAD_ARGS', 400);
    const init = apiInit({ method: 'POST', body: opts.body });
    if (typeof init.body !== 'string' || Buffer.byteLength(init.body) > 65536) return fail('E_BAD_ARGS', 400);
    try { input = JSON.parse(init.body); } catch { return fail('E_BAD_ARGS', 400); }
    if (!record(input)) return fail('E_BAD_ARGS', 400);
    legacy = !Object.hasOwn(input, 'action');
    if (!legacy && !(input.action === 'prepare' ? spawnPrepareInput(input) : spawnRefInput(input))) return fail('E_BAD_ARGS', 400);
    mutation = legacy || input.action === 'apply';
    start = { ...connection() }; if (start.transition) return fail('E_PLAN_CHANGED');
    const url = apiUrl(pathname, start.wsId, start.allowedWs, { bound: start.bound === true });
    if (url.pathname !== '/api/spawn' || url.searchParams.getAll('ws').length > 1
      || [...url.searchParams.keys()].some(k => k !== 'ws') || !legacy && !url.searchParams.get('ws')) return fail('E_BAD_ARGS', 400);
    // A remote spawn the host names from its task (suggestName, #1490 §3) runs the kernel's naming call first: the CLI's
    // deadline grows by NAMING_TIMEOUT_MS (cli-adapter.mjs cliSpawn), and this one keeps its margin above it.
    const timeout = mutation ? 65000 + (legacy && input.suggestName === true ? NAMING_TIMEOUT_MS : 0) : input.action === 'prepare' ? 35000 : 10000;
    dispatched = true;
    const response = await fetcher(requestPath(url), { ...init, signal: AbortSignal.timeout(timeout) });
    const raw = await response.text();
    if (!owns()) return fail('E_FORBIDDEN_FRAME', 403);
    if (!current()) return fail('E_PLAN_CHANGED');
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 4 * 1024 * 1024) return fail('E_CLI_OUTPUT_LIMIT');
    let value; try { value = JSON.parse(raw); } catch { return fail('E_CLI_PROTOCOL'); }
    if (legacy) {
      // Existing remote/older-CLI response shape stays separate; no interpretation
      // as a confirmed receipt and no new flags/fallback generated here.
      if (!record(value) || (response.ok ? value.spawned !== true || typeof value.instance !== 'string' || !absolute(value.home)
        : typeof value.error !== 'string')) return fail('E_CLI_PROTOCOL');
      return { ok: response.ok, status: response.status, body: value };
    }
    const body = spawnApplyView(value, { workspace: url.searchParams.get('ws'), ref: input.spawnRef, selector: input.selector });
    if (!body) return fail('E_CLI_PROTOCOL');
    return { ok: response.ok, status: response.status, body: response.ok ? body : { ...body, code: body.reason?.code, error: body.reason?.message } };
  } catch { return !owns() ? fail('E_FORBIDDEN_FRAME', 403) : fail(current() ? 'E_CLI_FAILED' : 'E_PLAN_CHANGED'); }
}
