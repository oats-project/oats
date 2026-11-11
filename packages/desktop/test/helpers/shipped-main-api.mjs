// Main's shipped `api` IPC handler (main.mjs), run in a vm over fake I/O, for one sending window.
//   window      the workspace the window is bound to (its #ws=), or null for a window with none
//   chooser     the window is one main knows has no workspace to read (a New Window, a window left choosing)
//   holds(id)   does main bind the window to the workspace its hash names (main's holdsHash)? By default yes:
//               the hash and main's binding agree
//   advertised  what main last learned the server advertises; `reread` is what a re-read finds
//   served      main's served list (the switcher's choices)
//   reply(url)  the backend's answer to main's backendFetch of that request (a URL on a fixed origin, for its
//               path and search): { status, body }
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { withWindowGlobals } from './main-window-globals.mjs';
import { apiUrl, apiInit, classifyApiRoute, requestPath, servedSelectors } from '../../api-url.mjs';
import { workspaceHash } from '../../renderer/window-binding.mjs';
import { forgeProxyOptions, trustedForgeFrame, FORGE_EPOCH_HEADER } from '../../forge-proxy.mjs';
import { forgeFailure } from '../../renderer/forge-contract.mjs';
import { lifecycleFailure } from '../../../client/lifecycle-contract.mjs';
import { lifecycleFrameRefusal } from '../../renderer/lifecycle-frame.mjs';
import { DESKTOP_TERMS } from '../../renderer/desktop-terms.mjs';

export const RENDERER = 'file:///fixture/renderer/index.html';

/** The origin `fetched` URLs are read against: backendFetch takes a path, which this names as a URL. */
export const FETCHED_ORIGIN = 'http://oats-backend.invalid';

export function shippedMainApi({ window: bound, chooser = false, holds = (id) => id === bound, wsId = '/d/first', advertised, reread = null,
  served = [], reply = () => ({ status: 200, body: { workspaces: [] } }) }) {
  const source = readFileSync(new URL('../../main.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('ipcMain.handle("api",'), end = source.indexOf('// ---- IPC: workstation forge auth', start);
  let handler; const fetched = [], calls = { rereads: 0 };
  const backendFetch = async (path) => {
    if (typeof path !== 'string' || !path.startsWith('/api/')) throw new Error(`backendFetch takes a path: ${path}`);
    const u = new URL(path, FETCHED_ORIGIN); fetched.push(u);
    const r = reply(u);
    return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body) };
  };
  const proxy = (_event, path, _opts, d) => {
    if (d?.fetch !== backendFetch) throw new Error('a proxy is handed main\'s backendFetch');
    fetched.push(new URL(path, FETCHED_ORIGIN)); return { ok: true, status: 200, body: {} };
  };
  const sendingWindow = {};
  const context = withWindowGlobals({
    ipcMain: { handle: (_name, fn) => { handler = fn; } }, apiUrl, apiInit, classifyApiRoute, requestPath, servedSelectors, forgeProxyOptions, trustedForgeFrame,
    FORGE_EPOCH_HEADER, forgeFailure, lifecycleFailure, lifecycleFrameRefusal, DESKTOP_TERMS, RENDERER_URL: RENDERER, serverEpoch: 0, unservedRefusal: () => null,
    serverHost: { inTransition: () => false }, currentForgeEpoch: () => 'fixture:0', wsId, allowedWs: advertised, servedList: served,
    // The re-read of the advertised set (main's panelWorkspaces): `reread` is what the server advertises now.
    panelWorkspaces: async () => { calls.rereads++; if (reread) context.allowedWs = reread; return context.servedList; },
    BrowserWindow: { fromWebContents: () => sendingWindow }, choosers: new Set(chooser ? [sendingWindow] : []),
    holdsHash: (win, id) => { calls.holds = [...(calls.holds ?? []), id]; return win === sendingWindow && holds(id); },
    proxyReadiness: proxy, proxySpawnPreview: proxy, proxyInstanceEvents: proxy, proxySpawnApply: proxy,
    backendFetch, AbortSignal: { timeout: () => null }, Set, URL, JSON,
    guard: () => {},
  });
  runInNewContext(source.slice(start, end), context);
  const frame = { url: bound ? `${RENDERER}${workspaceHash(bound)}` : RENDERER };
  const event = { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false } };
  return { fetched, calls, context, call: (path, opts = { method: 'POST', body: '{}' }) => handler(event, path, opts) };
}
