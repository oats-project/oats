// Inventory checks (source scans, beside the behavioural tests in backend-request-checks,
// backend-startup-checks and backend-client): nothing in main or the modules it wires reaches the
// backend except through backend-client.mjs's backendFetch, and no renderer path reopens a
// loopback port.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(DESKTOP, rel), 'utf8');
/** The source without comments (string and regular-expression literals kept: a URL in a string is
 * code). A `/` after an operator, an opening bracket, a keyword or the start of a line begins a
 * regular expression, which is copied to its closing `/`. Enough for this repository's sources. */
function code(text) {
  let out = '', i = 0;
  const regexAllowed = () => {
    const before = out.replace(/\s+$/, '');
    return before === '' || /[(,=:[!&|?{};+\-*%<>~^]$/.test(before) || /(?:^|[^\w$])(?:return|typeof|case|in|of|void|delete|throw)$/.test(before);
  };
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 2; continue; }
    if (c === '/' && regexAllowed()) {
      let j = i + 1, inClass = false;
      while (j < text.length && text[j] !== '\n' && (inClass || text[j] !== '/')) {
        if (text[j] === '\\') j++;
        else if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        j++;
      }
      out += text.slice(i, j + 1); i = j + 1; continue;
    }
    out += c; i++;
  }
  return out;
}
const WIRED = ['main.mjs', 'readiness-proxy.mjs', 'spawn-preview-proxy.mjs', 'instance-events-proxy.mjs', 'spawn-apply-proxy.mjs',
  'terminal-io.mjs', 'workspace-registry.mjs', 'window-activity.mjs', 'forge-proxy.mjs', 'server-host.mjs', 'api-url.mjs'];

test('A9: no fetch of the backend outside backend-client.mjs in main and the modules it wires, aliases included', () => {
  for (const file of WIRED) {
    const src = code(read(file));
    // Every use of the name `fetch` in code is one of: main's `backend.fetch` (the client's own function),
    // an option key whose value is backendFetch (main passing it) or `fetcher` with no default (a module receiving it).
    for (const m of src.matchAll(/(?<![\w$])fetch(?![\w$])/g)) {
      const before = src.slice(Math.max(0, m.index - 12), m.index), after = src.slice(m.index + 5, m.index + 40);
      const allowed = (file === 'main.mjs' && /backend\.$/.test(before) && /^\s*;/.test(after))
        || (file === 'main.mjs' && /^\s*:\s*backendFetch\b/.test(after))
        || (file !== 'main.mjs' && /^\s*:\s*fetcher\s*[,}]/.test(after) && !/^\s*:\s*fetcher\s*=/.test(after));
      assert.ok(allowed, `${file}: \`${before}fetch${after.split('\n')[0]}\` reaches the network other than through backendFetch`);
    }
    assert.doesNotMatch(src, /globalThis\s*\.\s*fetch|\bXMLHttpRequest\b|\bnew\s+WebSocket\b|\bnew\s+EventSource\b/, file);
    assert.doesNotMatch(src, /["'`]https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])/, `${file}: no loopback URL`);
    assert.doesNotMatch(src, /from\s+["']node:(?:http|https|net)["']/, `${file}: no transport of its own`);
  }
  // Each module that takes a fetcher is handed main's backendFetch, and main never passes any other.
  const main = code(read('main.mjs'));
  for (const m of main.matchAll(/(?<![\w$.])fetch\s*:\s*([\w$.]+)/g)) assert.equal(m[1], 'backendFetch', m[0]);
  for (const name of ['proxySpawnApply', 'proxySpawnPreview', 'proxyInstanceEvents', 'proxyReadiness', 'createTerminalIo']) {
    const calls = [...main.matchAll(new RegExp(`${name}\\(([^;]*)`, 'g'))].filter((c) => !/^import/.test(c[0]));
    assert.ok(calls.length >= 1, name);
    for (const c of calls) assert.match(c[1], /fetch:\s*backendFetch/, `${name} is handed backendFetch`);
  }
  assert.match(main, /const backendFetch = backend\.fetch;/);
  assert.doesNotMatch(main, /\bbase\(\)|OATS_DESKTOP_PORT|freePort|ensureServerOnPort|selectServer/, 'no TCP base, port or server selection in main');
});

function filesUnder(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'vendor' ? [] : filesUnder(path);
    return /\.(?:mjs|js|cjs|html)$/.test(name) ? [path] : [];
  });
}

test('A15(b): no renderer path reopens a loopback port; preload\'s only backend surface is the api IPC', () => {
  const renderer = filesUnder(join(DESKTOP, 'renderer')).filter((p) => !/^harness/.test(relative(join(DESKTOP, 'renderer'), p).split('/').pop()));
  assert.ok(renderer.length > 20, 'the renderer was scanned');
  for (const path of [...renderer, join(DESKTOP, 'preload.cjs'), join(DESKTOP, 'main.mjs')]) {
    const name = relative(DESKTOP, path), src = code(readFileSync(path, 'utf8'));
    assert.doesNotMatch(src, /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)/, `${name}: no loopback URL`);
    assert.doesNotMatch(src, /\bXMLHttpRequest\b|\bnew\s+WebSocket\b|\bnew\s+EventSource\b/, `${name}: no XHR, WebSocket or EventSource`);
    assert.doesNotMatch(src, /\bprotocol\s*\.\s*(?:handle|registerHttpProtocol|interceptHttpProtocol|registerStreamProtocol|registerBufferProtocol)\b|\b(?:registerHttpProtocol|interceptHttpProtocol)\b/,
      `${name}: no custom protocol forwarding`);
  }
  // The renderer's network calls: the views take ctx.api, never fetch.
  for (const path of renderer) assert.doesNotMatch(code(readFileSync(path, 'utf8')), /(?<![\w$.])fetch\s*\(/, `${relative(DESKTOP, path)} calls no fetch`);
  const preload = code(read('preload.cjs'));
  assert.doesNotMatch(preload, /require\(\s*["'](?:node:)?(?:http|https|net)["']\s*\)|\bfetch\s*\(/, 'preload has no transport');
  assert.match(preload, /api:\s*\(pathname, opts\)\s*=>\s*ipcRenderer\.invoke\("api", pathname, opts\)/, 'preload\'s api is the api IPC');
  const channels = [...preload.matchAll(/ipcRenderer\.(?:invoke|send|sendSync)\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
  assert.equal(channels.filter((c) => c === 'api').length, 1, 'one api IPC');
  assert.ok(!channels.some((c) => /backend|server|socket|token/i.test(c)), `no other backend channel: ${channels.join(', ')}`);
});
