// okf 5.0.0: the 4.x harvest settings are gone, except one: a soul's own
// `knowledge: { harvest: off }`, its author's opt-out (a public soul is
// reachable from outside, and its notes must not be harvested). The kernel
// still forwards an undeclared key that a layer sets (soul ⊕ host ⊕ spawn,
// with the last layer that set it in OATS_SETTINGS_ORIGINS), so every command
// and hook refuses any other: a host or spawn harvest, even `off`, harvest-
// runtime and harvest-model anywhere, naming where it was set and the fix. A
// host key masks the soul's, so it must go before the soul opt-out shows.
// A key the kernel filled in from the 4.x manifest default (origin
// manifest-default: harvest off, harvest-runtime pi) was nobody's decision, so
// it is ignored everywhere, as if absent: a home spawned under 4.x replays it.
// `setup --remove-legacy-settings` deletes the host's own explicit keys from
// the deployment's oats-local.yaml, and nothing else; it never touches a soul.
import { fs, join, resolve, atomic, fail } from './io.mjs';

export const LEGACY_KEYS = ['harvest', 'harvest-runtime', 'harvest-model'];
const NEW_WAY = 'agents now propose their own knowledge by PR at checkpoints (oats okf propose)';
const WHY = { harvest: NEW_WAY, 'harvest-runtime': 'there is no harvest runtime: agents propose their own knowledge by PR (oats okf propose)', 'harvest-model': 'there is no harvest model: agents propose their own knowledge by PR (oats okf propose)' };
const CLEANUP = 'oats okf setup --remove-legacy-settings --soul <soul> --json';
const failWith = (code, message, result) => { throw Object.assign(new Error(message), { code, result }); };

/** One sentence, also the binding check's `setting:removed` reason template (oats.json binding.reasons). */
export const REMOVED_TEMPLATE = '<setting> <origin> was removed in oats.okf 5.0; <remedy>';
export const removedSentence = (parts) => REMOVED_TEMPLATE.replace(/<([a-z]+)>/g, (_, k) => parts[k]);
/** OATS_SETTINGS_ORIGINS: JSON pointer → { kind, at } of the last layer that set each leaf. */
export function parseOrigins(text = process.env.OATS_SETTINGS_ORIGINS) {
  try { const o = JSON.parse(text || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; }
}
const defaulted = (origins, key) => origins[`/${key}`]?.kind === 'manifest-default';
/** `settings` without the legacy keys a 4.x manifest default filled in. */
export function withoutDefaults(settings, env = process.env) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return settings;
  const origins = parseOrigins(env.OATS_SETTINGS_ORIGINS);
  return Object.fromEntries(Object.entries(settings).filter(([k]) => !(LEGACY_KEYS.includes(k) && defaulted(origins, k))));
}
/** The forwarded legacy keys, 4.x defaults aside → [{ key, kind, at, message }] (no values). */
export function legacySettings(env = process.env) {
  let settings; try { settings = JSON.parse(env.OATS_SETTINGS || '{}'); } catch { return []; }
  if (!settings || typeof settings !== 'object') return [];
  const origins = parseOrigins(env.OATS_SETTINGS_ORIGINS);
  return LEGACY_KEYS.filter((key) => Object.hasOwn(settings, key) && !defaulted(origins, key) && !(key === 'harvest' && settings.harvest === 'off' && origins['/harvest']?.kind === 'soul')).map((key) => {
    // Only the harvest key's OWN soul-origin off is the opt-out; a soul's
    // publish: off never excuses a host or spawn harvest key.
    const layer = origins[`/${key}`], kind = typeof layer?.kind === 'string' ? layer.kind : null, at = typeof layer?.at === 'string' ? layer.at : null;
    const origin = kind ? `from ${kind}${at ? ` (${at})` : ''}` : 'from an unknown origin';
    let setting = key, remedy;
    if (kind === 'host') { setting = `settings.oats.okf.${key}`; remedy = `${WHY[key]}; run ${CLEANUP} from this deployment.`; }
    else if (kind === 'soul' && key === 'harvest') { setting = 'knowledge.harvest other than off'; remedy = `only the soul's opt-out, knowledge: { harvest: off }, remains; remove the key in the soul's reviewed source (or set it off) and sync/respawn; ${NEW_WAY}. Host cleanup cannot change a soul setting.`; }
    else if (kind === 'soul') { setting = `knowledge.${key}`; remedy = `remove that key in the soul's reviewed source and sync/respawn; ${WHY[key]}. Host cleanup cannot remove a soul setting.`; }
    else if (kind === 'spawn') remedy = `drop it from the spawn command; ${WHY[key]}. Host cleanup cannot remove it.`;
    else if (kind) remedy = `remove it in that layer's reviewed source; ${WHY[key]}. Host cleanup cannot remove it.`;
    else remedy = `${WHY[key]}; find where it is set (oats-local.yaml settings.oats.okf, soul.yaml knowledge:, or a --provider oats.okf flag) and remove it (${CLEANUP} removes a host value).`;
    return { key, kind: kind ?? 'unknown', at, setting, origin, remedy, message: removedSentence({ setting, origin, remedy }) };
  });
}
/** Whether the soul opts out: the forwarded `harvest` (or, from oats.okf 6,
 *  its spelling `publish`) is `off` and the soul layer is the one that set it
 *  (a host or spawn value masks it, and refuses). */
