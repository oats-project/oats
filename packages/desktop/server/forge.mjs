/** Machine Connections + qualified PR read. No auth mutation is exposed by HTTP. */
import { createHmac, randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { realpathSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { cliInstanceGit } from '../../client/cli-adapter.mjs';
import { gitState, gitTargetKey } from '../../client/instance-git-contract.mjs';
import { object, ref, FORGE_API, forgeFailure, forgeReason } from '../renderer/forge-contract.mjs';
import { createGhRunner, discoverGh, ghStatus, ghLogin, ghPullRequest, forgeEnvironment } from '../forge-cli.mjs';
import { admitInstanceGit } from './instance-git.mjs';
import { forgeObservation } from './forge-observation.mjs';
import { THREADS_DETAIL_QUERY, unresolvedThreads, composeBlock, digestOf } from './review-threads.mjs';

export { FORGE_EPOCH_HEADER, validForgeEpoch } from '../forge-proxy.mjs';
import { validForgeEpoch } from '../forge-proxy.mjs';
const cliKey = cli => JSON.stringify([cli.bin, cli.version, cli.stamp, cli.profile]);
const noObservation = { target: null, observation: null };
const metadata = (target, o) => ({ target, observation: { key: o.observationKey, revision: o.revision, branch: o.branch } });
export function createForgeBoundary({ env = forgeEnvironment(), run = createGhRunner({ env }),
  discover = () => discoverGh({ run, env }), invokeGit = cliInstanceGit, now = () => performance.now(), realpath = realpathSync.native } = {}) {
  const secret = randomBytes(32), flights = new Map(), probes = new Map(), statuses = new Map();
  const hosts = new Map(), actions = new Map();
  const digest = fields => createHmac('sha256', secret).update(JSON.stringify(fields)).digest('hex');
  const sweep = () => {
    for (const map of [hosts, actions]) for (const [key, value] of map) if (value.expires <= now()) map.delete(key);
  };
  const shared = (map, key, work) => {
    if (map.has(key)) return map.get(key);
    const promise = Promise.resolve().then(work).catch(() => ({ ok: false, code: 'E_GH_FAILED' })).finally(() => map.delete(key));
    map.set(key, promise); return promise;
  };
  const failure = (code, epoch, extras = {}) => forgeFailure(code, { readEpoch: epoch, observedAt: new Date().toISOString(), ...extras });
  const flight = (key, epoch, work, extras = {}) => {
    if (flights.has(key)) return flights.get(key);
    if (flights.size >= 4) return Promise.resolve(failure('E_FORGE_BUSY', epoch, extras));
    const promise = Promise.resolve().then(work).catch(() => failure('E_GH_FAILED', epoch, extras)).finally(() => flights.delete(key));
    flights.set(key, promise); return promise;
  };
  function rememberHost(cli, host) {
    const hostRef = digest(['host', cliKey(cli), host]);
    if (!hosts.has(hostRef) && hosts.size >= 32) return null;
    const item = { hostRef, host, context: cliKey(cli), expires: now() + 15 * 60_000 };
    hosts.set(hostRef, item); return item;
  }
  async function connection({ hostRef = null, wantedHost = null, epoch, deadline }) {
    sweep();
    const selection = hostRef ? hosts.get(hostRef) || actions.get(hostRef) : null;
    if (hostRef && !selection) return failure('E_CONNECTION_CHANGED', epoch);
    const cli = await shared(probes, epoch, discover);
    if (!cli?.ok) return failure(cli?.code || 'E_GH_FAILED', epoch);
    const context = cliKey(cli);
    if (selection && selection.context !== context) return failure('E_CONNECTION_CHANGED', epoch);
    const snapshot = await shared(statuses, JSON.stringify([epoch, context]), () => ghStatus(cli, run, Math.min(10_000, deadline - now())));
    if (!snapshot.ok) return failure(snapshot.code, epoch);
    // A missing/overflowed list is never interpreted as complete or unsupported.
    for (const host of new Set(['github.com', ...snapshot.hosts.keys()])) if (!rememberHost(cli, host)) return failure('E_FORGE_LIMIT', epoch);
    const host = selection?.host || wantedHost || 'github.com';
    const admitted = hosts.get(digest(['host', context, host]));
    if (!admitted) return failure('E_UNSUPPORTED_FORGE', epoch, { host,
      remedy: `configure it in GitHub CLI first (\`gh auth login --hostname ${host}\` from a terminal)` });
    const candidate = snapshot.hosts.get(host);
    let status = candidate?.status || 'not-connected', login = null, reason = null;
    if (status === 'candidate') {
      const verified = await ghLogin(cli, host, candidate.login, run, Math.min(10_000, deadline - now()));
      if (verified.ok) { status = 'connected'; login = verified.login; }
      else { status = 'unavailable'; reason = forgeReason(verified.code); }
    } else if (status === 'unavailable') reason = forgeReason('E_GH_FAILED');
    if (selection?.connectionRef && (selection.status !== status || selection.login !== login)) return failure('E_CONNECTION_CHANGED', epoch);
    const connectionRef = digest(['account', context, host, status, login]);
    if (!actions.has(connectionRef) && actions.size >= 32) return failure('E_FORGE_LIMIT', epoch);
    actions.set(connectionRef, { connectionRef, context, host, status, login, expires: now() + 120_000 });
    return { forgeApi: FORGE_API, status, data: null, reason, readEpoch: epoch, observedAt: new Date().toISOString(),
      host, hostRef: admitted.hostRef, connectionRef, login,
      // Metadata is typed and non-secret; main must verify it before auth. No
      // renderer-provided path ever becomes a command. Never include env values.
      cli: { bin: cli.bin, version: cli.version, stamp: cli.stamp, profile: cli.profile },
      hosts: [...hosts.values()].filter(h => h.context === context).map(h => ({ host: h.host, hostRef: h.hostRef })) };
  }
  function connections(request, epoch = 'standalone:0') {
    if (!validForgeEpoch(epoch) || !object(request) || Object.keys(request).some(k => k !== 'hostRef')
      || (Object.hasOwn(request, 'hostRef') && !ref(request.hostRef))) return Promise.resolve(failure('E_BAD_ARGS', 'invalid'));
    return flight(JSON.stringify(['connections', epoch, request.hostRef || null]), epoch,
      () => connection({ hostRef: request.hostRef, epoch, deadline: now() + 20_000 }));
  }
  async function observe(admitted, cli, deadline) {
    if (deadline <= now()) return { code: 'E_GH_TIMEOUT' };
    const result = await invokeGit(admitted.bin, admitted.options, { timeout: Math.min(15_000, deadline - now()) });
    if (result?.schemaVersion !== 1 || result.ok !== true) return { code: 'E_GH_FAILED' };
    const safe = gitState(result.result, admitted.target);
    if (!safe || !isAbsolute(safe.observation.worktree)) return { code: 'E_GH_PROTOCOL' };
    return forgeObservation(result.result, admitted.target, cli);
  }
  function pull(request, getContext, epoch = 'standalone:0') {
    if (!validForgeEpoch(epoch) || !object(request) || Object.keys(request).some(k => !['selector', 'observationKey'].includes(k)) || !ref(request.observationKey)) {
      return Promise.resolve(failure('E_BAD_ARGS', 'invalid', noObservation));
    }
    const context = getContext();
    // A pull request is read from this machine's clone of the work; a remote row has none here.
    if (context?.workspace?.remote) return Promise.resolve(failure('unsupported-remote-operation', epoch, noObservation));
    const admitted = admitInstanceGit({ action: 'git', selector: request.selector }, context);
    if (admitted.failure) return Promise.resolve({ ...failure('E_GH_FAILED', epoch, noObservation),
      target: admitted.failure.target, reason: admitted.failure.reason });
    const key = JSON.stringify(['pr', epoch, admitted.bin, context.cli.version, admitted.context, gitTargetKey(admitted.target), request.observationKey]);
    return flight(key, epoch, async () => {
      const deadline = now() + 45_000;
      const observation = await observe(admitted, context.cli, deadline);
      if (!observation.observationKey) return failure(observation.code, epoch, { ...noObservation, target: admitted.target });
      const echo = metadata(admitted.target, observation);
      if (observation.observationKey !== request.observationKey) return failure('E_OBSERVATION_CHANGED', epoch, echo);
      if (observation.code) return failure(observation.code, epoch, echo);
      const conn = await connection({ wantedHost: observation.route.host, epoch, deadline });
      let result;
      if (conn.status !== 'connected') result = { ...conn, ...echo };
      else {
        const pr = await ghPullRequest(conn.cli, { ...observation.route, branch: observation.branch }, run, Math.min(10_000, deadline - now()), { threads: true });
        result = pr.ok ? { forgeApi: FORGE_API, status: pr.data ? 'available' : 'no-pull-request', data: pr.data, reason: null,
          ...echo, host: conn.host, repository: observation.route.path, hostRef: conn.hostRef, connectionRef: conn.connectionRef, readEpoch: epoch, observedAt: new Date().toISOString() }
          : failure(pr.code, epoch, echo);
      }
      const latest = getContext(), again = admitInstanceGit({ action: 'git', selector: request.selector }, latest);
      if (again.failure || again.context !== admitted.context || gitTargetKey(again.target) !== gitTargetKey(admitted.target)) return failure('E_OBSERVATION_CHANGED', epoch, echo);
      const verified = await observe(again, latest.cli, deadline);
      if (verified.observationKey !== observation.observationKey) return failure('E_OBSERVATION_CHANGED', epoch, echo);
      return result;
    }, { ...noObservation, target: admitted.target });
  }
  /* Send review threads (W6 item 4): preview composes the block (review-threads.mjs) from the
     instance's own PR and answers its exact text + digest; send recomposes, requires the same
     digest (else E_THREADS_CHANGED), re-verifies the Git observation and pastes through the
     injected terminal (review-paste.mjs: one bracketed paste into the kernel's agent pane, no Enter). The renderer supplies
     no text, only the selector, the observation key and (for send) the digest. */
  const noThreads = { target: null, observation: null, text: null, digest: null };
  function reviewThreads(request, getContext, epoch = 'standalone:0', terminal = null) {
    const send = request?.action === 'send', keys = send ? ['action', 'selector', 'observationKey', 'digest'] : ['action', 'selector', 'observationKey'];
    if (!validForgeEpoch(epoch) || !object(request) || !['preview', 'send'].includes(request.action) || Object.keys(request).some(k => !keys.includes(k))
      || !ref(request.observationKey) || (send && !ref(request.digest)) || !terminal) return Promise.resolve(failure('E_BAD_ARGS', 'invalid', noThreads));
    const context = getContext();
    if (context?.workspace?.remote) return Promise.resolve(failure('E_REMOTE_TERMINAL', epoch, noThreads));
    const admitted = admitInstanceGit({ action: 'git', selector: request.selector }, context);
    if (admitted.failure) return Promise.resolve({ ...failure('E_GH_FAILED', epoch, noThreads), target: admitted.failure.target, reason: admitted.failure.reason });
    const refused = terminal.check(admitted.target);
    if (refused) return Promise.resolve(failure(refused, epoch, { ...noThreads, target: admitted.target }));
    const key = JSON.stringify([send ? 'threads-send' : 'threads-preview', epoch, gitTargetKey(admitted.target), send ? request.digest : null]);
    return flight(key, epoch, async () => {
      const deadline = now() + 45_000, fail = (code, extra = {}) => failure(code, epoch, { ...noThreads, target: admitted.target, ...extra });
      const observation = await observe(admitted, context.cli, deadline);
      if (!observation.observationKey) return fail(observation.code);
      const echo = metadata(admitted.target, observation);
      if (observation.observationKey !== request.observationKey) return fail('E_OBSERVATION_CHANGED', echo);
      if (observation.code) return fail(observation.code, echo);
      const conn = await connection({ wantedHost: observation.route.host, epoch, deadline });
      if (conn.status === 'cli-not-installed' || conn.status === 'not-connected') return fail('E_GH_UNAVAILABLE', echo);
      if (conn.status !== 'connected') return fail(conn.reason?.code || 'E_GH_FAILED', echo);
      const { host, path } = observation.route;
      const pr = await ghPullRequest(conn.cli, { host, path, branch: observation.branch }, run, Math.min(10_000, deadline - now()));
      if (!pr.ok) return fail(pr.code, echo);
      if (!pr.data) return fail('E_NO_THREADS', echo);
      const [owner, name] = path.split('/');
      const answer = await run(conn.cli.bin, ['api', 'graphql', '--hostname', host, '-f', `query=${THREADS_DETAIL_QUERY}`,
        '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${pr.data.number}`], { timeout: Math.min(10_000, deadline - now()) });
      if (!answer.ok) return fail(answer.code, echo);
      if (answer.exitCode !== 0) return fail('E_GH_FAILED', echo);
      let raw; try { raw = JSON.parse(answer.stdout); } catch { return fail('E_GH_PROTOCOL', echo); }
      const parsed = unresolvedThreads(raw, host);
      if (!parsed) return fail('E_GH_PROTOCOL', echo);
      if (!parsed.threads.length) return fail('E_NO_THREADS', echo);
      const block = composeBlock({ number: pr.data.number, repo: path, prUrl: pr.data.url, threads: parsed.threads, more: parsed.more });
      if (!block) return fail('E_GH_PROTOCOL', echo);
      const digest = digestOf(block.text);
      const done = extra => ({ forgeApi: FORGE_API, status: 'ok', action: request.action, reason: null, digest, threads: block.shown, omitted: block.omitted,
        ...echo, readEpoch: epoch, observedAt: new Date().toISOString(), ...extra });
      if (!send) return done({ text: block.text });
      if (digest !== request.digest) return fail('E_THREADS_CHANGED', echo);
      const latest = getContext(), again = admitInstanceGit({ action: 'git', selector: request.selector }, latest);
      if (again.failure || gitTargetKey(again.target) !== gitTargetKey(admitted.target)) return fail('E_OBSERVATION_CHANGED', echo);
      const verified = await observe(again, latest.cli, deadline);
      if (verified.observationKey !== observation.observationKey) return fail('E_OBSERVATION_CHANGED', echo);
      const pasted = await terminal.paste(admitted.target, block.text);
      if (pasted) return fail(pasted, echo);
      return done({ sent: true });
    }, noThreads);
  }
  return { connections, pull, reviewThreads };
}
export const forgeBoundary = createForgeBoundary();
