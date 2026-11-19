/** K6 read-only IPC. No fallback or mutation result handling. The reads that carry a task are the suggest read
 *  (`action: 'suggest'`, feature spawn-suggest-name, awebai/oats#1421 §3) and the suggest-name read (`action:
 *  'suggest-name'`, feature instance-suggest-name, #1490 §2: a name for a spawn on another machine, `{ workspace, data:
 *  { name?, naming } }` with no preview): their bodies may take the apply's 64 KiB, a preview's stays at 16 KiB, and the
 *  server checks both again (server/oats-web.mjs). */
import { apiUrl, apiInit, requestPath } from './api-url.mjs';
import { trustedForgeFrame } from './forge-proxy.mjs';
import { previewFailure, previewTarget, previewData, instanceSuggestion } from '../client/spawn-preview-contract.mjs';
export async function proxySpawnPreview(event, path, opts, { rendererURL, connection, fetch: fetcher } = {}) {
  const reply = (code, status = 503) => ({ ok: false, status, body: previewFailure(code) });
  let frame; try { frame = event?.senderFrame; } catch { return reply('E_FORBIDDEN_FRAME', 403); }
  const owns = () => { try { return trustedForgeFrame(event, rendererURL) && event.sender.mainFrame === frame; } catch { return false; } };
  if (!owns()) return reply('E_FORBIDDEN_FRAME', 403);
  let start;
  const current = () => { try { const c = connection(); return !c.transition && c.epoch === start?.epoch; } catch { return false; } };
  try {
    if (opts?.method !== 'POST') return reply('E_BAD_ARGS', 400);
    start = { ...connection() }; if (start.transition) return reply('E_TARGET_CHANGED');
    const url = apiUrl(path, start.wsId, start.allowedWs, { bound: start.bound === true });
    if (url.pathname !== '/api/workspace-spawn-preview') return reply('E_BAD_ARGS', 400);
    const init = apiInit({ method: 'POST', body: opts.body });
    // The largest body any read may have (a suggest read's 64 KiB) is refused before it is parsed; a parsed one that is
    // not a suggest read then keeps a preview's 16 KiB.
    if (typeof init.body !== 'string') return reply('E_BAD_ARGS', 400);
    const bytes = Buffer.byteLength(init.body);
    if (bytes > 65536) return reply('E_BAD_ARGS', 400);
    let action; try { action = JSON.parse(init.body)?.action; } catch { return reply('E_BAD_ARGS', 400); }
    const suggestName = action === 'suggest-name'; // feature instance-suggest-name (awebai/oats#1490 §2): a name, and no preview
    if (action !== 'suggest' && !suggestName && bytes > 16384) return reply('E_BAD_ARGS', 400);
    const response = await fetcher(requestPath(url), { ...init, signal: AbortSignal.timeout(35000) }), raw = await response.text();
    if (!owns()) return reply('E_FORBIDDEN_FRAME', 403);
    if (!current()) return reply('E_TARGET_CHANGED');
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 4 * 1024 * 1024) return reply('E_CLI_OUTPUT_LIMIT');
    let value; try { value = JSON.parse(raw); } catch { return reply('E_CLI_PROTOCOL'); }
    if (value?.spawnPreviewViewApi !== 1) return reply('E_CLI_PROTOCOL');
    // The kernel's refusal words (and a launch refusal's fix) travel to the dialog, re-validated here.
    if (value.status === 'unavailable') return { ok: response.ok, status: response.status, body: previewFailure(value.reason?.code, value.target, value.reason?.message, value.reason?.fix) };
    if (suggestName) {
      const data = instanceSuggestion(value.data);
      if (!response.ok || value.status !== 'available' || !data || value.workspace !== url.searchParams.get('ws')) return reply('E_CLI_PROTOCOL');
      return { ok: true, status: response.status, body: { spawnPreviewViewApi: 1, status: 'available', workspace: value.workspace, data, reason: null } };
    }
    const target = previewTarget(value.target), data = previewData(value.data, target);
    if (!response.ok || value.status !== 'available' || !data || target.workspace !== url.searchParams.get('ws')) return reply('E_CLI_PROTOCOL');
    return { ok: true, status: response.status, body: { spawnPreviewViewApi: 1, status: 'available', target, data, reason: null } };
  } catch { return !owns() ? reply('E_FORBIDDEN_FRAME', 403) : reply(current() ? 'E_CLI_FAILED' : 'E_TARGET_CHANGED'); }
}
