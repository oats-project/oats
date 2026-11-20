// Real oats.okf 6 in a workspace-model (v2) fixture. Public CLI only;
// no inherited identity, host configuration, model sessions or GitHub calls.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { linkExecutables } from './host-fixture.mjs';
import YAML from 'yaml';
import { git as gitIn, v2Deployment } from './v2-deployment.mjs';
import { materializeOkfGitPayload } from '../../scripts/check-okf-mirror.mjs';
export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const CLI = resolve(ROOT, 'bin/oats.mjs');
export const CAP = resolve(ROOT, 'mirrors/oats-okf');
export const write = (p, text) => { fs.mkdirSync(dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
export const json = (p, value) => write(p, JSON.stringify(value, null, 2) + '\n');
export const readJSON = p => JSON.parse(fs.readFileSync(p, 'utf8'));
function okfPackage(base) {
  const repo = join(base, 'oats-okf');
  const inventory = materializeOkfGitPayload(join(repo, 'oats-package'));
  gitIn(repo, 'init', '-q', '-b', 'main');
  gitIn(repo, 'add', '.'); gitIn(repo, 'commit', '-qm', `oats.okf ${inventory.version}`);
  const tag = `v${inventory.version}`; gitIn(repo, 'tag', tag);
  const catalog = join(base, 'okf-catalog.json');
  json(catalog, { packages: { 'oats.okf': { url: repo, ref: tag, path: 'oats-package' } } });
  return { repo, tag, catalog };
}

/** Bind the verified payload, provision a base, optionally spawn a source.
 * No registration, cursor, durable input or worker-completion fixture exists. */
export function fixture(t, { git = false, settings = {}, spawnSource = true } = {}) {
  const fx = v2Deployment({
    name: 'okf-fixture',
    souls: { source: { soul: { work: 'directory' }, agents: '# Expert\nOwn rationale and observed limitations, not code descriptions.\n' } },
    files: { 'souls/source/okf.json': { json: { version: 1, owner: 'source-owner', owns: ['project/expert'], reads: ['project/peer'] } } },
  });
  t.after(() => fx.cleanup());
  const base = fx.base, context = fx.dep, bin = join(base, 'bin'), user = join(base, 'user');
  fs.mkdirSync(user); linkExecutables(bin, ['node', 'git']);
  for (const harness of ['pi', 'claude', 'codex']) {
    write(join(bin, harness), '#!/bin/sh\necho NO_MODEL_SESSIONS_IN_FIXTURES >&2\nexit 98\n');
    fs.chmodSync(join(bin, harness), 0o755);
  }
  const env = { HOME: user, PATH: bin, OATS_HOME_DIR: join(base, 'host'), LANG: 'en_US.UTF-8',
    OATS_REMOTE_CACHE: fx.env.OATS_REMOTE_CACHE, OATS_TMUX_SESSION: `none-${process.pid}`, PI_AGENTS_TMUX_SESSION: `none-${process.pid}`,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'file',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const soul = join(context, 'agents/source/soul'), okf = okfPackage(base);
  env.OATS_PACKAGE_CATALOG = okf.catalog;
  const wsDoc = YAML.parse(fs.readFileSync(join(fx.member, 'oats-workspace.yaml'), 'utf8'));
  wsDoc.packages = { ...(wsDoc.packages || {}), 'oats.okf': okf.tag };
  wsDoc.teams = { ...(wsDoc.teams || {}), okf: { description: 'Knowledge operations' } };
  wsDoc.defaults = { ...(wsDoc.defaults || {}), knowledge: { 'oats.okf': { from: 'package' } } };
  fx.commit({ 'oats-workspace.yaml': { yaml: wsDoc } }, 'lock oats.okf; bind knowledge');
  const bindings = join(base, 'bindings.json'), accepted = join(base, 'accepted');
  json(bindings, { version: 1, stateDir: join(base, 'state'), bases: {
    project: git ? { id: 'fixture-base', kind: 'git', repository: accepted, root: 'knowledge', acceptedBranch: 'main', pr: { repository: 'fixture/knowledge' } }
      : { id: 'fixture-base', kind: 'directory', path: accepted },
  } });
  const configSettings = { 'bindings-file': bindings, ...settings }, localFile = join(context, 'oats-local.yaml');
  const local = YAML.parse(fs.readFileSync(localFile, 'utf8'));
  write(localFile, YAML.stringify({ ...local, settings: { 'oats.okf': configSettings } }, { lineWidth: 0 }));
  const nodes = join(base, 'nodes.json');
  json(nodes, { expert: { path: 'expert', owner: 'source-owner' }, peer: { path: 'peer', owner: 'peer-owner' } });
  const raw = (args, { cwd = context, environment = env } = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd, env: environment, encoding: 'utf8', timeout: 90000, maxBuffer: 32 * 1024 * 1024 });
  const cli = (args, opts) => {
    const r = raw(args, opts); assert.equal(r.status, 0, JSON.stringify(args) + '\n' + r.stdout + r.stderr);
    const out = JSON.parse(r.stdout);
    if (args[0] === 'retire') return out;
    assert.equal(out.ok, true, JSON.stringify(out)); return out.result;
  };
  const gitRun = (...args) => {
    const r = spawnSync(join(bin, 'git'), args, { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  cli(['sync', '--json']);
  if (git) {
    gitRun('init', '-q', '-b', 'main', accepted);
    const seed = join(base, 'seed-knowledge');
    cli(['okf', 'init', '--base', 'project', '--nodes', nodes, '--output', seed, '--soul', 'source', '--json']);
    fs.cpSync(seed, join(accepted, 'knowledge'), { recursive: true });
    write(join(accepted, 'code.txt'), 'untouched code\n');
    gitRun('-C', accepted, 'add', '.'); gitRun('-C', accepted, 'commit', '-qm', 'accepted baseline');
  } else cli(['okf', 'init', '--base', 'project', '--nodes', nodes, '--confirm', '--soul', 'source', '--json']);
  const f = { base, context, bin, user, env, cap: CAP, soul, bindings, accepted, cli, raw, git: gitRun, fx, localFile, configSettings, okf };
  f.as = source => ({ cwd: source.home, environment: { ...env, OATS_INSTANCE_HOME: source.home, OATS_HOME: source.home, OATS_INSTANCE: source.instance } });
  f.consult = (home, path, { fresh = false } = {}) => {
    const r = raw(['okf', 'cat', '--base', 'project', path, ...(fresh ? ['--fresh'] : []), '--json'], { cwd: home, environment: { ...env, OATS_INSTANCE_HOME: home } });
    const out = JSON.parse(r.stdout);
    assert.equal(fs.existsSync(join(home, 'knowledge')), false, 'consultation has no local knowledge view');
    return out.ok ? out.result.text : null;
  };
  f.spawn = (purpose = 'probe') => cli(['spawn', 'source', '--purpose', purpose, '--repo', context, '--work', 'directory', '--harness', 'pi', '--no-launch', '--json']);
  if (spawnSource) {
    f.source = f.spawn(); f.home = f.source.home;
    assert.equal(fs.existsSync(join(f.home, '.okf-source.json')), false, '5.0 creates no source marker');
    f.soulDir = readJSON(join(f.home, 'instance.json')).soulDir;
  }
  f.direct = (args, { environment = {}, status = 0 } = {}) => {
    const r = spawnSync(process.execPath, [join(CAP, 'bin/oats-okf.mjs'), ...args, '--json'], {
      cwd: context, env: { ...env, OATS_CLI_BIN: CLI, OATS_PKG_ROOT: CAP, OATS_HOME: f.home,
        OATS_INSTANCE_HOME: f.home, OATS_SOUL: f.soulDir ?? soul, OATS_CONTEXT: context,
        OATS_SETTINGS: JSON.stringify(configSettings), ...environment },
      encoding: 'utf8', timeout: 90000, maxBuffer: 32 * 1024 * 1024,
    });
    assert.equal(r.status, status, args.join(' ') + '\n' + r.stdout + r.stderr);
    return { ...r, out: JSON.parse(r.stdout) };
  };
  f.inspect = () => cli(['okf', 'inspect', '--json'], f.as(f.source));
  f.proposal = ({ source = f.source, text = 'A durable observation merits review.', notes = ['notes/lesson.md'], file = join(source.home, 'proposal.md') } = {}) => {
    write(file, `# Proposal\n\nSource: instance ${source.instance}, home ${source.home}, soul source\n\n## What and why\n${text}\n\n## Backing notes\n${notes.map(n => '- ' + n).join('\n')}\n`);
    return file;
  };
  // oats.okf 6.0 removed the harvester: its stub soul's required spawn hook
  // refuses every spawn. The raw answer, for tests of that refusal.
  f.spawnHarvester = ({ source = f.source, file = f.proposal({ source }), relation = ['--relation', 'unrelated'], extra = [] } = {}) => raw(['spawn', 'oats.okf/knowledge-harvester', '--task-file', file, ...relation, '--no-launch', ...extra, '--json'], f.as(source));
  // `oats okf propose` dispatched by the kernel from the source's home.
  f.okfPropose = (args, { source = f.source } = {}) => {
    const r = raw(['okf', 'propose', ...args, '--json'], f.as(source));
    return { status: r.status, out: JSON.parse(r.stdout), stderr: r.stderr };
  };
  f.retire = instance => cli(['retire', instance, '--json']);
  return f;
}
