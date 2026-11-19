import { parseProviderSettings } from './provider-settings.mjs';
// `oats aweb health enable|disable|status|publish`: the operator's switch for
// the agent status publisher (aweb-acah.3) and the command the host timer runs
// once a minute. Run from the deployment. Enabling records the host-only
// `health` setting in oats-local.yaml and registers one local schedule job;
// installing the host timer stays the operator's step
// (`oats schedule host install`). A deployment that never enables runs none of
// this.
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {recordAwebSetting} from './local-settings.mjs';
import {selectedDeployment} from './team-roots.mjs';
import {AW_STATUS_MIN, healthHost} from './health-host.mjs';
import {clearDesignations, healthSettings, publishTick} from './health-publisher.mjs';
import {observeUnreadAttention} from './unread-attention.mjs';

export const HEALTH_JOB = 'oats-aweb-health';
const NOTE = 'a newly started or restarted agent appears within a minute';
/** The releases required to publish (aw) and to prove receive (the channels). */
const FLOORS = {aw: AW_STATUS_MIN, claudeChannel: '1.7.17', piExtension: '0.3.15'};
/** A tick older than this means publishing has stopped. */
const STALE_TICK_MS = 3 * 60 * 1000;
const USAGE = 'usage: oats aweb health enable [--operator <role>] [--language <tag>] | disable | status | publish [--json]';

const jobSpec = (deployment) => ({enabled: true, cron: '* * * * *', tz: 'UTC', kind: 'command', cwd: deployment, argv: ['oats', 'aweb', 'health', 'publish'], description: 'Publish agent status to aweb (oats.aweb health)'});
const sameJob = (job, spec) => job.kind === spec.kind && job.cron === spec.cron && job.cwd === spec.cwd && JSON.stringify(job.argv) === JSON.stringify(spec.argv);
const lastTickFile = (deployment) => join(deployment, '.oats-aweb', 'health', 'last.json');

/** The kernel's own scope flags, as `--dir=X` or `--dir X`; they select the
 *  deployment, which `selectedDeployment` reads, and are not health's. */
const SCOPE_FLAGS = ['--dir', '--soul'];

function parse(argv) {
  const kept = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json' || SCOPE_FLAGS.some((f) => argv[i].startsWith(`${f}=`))) continue;
    if (SCOPE_FLAGS.includes(argv[i])) { i++; continue; }
    kept.push(argv[i]);
  }
  const [action, ...rest] = kept;
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const [flag, inline] = rest[i].split(/=(.*)/s);
    if (action !== 'enable' || !['--operator', '--language'].includes(flag)) throw Object.assign(new Error(USAGE), {code: 'E_HEALTH_ARGUMENT'});
    const value = inline ?? rest[++i];
    if (value === undefined) throw Object.assign(new Error(USAGE), {code: 'E_HEALTH_ARGUMENT'});
    options[flag.slice(2)] = value;
  }
  if (!['enable', 'disable', 'status', 'publish'].includes(action)) throw Object.assign(new Error(USAGE), {code: 'E_HEALTH_ARGUMENT'});
  return {action, options};
}

/** What is publishing here, and what stops it. */
async function report(health, {deployment, host}) {
  const job = await host.schedule(HEALTH_JOB);
  const timer = await host.timer();
  let lastTick = null;
  try { lastTick = JSON.parse(await readFile(lastTickFile(deployment), 'utf8')); } catch { /* none yet */ }
  const problems = [];
  const observer = {enabled: health.publish, waiting: await host.supportsWaiting(), countOnly: await host.supportsUnreadCount()};
  observer.note = !health.publish ? 'off: no unread-delivery attention claims without health publishing and its per-minute host timer'
    : !observer.waiting ? 'unavailable: kernel needs waiting-on-you'
    : !observer.countOnly ? 'unavailable: aw mail inbox needs --count-only; failed counts preserve existing claims'
    : 'runs with the per-minute health tick for registered session-delivery homes';
  if (health.publish) {
    if (!job) problems.push(`the job ${HEALTH_JOB} is not registered: run \`oats aweb health enable\``);
    else if (!sameJob(job, jobSpec(deployment))) problems.push(`the job ${HEALTH_JOB} does not run \`oats aweb health publish\` every minute from this deployment: run \`oats schedule remove ${HEALTH_JOB}\`, then \`oats aweb health enable\``);
    if (!timer?.installed) problems.push('the host timer is not installed: run `oats schedule host install` (an operator step)');
    else if (!timer.registered) problems.push('this deployment is not registered with the host timer: run `oats schedule host install` here (an operator step)');
    else if (!timer.active) problems.push('the host timer is installed but not running: see `oats schedule host status`');
    const supported = await host.awSupportsStatus();
    if (!supported.ok) problems.push(supported.message);
    if (!problems.length && (!lastTick || Date.now() - Date.parse(lastTick.at) > STALE_TICK_MS)) problems.push(`no tick since ${lastTick?.at ?? 'enable'}: see \`oats schedule show ${HEALTH_JOB}\``);
  }
  return {
    publish: health.publish, language: health.language, operator: health.operator,
    job: job ? {id: HEALTH_JOB, cron: job.cron, argv: job.argv} : null,
    timer: timer ? {installed: timer.installed, active: timer.active, registered: timer.registered} : null,
    lastTick, floors: FLOORS, ready: health.publish && !problems.length, problems, note: NOTE, observer,
  };
}

