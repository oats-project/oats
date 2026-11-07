import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { withoutControlToken } from '../../client/control-environment.mjs';
import { cliEnvironment } from '../../client/cli-environment.mjs';
import { execFileInSession, cliServers } from '../../client/cli-adapter.mjs';
import { execFileToFiles } from '../../client/file-output-exec.mjs';
import { runTerminalCommand } from '../../client/terminal-exec.mjs';
import { remoteTerminalEnvironment } from '../remote-target.mjs';
import { localTmuxIo } from '../local-tmux-io.mjs';
import { forgeEnvironment, createGhRunner } from '../forge-cli.mjs';
import { PATH_BEGIN, PATH_END, resolveLoginPath } from '../login-path.mjs';

const TOKEN = 'control-environment-fixture-token-32';
const source = Object.freeze({ OATS_DESKTOP_TOKEN: TOKEN, HOME: '/memory/home', PATH: '/usr/bin', SSH_AUTH_SOCK: '/memory/agent' });
const absent = env => assert.equal(Object.hasOwn(env, 'OATS_DESKTOP_TOKEN'), false);

test('the control environment scrub returns a new copy, keeps other values and never changes its source', () => {
  assert.deepEqual(withoutControlToken(source), { HOME: source.HOME, PATH: source.PATH, SSH_AUTH_SOCK: source.SSH_AUTH_SOCK });
  assert.equal(source.OATS_DESKTOP_TOKEN, TOKEN);
  assert.notEqual(withoutControlToken(source), source);
  assert.deepEqual(withoutControlToken(withoutControlToken(source)), withoutControlToken(source));
  for (const OATS_DESKTOP_TOKEN of ['', undefined, null, 7]) absent(withoutControlToken({ OATS_DESKTOP_TOKEN }));
});

test('CLI, remote PTY and forge environment builders remove the control token', () => {
  for (const build of [cliEnvironment, remoteTerminalEnvironment, forgeEnvironment]) {
    const env = build(source); absent(env);
    assert.equal(env.HOME, source.HOME); assert.equal(env.PATH, source.PATH);
  }
});

test('every local tmux operation and viewer PTY receives a scrubbed environment', () => {
  const seen = [];
  const io = localTmuxIo('/memory/tmux.sock', {
    env: source,
    execFileSync: (_bin, _args, options) => { seen.push(options.env); return 'tmux 3.4'; },
    spawnPty: (_bin, _args, options) => { seen.push(options.env); return {}; },
  });
  io.preflight('=fixture:=seat'); io.tmux(['list-sessions']); io.tmuxOut(['list-sessions']);
  io.spawnPty('=fixture:=seat', 80, 24);
  assert.equal(seen.length, 5);
  for (const env of seen) { absent(env); assert.equal(env.SSH_AUTH_SOCK, source.SSH_AUTH_SOCK); }
});

test('terminal commands scrub an explicitly supplied environment', async () => {
  let given;
  const done = runTerminalCommand('/memory/oats', ['session', 'inspect'], { env: source }, (_bin, _args, options, callback) => {
    given = options.env;
    const child = new EventEmitter();
    queueMicrotask(() => { callback(null, '', ''); child.emit('close', 0); });
    return child;
  });
  await done; absent(given); assert.equal(given.HOME, source.HOME);
});

test('CLI adapter calls scrub implicitly inherited environments', async () => {
  const before = process.env.OATS_DESKTOP_TOKEN;
  process.env.OATS_DESKTOP_TOKEN = TOKEN;
  try {
    let given;
    const result = await cliServers('/memory/oats', { exec: (_bin, _args, options, callback) => {
      given = options.env; callback(null, '{"schemaVersion":1,"ok":true,"result":{}}');
    } });
    assert.equal(result.ok, true); absent(given);
    assert.equal(process.env.OATS_DESKTOP_TOKEN, TOKEN);
  } finally {
    if (before === undefined) delete process.env.OATS_DESKTOP_TOKEN;
    else process.env.OATS_DESKTOP_TOKEN = before;
  }
});

for (const [name, exec] of [['session', execFileInSession], ['file output', execFileToFiles]]) {
  test(`${name} child receives no control token, with an explicit environment and with implicit inheritance`, async () => {
    const before = process.env.OATS_DESKTOP_TOKEN;
    process.env.OATS_DESKTOP_TOKEN = TOKEN;
    try {
      for (const env of [undefined, { ...process.env, OATS_DESKTOP_TOKEN: TOKEN }]) {
        const result = await new Promise((resolve, reject) => {
          exec(process.execPath, ['-e', 'process.stdout.write(String(Object.hasOwn(process.env,"OATS_DESKTOP_TOKEN")))'],
            { env, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout));
        });
        assert.equal(result, 'false');
      }
    } finally {
      if (before === undefined) delete process.env.OATS_DESKTOP_TOKEN;
      else process.env.OATS_DESKTOP_TOKEN = before;
    }
  });
}


test('the gh runner scrubs an explicitly supplied environment at launch', async () => {
  let given;
  const run = createGhRunner({ env: source, launch(_bin, _args, options) {
    given = options.env;
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    queueMicrotask(() => child.emit('close', 0));
    return child;
  } });
  assert.equal((await run('/memory/gh', ['version'])).ok, true);
  absent(given); assert.equal(given.HOME, source.HOME);
});

test('the login shell never inherits a control token supplied in its environment', async () => {
  let given;
  const result = await resolveLoginPath({ env: source, platform: 'linux', spawn(_bin, _args, options) {
    given = options.env;
    const child = new EventEmitter();
    child.stdout = Object.assign(new EventEmitter(), { setEncoding() {}, destroy() {} });
    queueMicrotask(() => {
      child.stdout.emit('data', `${PATH_BEGIN}\n/usr/bin\n${PATH_END}\n`);
      child.emit('exit', 0, null); child.emit('close', 0, null);
    });
    return child;
  } });
  assert.equal(result.source, 'login-shell');
  absent(given); assert.equal(given.PATH, source.PATH);
});
