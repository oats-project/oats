/** K7 read IPC: normalized route, trusted frame, copied connection ownership,
 * streaming response byte cap, and independent public DTO reprojection. */
import { apiUrl, apiInit, requestPath } from './api-url.mjs';
import { trustedForgeFrame } from './forge-proxy.mjs';
import { eventsRequest, eventsTarget, eventsFailure } from '../client/instance-events-contract.mjs';
import { eventsData } from './renderer/instance-events-data.mjs';
/** A read may be routed to a server (a 45 s CLI deadline): 50 s lets it report itself. */
export const EVENTS_PROXY_TIMEOUT = 50_000;
const MAX_BODY = 4 * 1024 * 1024;
async function boundedText(response) {
  if (!response.body) return '';
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw Object.assign(Error(), { code: 'E_CLI_PROTOCOL' });
      bytes += value.byteLength;
      if (bytes > MAX_BODY) {
        await reader.cancel();
        throw Object.assign(Error(), { code: 'E_CLI_OUTPUT_LIMIT' });
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, bytes).toString('utf8');
  } finally { reader.releaseLock(); }
}
export async function proxyInstanceEvents(event, path, opts, { rendererURL, connection, fetch: fetcher } = {}) {
  const reply = (code, status = 503) => ({ ok: false, status, body: eventsFailure(code) });
  let frame; try { frame = event?.senderFrame; } catch { return reply('E_FORBIDDEN_FRAME', 403); }
  const owns = () => { try { return trustedForgeFrame(event, rendererURL) && event.sender.mainFrame === frame; } catch { return false; } };
  if (!owns()) return reply('E_FORBIDDEN_FRAME', 403);
  let start;
  const current = () => { try { const c = connection(); return !c.transition && c.epoch === start?.epoch && c.wsId === start?.wsId; } catch { return false; } };
  try {
    if (opts?.method !== 'POST') return reply('E_BAD_ARGS', 400);
    start = { ...connection() }; if (start.transition) return reply('E_TARGET_CHANGED');
    let url, input, init;
    try {
      url = apiUrl(path, start.wsId, start.allowedWs, { bound: start.bound === true });
      if (url.pathname !== '/api/instance-events' || url.searchParams.getAll('ws').length !== 1 || !url.searchParams.get('ws')
        || [...url.searchParams.keys()].some(k => k !== 'ws')) return reply('E_BAD_ARGS', 400);
      init = apiInit({ method: 'POST', body: opts.body });
      if (typeof init.body !== 'string' || Buffer.byteLength(init.body) > 16384) return reply('E_BAD_ARGS', 400);
      input = eventsRequest(JSON.parse(init.body));
      if (!input) return reply('E_BAD_ARGS', 400);
    } catch { return reply('E_BAD_ARGS', 400); }
    const response = await fetcher(requestPath(url), { ...init, signal: AbortSignal.timeout(EVENTS_PROXY_TIMEOUT) });
    const raw = await boundedText(response);
    if (!owns()) return reply('E_FORBIDDEN_FRAME', 403);
    if (!current()) return reply('E_TARGET_CHANGED');
    let value; try { value = JSON.parse(raw); } catch { return reply('E_CLI_PROTOCOL'); }
    if (value?.instanceEventsViewApi !== 1) return reply('E_CLI_PROTOCOL');
    const target = eventsTarget(value.target);
    const same = target && target.workspace === url.searchParams.get('ws')
      && Object.keys(input.selector).every(k => target.selector[k] === input.selector[k]);
    if (value.target !== null && !same) return reply('E_CLI_PROTOCOL');
    if (value.status === 'unavailable') return { ok: response.ok, status: response.status, body: eventsFailure(value.reason?.code, target, value.reason) };
    const data = same && eventsData(value.data, target, input.limit, { publicView: true });
    if (!response.ok || value.status !== 'available' || !data) return reply('E_CLI_PROTOCOL');
    return { ok: true, status: response.status, body: { instanceEventsViewApi: 1, status: 'available', target, data, reason: null } };
  } catch (error) {
    if (!owns()) return reply('E_FORBIDDEN_FRAME', 403);
    if (!current()) return reply('E_TARGET_CHANGED');
    return reply(['E_CLI_OUTPUT_LIMIT', 'E_CLI_PROTOCOL'].includes(error?.code) ? error.code : error?.name === 'TimeoutError' ? 'E_CLI_TIMEOUT' : 'E_CLI_FAILED');
  }
}
