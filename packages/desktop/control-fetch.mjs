import { CONTROL_TOKEN_HEADER } from './control-request.mjs';
import { requireControlToken } from './control-token.mjs';

/** Main owns control headers and binding authorization; public version reads carry no token. */
export function createControlFetch(token, fetch = globalThis.fetch, { authorize = () => true } = {}) {
  requireControlToken(token);
  return (url, init = {}) => {
    const headers = new Headers(init.headers);
    const target = new URL(url);
    if ((init.method ?? 'GET') === 'GET' && target.pathname === '/api/version') {
      headers.delete(CONTROL_TOKEN_HEADER);
    } else {
      if (!authorize(target)) return Promise.reject(new Error('Desktop backend has not reported a live binding'));
      headers.set(CONTROL_TOKEN_HEADER, token);
    }
    return fetch(url, { ...init, headers, redirect: 'error' });
  };
}
