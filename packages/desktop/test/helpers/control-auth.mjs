// Explicit launch credentials for tests that exercise the Desktop control API.
export const TEST_CONTROL_TOKEN = 'desktop-test-control-token-32-characters';
export const controlHeaders = (headers = {}) => ({ 'x-oats-desktop-token': TEST_CONTROL_TOKEN, ...headers });
export function controlFetch(url, init = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has('x-oats-desktop-token')) headers.set('x-oats-desktop-token', TEST_CONTROL_TOKEN);
  return globalThis.fetch(url, { ...init, headers });
}
