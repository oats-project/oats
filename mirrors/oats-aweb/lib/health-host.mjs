import {registryEnv} from './registry-setting.mjs';
import {awChildEnv} from './aw-child-env.mjs';
// What the agent status publisher reads and runs on the host: the kernel's
// public CLI (status, session inspect, instance events, readiness, schedule),
// aw (the offline identity doctor and the status commands), its designation
// caches and its refusal log. Every argv here is exercised against the real
// binaries by test/health-host-native.test.mjs and
// test/health-command-native.test.mjs.
import {spawn} from 'node:child_process';
import {appendFile, mkdir, readFile, rename, stat, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {versionAtLeast} from './aw-floor.mjs';

const KERNEL_TIMEOUT_MS = 30 * 1000;
const AW_TIMEOUT_MS = 15 * 1000;
/** The kernel events that say what last happened to a home's session. */
const LIFECYCLE = ['launched', 'restarted', 'stopped'];
/** An instance session's own variables, which would scope a kernel call to it. */
const KERNEL_UNSET = ['OATS_INSTANCE', 'OATS_INSTANCE_HOME', 'OATS_HOME'];
/** The first aw with `aw status-host` and `aw status publish` (aweb-acah.3.1). */
export const AW_STATUS_MIN = '1.36.38';
export const AW_STATUS_UNSUPPORTED = (version) => `aw ${version} has no status publish; needs aw >= ${AW_STATUS_MIN} (aweb-acah.3.1)`;
/** The refusal log's size before it rotates. */
const LOG_MAX_BYTES = 1024 * 1024;
/** How the publisher hands aw one status document for `alias`, on stdin. */
export const statusPublishArgs = (alias) => ['status', 'publish', '--alias', alias, '--document', '-', '--json'];

function run(command, args, {cwd, env, input, timeout}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {cwd, env, stdio: ['pipe', 'pipe', 'pipe'], timeout});
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (error) => resolve({status: null, stdout, stderr: String(error.message || error)}));
    child.on('close', (status, signal) => resolve({status: signal ? null : status, stdout, stderr: signal ? `killed by ${signal}` : stderr}));
    // A child that exits before reading its input closes the pipe under the
    // write (EPIPE): its exit status and output are its answer.
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

const without = (env, names) => Object.fromEntries(Object.entries(env).filter(([k]) => !names.includes(k)));
const parseJson = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
/** aw prints one JSON object; take the last line that is one. */
const lastJson = (text) => String(text).trim().split('\n').reverse().map(parseJson).find((v) => v && typeof v === 'object');

/** `deployment` is where kernel calls run and the log lives; `env` is the
 *  environment the children start from. The kernel is the one that dispatched
 *  this command (OATS_NODE_BIN and OATS_CLI_BIN), else `oats` on PATH. */