async function enable(options, {deployment, host, settings}) {
  const health = healthSettings({health: {...settings.health, ...options, publish: true}});
  recordAwebSetting('health', 'publish', true, {start: deployment});
  for (const key of ['operator', 'language']) if (options[key] !== undefined) recordAwebSetting('health', key, options[key], {start: deployment});
  if (!(await host.schedule(HEALTH_JOB))) await host.addSchedule(HEALTH_JOB, jobSpec(deployment));
  return report(health, {deployment, host});
}

async function disable({deployment, host, settings}) {
  await host.removeSchedule(HEALTH_JOB);
  recordAwebSetting('health', 'publish', false, {start: deployment});
  const unreadAttention = await observeUnreadAttention({host, clear: true});
  const designations = await clearDesignations({settings, host});
  return {...(await report({...healthSettings(settings), publish: false}, {deployment, host})), designations, unreadAttention};
}

async function publish({deployment, host, settings}) {
  if (!healthSettings(settings).publish) return {disabled: true};
  const unreadAttention = await observeUnreadAttention({host});
  const result = await publishTick({settings, now: Date.now, host});
  result.unreadAttention = unreadAttention;
  if (!result.disabled) {
    await mkdir(join(deployment, '.oats-aweb', 'health'), {recursive: true, mode: 0o700});
    await writeFile(lastTickFile(deployment), `${JSON.stringify({at: new Date().toISOString(), published: result.published.length, refused: result.refused.length, skipped: result.skipped.length, failed: result.failed.length})}\n`, {mode: 0o600});
  }
  return result;
}

/** An action's exit status: 1 while publishing is on and something stops
 *  it, or when `disable` left a designation on the server; else 0. */
export function healthExit(result) {
  return (result.publish && result.ready === false) || result.designations?.failed.length || result.unreadAttention?.failed ? 1 : 0;
}

/** Runs one action; prints one JSON envelope with --json, else plain lines.
 *  Exits 1 when the action failed, or as healthExit says. */
export async function healthMain(argv, {env = process.env, stdout = process.stdout} = {}) {
  const json = argv.includes('--json');
  const print = (doc) => stdout.write(json ? `${JSON.stringify(doc)}\n` : `${healthText(doc)}\n`);
  try {
    const {action, options} = parse(argv);
    const deployment = selectedDeployment(env);
    const settings = parseProviderSettings(env);
    const host = healthHost({deployment, env, settings});
    const result = action === 'enable' ? await enable(options, {deployment, host, settings})
      : action === 'disable' ? await disable({deployment, host, settings})
      : action === 'status' ? await report(healthSettings(settings), {deployment, host})
      : await publish({deployment, host, settings});
    print({schemaVersion: 1, ok: true, result});
    return healthExit(result);
  } catch (error) {
    const code = error.code ?? (/has no status publish/.test(error.message) ? 'E_HEALTH_AW' : 'E_HEALTH');
    print({schemaVersion: 1, ok: false, error: {code, message: String(error.message || error)}});
    return 1;
  }
}

/** The plain lines for one result envelope. */
export function healthText(doc) {
  if (!doc.ok) return `oats aweb health: ${doc.error.message}`;
  const r = doc.result;
  const attention = r.unreadAttention && `unread attention: set ${r.unreadAttention.set}, cleared ${r.unreadAttention.cleared}, unknown ${r.unreadAttention.unknown}, failed ${r.unreadAttention.failed}`;
  if ('published' in r) return [`published ${r.published.length}, refused ${r.refused.length}, skipped ${r.skipped.length}, failed ${r.failed.length}`, attention].filter(Boolean).join('\n');
  if (r.disabled) return 'publishing is off (settings.oats.aweb.health.publish)';
  const lines = [`publishing: ${r.publish ? 'on' : 'off'}${r.publish ? (r.ready ? ', ready' : ', NOT ready') : ''}`];
  if (r.lastTick) lines.push(`last tick: ${r.lastTick.at} (published ${r.lastTick.published}, refused ${r.lastTick.refused}, skipped ${r.lastTick.skipped}, failed ${r.lastTick.failed ?? 0})`);
  for (const p of r.problems) lines.push(`problem: ${p}`);
  if (r.observer) lines.push(`unread attention: ${r.observer.note}`);
  if (attention) lines.push(attention);
  if (r.designations) {
    lines.push(`designations cleared: ${r.designations.cleared.length}, not cleared: ${r.designations.failed.length}`);
    const reason = (f) => f.message || (f.status ? `HTTP ${f.status}` : f.code);
    for (const why of new Set(r.designations.failed.map(reason))) lines.push(`designations not cleared: ${why}`);
  }
  lines.push(`required: aw ${r.floors.aw} to publish; Claude channel ${r.floors.claudeChannel} or pi extension ${r.floors.piExtension} to prove receive`);
  lines.push(`note: ${r.note}`);
  return lines.join('\n');
}