export function soulOptOut(env = process.env) {
  let settings; try { settings = JSON.parse(env.OATS_SETTINGS || '{}'); } catch { return false; }
  const origins = parseOrigins(env.OATS_SETTINGS_ORIGINS);
  return ['harvest', 'publish'].some(key => settings?.[key] === 'off' && origins[`/${key}`]?.kind === 'soul');
}
/** oats.okf 6: `publish: off` is the soul's opt-out, spelled differently, and
 *  nothing else; `propose` is no setting at all. Any other use refuses. */
export function refuseKnowledgeKeys(env = process.env) {
  let settings; try { settings = JSON.parse(env.OATS_SETTINGS || '{}'); } catch { return; }
  if (!settings || typeof settings !== 'object') return;
  if (Object.hasOwn(settings, 'propose')) fail('E_CONFIG', 'knowledge.propose is not a setting; instances propose directly in oats.okf 6; use harvest: off to opt out');
  if (Object.hasOwn(settings, 'publish')) {
    const layer = parseOrigins(env.OATS_SETTINGS_ORIGINS)['/publish'];
    if (layer?.kind !== 'soul' || settings.publish !== 'off') fail('E_CONFIG', `publish ${layer?.kind ? `from ${layer.kind}${typeof layer.at === 'string' ? ` (${layer.at})` : ''}` : 'from an unknown origin'} is not valid: only the soul's own knowledge: { publish: off } (or harvest: off) opts out; remove it there`);
  }
}
/** Refuse a forwarded legacy key before any of this provider's effects. */
export function refuseLegacySettings(env = process.env) {
  const found = legacySettings(env);
  if (found.length) fail('E_REMOVED', found.map((f) => f.message).join(' '));
}

/** The deployment the kernel dispatched this invocation in:
 *  OATS_WORKSPACE (hooks), else OATS_TEAM_SCOPE (command dispatch). Neither,
 *  a relative or missing one, or two that disagree is a refusal, never a guess
 *  from a repository or a home. */
export function deployment(env = process.env) {
  const named = [['OATS_WORKSPACE', env.OATS_WORKSPACE], ['OATS_TEAM_SCOPE', env.OATS_TEAM_SCOPE]].filter(([, v]) => typeof v === 'string' && v);
  const how = 'run it through the kernel: from the deployment with --soul <soul>, or from the instance home; the source repository is never taken for the deployment';
  if (!named.length) fail('E_DEPLOYMENT_SCOPE', `oats.okf needs the deployment the kernel dispatched it in (OATS_WORKSPACE or OATS_TEAM_SCOPE), and none was given: ${how}`);
  const real = named.map(([k, v]) => {
    if (resolve(v) !== v) fail('E_DEPLOYMENT_SCOPE', `${k} is not an absolute deployment path: ${how}`);
    try { return fs.realpathSync(v); } catch { return fail('E_DEPLOYMENT_SCOPE', `${k} names no existing deployment (${v}): ${how}`); }
  });
  if (new Set(real).size > 1) fail('E_DEPLOYMENT_SCOPE', `OATS_WORKSPACE (${real[0]}) and OATS_TEAM_SCOPE (${real[1]}) name different deployments: ${how}`);
  return real[0];
}