export function healthHost({deployment, env, settings={}}) {
  const kernelArgv = env.OATS_NODE_BIN && env.OATS_CLI_BIN ? [env.OATS_NODE_BIN, env.OATS_CLI_BIN] : ['oats'];
  const kernelEnv = without(env, KERNEL_UNSET);

  // Agents publish in parallel; their log writes run one after another, so
  // two of them never rotate the log at once.
  let logged = Promise.resolve();

  const kernel = async (args) => {
    const r = await run(kernelArgv[0], [...kernelArgv.slice(1), ...args, '--json'], {cwd: deployment, env: kernelEnv, timeout: KERNEL_TIMEOUT_MS});
    const doc = parseJson(r.stdout);
    return r.status === 0 && doc ? doc : {ok: false, error: doc?.error ?? {code: 'E_UNREADABLE', message: (r.stderr || r.stdout).trim().slice(0, 500)}};
  };
  const aw = (target, args, input) => run('aw', [...(target.identityHome ? ['--identity-home', target.identityHome] : []), ...args], {cwd: target.cwd ?? deployment, env: awChildEnv(env,registryEnv(settings,args)), input, timeout: AW_TIMEOUT_MS});
  /** An aw status command's answer: {ok, status, code, message, retry_after}. */
  const awAnswer = (r) => {
    const doc = lastJson(r.stdout);
    if (doc && typeof doc.ok === 'boolean') return {status: null, code: null, message: '', retry_after: null, ...doc};
    return {ok: false, status: null, code: 'transport', message: (r.stderr || r.stdout).trim().slice(0, 500) || `aw exited ${r.status}`, retry_after: null};
  };

  /** The version aw prints on its first line, as printed, or 'unknown'. */
  const awVersion = async () => (await aw({}, ['version'])).stdout.match(/^aw (\S+)$/m)?.[1] ?? 'unknown';

  return {
    async supportsWaiting() {
      const doc = await kernel(['version']);
      return Array.isArray(doc?.features) && doc.features.includes('waiting-on-you');
    },

    async wakeStatus() {
      const answer = await aw({}, ['wake', 'status', '--json']);
      return answer.status === 0 ? parseJson(answer.stdout) : null;
    },

    async unreadCount(identityHome) {
      const answer = await aw({identityHome}, ['mail', 'inbox', '--count-only', '--json']);
      const count = answer.status === 0 ? parseJson(answer.stdout)?.unread_count : null;
      return Number.isSafeInteger(count) && count >= 0 ? count : null;
    },

    async supportsUnreadCount() {
      const answer = await aw({}, ['mail', 'inbox', '--help']);
      return answer.status === 0 && answer.stdout.includes('--count-only');
    },

    async waiting(home, message) {
      const doc = await kernel(['instance', 'waiting', message === null ? 'clear' : 'set',
        '--producer', 'oats.aweb', ...(message === null ? [] : ['--reason', 'attention', '--message', message]),
        '--home', home, '--dir', deployment]);
      if (!doc?.ok) throw new Error('oats.aweb waiting claim update failed');
    },

    async status() {
      const doc = await kernel(['status']);
      if (!Array.isArray(doc?.agents)) throw new Error(`oats status gave no roster: ${doc?.error?.message ?? 'no answer'}`);
      return doc;
    },

    /** {state: alive|shell|stopped|not-launched|unobservable, lastEvent}. */
    async liveness({instance, home}) {
      const inspected = await kernel(['session', 'inspect', '--home', home]);
      // The kernel names no code for a tmux server that is gone, as after a
      // reboot; its message is the only sign that the session is not running.
      const serverGone = !inspected.ok && inspected.error?.code === 'E_SESSION_UNAVAILABLE' && /no server running/.test(inspected.error.message ?? '');
      if (!inspected.ok && !serverGone) return {state: 'unobservable', lastEvent: null};
      const state = serverGone ? 'stopped' : inspected.result.present && inspected.result.state === 'unknown' ? 'alive' : inspected.result.state;
      // The last lifecycle event only tells an intended stop from a crash, so
      // a live harness's events are not read: each kernel call costs a tick
      // about 0.15 s of CPU.
      if (state === 'alive') return {state, lastEvent: null};
      const events = await kernel(['instance', 'events', instance, '--home', home]);
      const lastEvent = (events.ok ? events.result.events : []).map((e) => e.kind).filter((k) => LIFECYCLE.includes(k)).at(-1) ?? null;
      return {state, lastEvent};
    },

    /** The oats.aweb provider's readiness answer, or null when there is none. */
    async readiness(home) {
      const doc = await kernel(['readiness', '--home', home]);
      const items = doc?.ok ? doc.result.checks?.providers?.items ?? [] : [];
      return items.find((i) => i.capability?.id === 'oats.aweb')?.result ?? null;
    },

    /** {did, stable_id?} from aw's offline identity doctor, or null. */
    async identityOf(target) {
      const doc = parseJson((await aw(target, ['doctor', 'identity', '--offline', '--json'])).stdout);
      const detail = (id) => doc?.checks?.find((c) => c.id === id && c.status === 'ok')?.detail ?? {};
      const did = detail('identity.local.did_key_format').did_key;
      const stableId = detail('identity.local.stable_id_expected').stable_id;
      if (typeof did !== 'string' || !did.startsWith('did:key:')) return null;
      return typeof stableId === 'string' && stableId.startsWith('did:aw:') ? {did, stable_id: stableId} : {did};
    },

    /** Whether the aw on PATH is at least AW_STATUS_MIN; its version decides,
     *  since a pre-release build below the floor may already list the command. */
    async awSupportsStatus() {
      const version = await awVersion();
      return versionAtLeast(version, AW_STATUS_MIN) ? {ok: true} : {ok: false, message: AW_STATUS_UNSUPPORTED(version)};
    },

    /** Whether the aw on PATH can clear a designation: any aw with
     *  `status-host clear`, below the floor too, so turning publishing off
     *  never leaves a designation behind. */
    async awClearsDesignations() {
      if ((await aw({}, ['status-host', 'clear', '--help'])).status === 0) return {ok: true};
      return {ok: false, message: `aw ${await awVersion()} has no status-host clear; upgrade aw to ${AW_STATUS_MIN} or later and run \`oats aweb health disable\` again`};
    },

    async statusHostSet(target, hostDid) {
      return awAnswer(await aw(target, ['status-host', 'set', '--host-did', hostDid, '--json']));
    },

    async statusHostClear(target) {
      return awAnswer(await aw(target, ['status-host', 'clear', '--json']));
    },

    async statusPublish(target, alias, document) {
      return awAnswer(await aw(target, statusPublishArgs(alias), JSON.stringify(document)));
    },

    /** The deployment's local schedule `id`, or null. */
    async schedule(id) {
      const doc = await kernel(['schedule', 'show', id]);
      return doc.ok ? doc.result.schedule : null;
    },

    async addSchedule(id, spec) {
      const doc = await kernel(['schedule', 'add', id, '--spec-json', JSON.stringify(spec)]);
      if (!doc.ok) throw new Error(`oats schedule add ${id}: ${doc.error?.message ?? 'no answer'}`);
    },

    async removeSchedule(id) {
      const doc = await kernel(['schedule', 'remove', id]);
      if (!doc.ok && doc.error?.code !== 'E_SCHEDULE_UNKNOWN') throw new Error(`oats schedule remove ${id}: ${doc.error?.message ?? 'no answer'}`);
    },

    /** The host timer as `oats schedule host status` reports it. */
    async timer() {
      const doc = await kernel(['schedule', 'host', 'status']);
      return doc.ok ? doc.result.scheduler : null;
    },

    /** A native channel's receipt of an open stream (aweb-acah.3.2), or null. */
    async receipt(dir) {
      try { return JSON.parse(await readFile(join(dir, 'receive', 'stream.json'), 'utf8')); } catch { return null; }
    },

    /** Whether process `pid` exists (a process of another user counts). */
    pidAlive(pid) {
      try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
    },

    async readCache(file) {
      try { const value = JSON.parse(await readFile(file, 'utf8')); return value && typeof value === 'object' ? value : null; } catch { return null; }
    },

    async writeCache(file, value) {
      await mkdir(dirname(file), {recursive: true, mode: 0o700});
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(value)}\n`, {mode: 0o600});
      await rename(temporary, file);
    },

    log(entry) {
      const write = async () => {
        const file = join(deployment, '.oats-aweb', 'health', 'log.jsonl');
        await mkdir(dirname(file), {recursive: true, mode: 0o700});
        // A refusal that repeats every minute must not grow the log without
        // bound: past the cap, the log becomes its one older generation.
        const size = await stat(file).then((st) => st.size, () => 0);
        if (size >= LOG_MAX_BYTES) await rename(file, `${file}.1`);
        await appendFile(file, `${JSON.stringify(entry)}\n`, {mode: 0o600});
      };
      const done = logged.then(write);
      logged = done.catch(() => {});
      return done;
    },
  };
}
