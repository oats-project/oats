import { CONTROL_TOKEN_HEADER } from './control-request.mjs';
import { requireControlToken } from './control-token.mjs';

/** Main owns the header; callers and pages cannot replace it or redirect it elsewhere. */
export function createControlFetch(token, fetch = globalThis.fetch) {
  requireControlToken(token);
  return (url, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set(CONTROL_TOKEN_HEADER, token);
    return fetch(url, { ...init, headers, redirect: 'error' });
  };
}
