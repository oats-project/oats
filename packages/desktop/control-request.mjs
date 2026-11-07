import { timingSafeEqual } from 'node:crypto';

export const CONTROL_TOKEN_HEADER = 'x-oats-desktop-token';

export function controlTokenMatches(given, token) {
  if (typeof given !== 'string' || typeof token !== 'string' || token.length < 32) return false;
  const actual = Buffer.from(given), expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Preserve repeated headers as arrays so the shared guard refuses them. */
export function controlRequestHeaders(req) {
  if (!req.headersDistinct) return req.headers;
  return Object.fromEntries(Object.entries(req.headersDistinct).map(([key, values]) =>
    [key, values.length === 1 ? values[0] : values]));
}

/** The existing loopback Host policy, shared by HTTP and unsupported upgrades. */
export function loopbackHost(headers) {
  const host = String(headers.host || '').replace(/:\d+$/, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

/** Host has already passed the server's loopback check. No body or route work precedes this. */
export function checkControlRequest({ method, path, headers }, token) {
  const forbidden = { ok: false, status: 403, error: 'forbidden' };
  const origin = headers.origin;
  if (origin !== undefined && (typeof origin !== 'string' || origin !== `http://${headers.host}`)) return forbidden;
  if (method === 'GET' && path === '/api/version') return { ok: true };
  return controlTokenMatches(headers[CONTROL_TOKEN_HEADER], token) ? { ok: true } : forbidden;
}
