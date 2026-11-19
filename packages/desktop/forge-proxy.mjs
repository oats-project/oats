import { apiInit } from './api-url.mjs';
import { forgeReason } from './renderer/forge-contract.mjs';
import { trustedRendererUrl } from './renderer/window-binding.mjs';
export const FORGE_EPOCH_HEADER = 'x-oats-forge-epoch';
export const validForgeEpoch = v => typeof v === 'string' && /^[a-zA-Z0-9:-]{1,96}$/.test(v);
export function forgeProxyOptions(path, opts, epoch) {
  const init = apiInit(opts);
  const headers = Object.fromEntries(Object.entries(init.headers || {}).filter(([key]) => key.toLowerCase() !== FORGE_EPOCH_HEADER));
  headers[FORGE_EPOCH_HEADER] = epoch;
  return { init: { ...init, headers }, timeout: ['/api/instance-forge', '/api/instance-review-threads'].includes(path) ? 50_000 : 25_000 };
}
export function installForgeAuthHandlers({ ipc, broker, rendererUrl, wireOwner = () => {} }) {
  const methods = { 'forge:connect': ['connect', 1], 'forge:disconnect': ['disconnect', 1],
    'forge:auth-key': ['key', 2], 'forge:auth-resize': ['resize', 3], 'forge:auth-close': ['close', 1] };
  for (const [channel, [method, count]] of Object.entries(methods)) ipc.handle(channel, async (event, ...args) => {
    const denied = () => ({ ok: false, reason: forgeReason('E_FORBIDDEN_FRAME') });
    if (!trustedForgeFrame(event, rendererUrl)) return denied();
    if (args.length !== count) return { ok: false, reason: forgeReason('E_BAD_ARGS') };
    const frame = event.senderFrame;
    const current = () => trustedForgeFrame(event, rendererUrl) && event.sender.mainFrame === frame;
    wireOwner(event.sender);
    try {
      const result = await broker[method](event.sender, ...args);
      return current() ? result : denied();
    } catch { return current() ? { ok: false, reason: forgeReason('E_GH_FAILED') } : denied(); }
  });
}
export function trustedForgeFrame(event, rendererUrl) {
  try {
    const frame = event?.senderFrame, sender = event?.sender;
    return !!frame && !!sender && !sender.isDestroyed() && frame === sender.mainFrame
      && trustedRendererUrl(frame.url, rendererUrl);
  } catch { return false; } // detached Electron frame accessors can throw
}
