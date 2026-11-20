// Spawn-written instruction state, not authority to publish. `oats okf
// propose` (6.0) refuses an off or unknown home itself, and checks the soul's
// own opt-out text too. The file keeps its 5.2 name and shape (`harvest`);
// `oats okf status` also answers the same value as `publish`.
import { fs, join, safePath, save, fail } from './io.mjs';
import { soulOptOut } from './legacy-settings.mjs';

const FILE = 'okf-harvest-policy.json';
const MAX_BYTES = 1024;
const invalid = () => fail('E_HARVEST_STATE', 'oats.okf spawn policy is invalid or unreadable; do not propose; report it and respawn with the current provider, never repair the policy by hand');

export function writeHarvestPolicy(home, env = process.env) {
  const off = soulOptOut(env);
  const policy = { version: 1, harvest: off ? 'off' : 'on', reason: off ? 'soul-opt-out' : 'default' };
  save(join(home, FILE), policy);
  return policy;
}

/** No inference from current settings, TASK.md or soul files. An old home
 *  without spawn state is unknown, never permission to start harvesting. */
export function harvestPolicy(home) {
  const file = safePath(join(home, FILE));
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (e) {
    if (e.code === 'ENOENT') return { harvest: 'unknown', reason: 'spawn-state-missing' };
    return invalid();
  }
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) return invalid();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > MAX_BYTES || opened.dev !== stat.dev || opened.ino !== stat.ino) return invalid();
    // Bound the read even if the file grows after fstat.
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const n = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (!n) break;
      length += n;
    }
    if (length > MAX_BYTES) return invalid();
    let policy;
    try { policy = JSON.parse(bytes.subarray(0, length).toString('utf8')); } catch { return invalid(); }
    if (!policy || Object.keys(policy).sort().join(',') !== 'harvest,reason,version' || policy.version !== 1 ||
        !(policy.harvest === 'on' && policy.reason === 'default' || policy.harvest === 'off' && policy.reason === 'soul-opt-out')) return invalid();
    return { harvest: policy.harvest, reason: policy.reason };
  } finally { fs.closeSync(fd); }
}