// The deployment's explicit host keys, from a small line reader that only
// accepts block style: `settings:` → `oats.okf:` (a DIRECT child) →
// `<key>: <scalar>`. Any other shape that might hold a legacy key, an
// `oats.okf` nested under another key included, is refused before a write.
// The edited text is read again before it is written: it must still be one
// settings.oats.okf map (block or `{}`, never null) with no legacy key.
const KEY = /^(\s+)(['"]?)([A-Za-z0-9._-]+)\2\s*:(.*)$/;
const value = (rest) => rest.replace(/\s+#.*$/, '').trim();
function plan(text, { verify = false } = {}) {
  const refuse = (why) => fail('E_UNSUPPORTED', `oats-local.yaml: ${why}, which this cleanup does not edit; nothing was written. Report it to the deployment's owner`);
  const lines = text.split('\n');
  if (!verify && !/harvest/.test(text)) return { lines, keys: [] }; // nothing to remove: any shape will do
  if (/\t/.test(text)) refuse('tab indentation is not edited');
  if (lines.some((l) => /^(---|\.\.\.)\s*$/.test(l))) refuse('a multi-document file is not edited');
  const s = lines.findIndex((l) => /^settings\s*:/.test(l));
  if (s < 0) { if (/oats\.okf/.test(text)) refuse('oats.okf appears outside a top-level settings: block'); return { lines, keys: [] }; }
  if (lines.findIndex((l, i) => i > s && /^settings\s*:/.test(l)) >= 0) refuse('settings: appears twice');
  if (value(lines[s].replace(/^settings\s*:/, '')) !== '') refuse('settings: is not a block mapping');
  let end = lines.length;
  for (let i = s + 1; i < lines.length; i++) if (/^\S/.test(lines[i]) && !/^#/.test(lines[i])) { end = i; break; }
  const blank = (l) => /^\s*(#.*)?$/.test(l), lead = (l) => /^(\s*)/.exec(l)[1].length;
  const entries = lines.slice(s + 1, end).filter((l) => !blank(l)), direct = entries.length ? lead(entries[0]) : 0;
  if (entries.some((l) => lead(l) < direct)) refuse('the settings: entries are not consistently indented');
  const owners = lines.slice(s + 1, end).map((l, j) => [KEY.exec(l), s + 1 + j]).filter(([m]) => m && m[3] === 'oats.okf');
  if (owners.some(([m]) => m[1].length !== direct)) refuse('oats.okf appears nested under another settings key');
  if (!owners.length) { if (lines.slice(s + 1, end).some((l) => /oats\.okf/.test(l))) refuse('oats.okf is not a plain block key under settings:'); return { lines, keys: [] }; }
  if (owners.length > 1) refuse('settings.oats.okf appears twice');
  const [[m, o]] = owners, childIndent = m[1].length;
  if (value(m[4]) === '{}') return { lines, keys: [], owner: 'empty' }; // what an earlier cleanup leaves
  if (value(m[4]) !== '') refuse('settings.oats.okf is not a block mapping');
  let keyIndent = null, blockEnd = end; const remove = [], seen = new Set();
  for (let i = o + 1; i < end; i++) {
    if (blank(lines[i])) continue;
    const at = lead(lines[i]);
    if (at <= childIndent) { blockEnd = i; break; }
    if (keyIndent === null) keyIndent = at;
    if (at !== keyIndent) continue; // a nested value of another key
    const k = KEY.exec(lines[i]);
    if (!k) refuse('a settings.oats.okf entry is not key: value');
    if (seen.has(k[3])) refuse(`settings.oats.okf.${k[3]} appears twice`); seen.add(k[3]);
    if (!LEGACY_KEYS.includes(k[3])) continue;
    const v = value(k[4]);
    if (v === '' || /^[|>&*!{[]/.test(v)) refuse(`settings.oats.okf.${k[3]} is not a plain one-line value`);
    const next = lines.slice(i + 1, end).find((l) => !/^\s*(#.*)?$/.test(l));
    if (next && /^(\s*)/.exec(next)[1].length > keyIndent) refuse(`settings.oats.okf.${k[3]} continues on the next line`);
    remove.push(i);
  }
  const kept = lines.slice(o + 1, blockEnd).filter((l, j) => !remove.includes(o + 1 + j) && !blank(l));
  const keys = remove.map((i) => KEY.exec(lines[i])[3]);
  // An emptied map stays a map: `{}` goes before any inline comment, never into it.
  if (remove.length && !kept.length) lines[o] = `${lines[o].slice(0, lines[o].length - m[4].length)} {}${/\s+#.*$/.exec(m[4])?.[0] ?? ''}`;
  return { lines: lines.filter((_, i) => !remove.includes(i)), keys, owner: kept.length ? 'block' : 'null' };
}
/** `oats okf setup --remove-legacy-settings [--plan]` in the dispatching deployment. */
export function removeLegacySettings({ plan: preview = false } = {}) {
  const file = join(deployment(), 'oats-local.yaml');
  let stat; try { stat = fs.lstatSync(file); } catch { fail('E_CONFIG', `no oats-local.yaml in the deployment (${file}); nothing was written`); }
  if (!stat.isFile() || stat.nlink !== 1 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) fail('E_UNSUPPORTED', `${file} is not a single-link regular file owned by this user; nothing was written`);
  const text = fs.readFileSync(file, 'utf8'), out = plan(text), removed = out.keys.map((k) => `settings.oats.okf.${k}`);
  if (removed.length) {
    let again; try { again = plan(out.lines.join('\n'), { verify: true }); } catch { again = null; }
    if (!again || again.keys.length || !['block', 'empty'].includes(again.owner)) fail('E_UNSUPPORTED', `${file}: removing ${removed.join(', ')} would not leave settings.oats.okf a valid map, so this cleanup does not edit it; nothing was written. Report it to the deployment's owner`);
  }
  const found = legacySettings(), others = found.filter((f) => f.kind !== 'host');
  // The kernel says the host set a key this reader did not find: not this file's shape, so nothing is written.
  const missed = found.filter((f) => f.kind === 'host' && !out.keys.includes(f.key)).map((f) => f.key);
  if (missed.length) fail('E_UNSUPPORTED', `the host layer sets settings.oats.okf.${missed.join('/')}, but ${file} has no such plain key under settings: oats.okf: that this cleanup edits; nothing was written. Report it to the deployment's owner`);
  const result = { file, removed, ...(preview ? { plan: true } : {}), written: false, ...(others.length ? { remaining: others.map(({ key, kind, at }) => ({ key, kind, at })) } : {}) };
  if (!preview && removed.length) {
    const next = out.lines.join('\n');
    if (fs.readFileSync(file, 'utf8') !== text) fail('E_CONFLICT', `${file} changed while it was read; nothing was written: run the command again`);
    atomic(file, next, { mode: stat.mode & 0o777 }); // the deployment's file keeps its own permissions
    let after; try { after = fs.readFileSync(file, 'utf8'); } catch { after = null; }
    if (after !== next) failWith('E_UNCERTAIN', `${file} was replaced, but reading it back did not show the intended edit, so the outcome is uncertain; report it to the deployment's owner (removed: ${removed.join(', ')})`, { ...result, written: 'unknown' });
    result.written = true;
  }
  if (others.length) failWith('E_REMOVED', others.map((f) => f.message).join(' '), result);
  return result;
}
