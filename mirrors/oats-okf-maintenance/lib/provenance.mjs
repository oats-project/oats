// The provenance block, as the maintainer reads it from a PR body.
// The body is untrusted: the block is parsed strictly, every field is
// shape-checked, and the result is data — strings to verify, never commands.
// version 1: an oats.okf 4.x harvest run (run id, captured input ids).
// version 2 (oats.okf 5.0): a proposal harvest, with no run or input ids: the
// source, the harvester and the evidence it relied on, as instance-relative
// note refs (sha256 only for a note the harvester actually read).
// version 3 (oats.okf 6.0), fenced ```okf-proposal: the instance proposed its
// own knowledge with `oats okf propose`; there is no harvester. It names the
// source's incarnation and the proposer (live, or the operator's recovery
// form), with the same evidence shape (sha256 only for a note that was read).
// A version-2 soul (okf.json with subjects, no owner/owns/reads) adds an
// optional source.subjects [<kind>/<slug>]; owner may then be null, and
// ownedNodes/readNodes are [].
const FENCE = /^```(okf-harvest|okf-proposal)[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/m;
const FENCE_OF = { 1: 'okf-harvest', 2: 'okf-harvest', 3: 'okf-proposal' };
const obj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max = 256) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
// <base alias>/<node id>, each the bindings' and okf-base.json's identifier
// grammar (io.mjs identifier: a letter or digit, then letters, digits, . _ -;
// at most 96), so every reference a soul may declare parses here.
const ID = '[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}';
const NODE = new RegExp(`^${ID}/${ID}$`);
const SUBJECT = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/; // <kind>/<slug>, the subject layer's
/** A base root as a repository-relative directory: no `..`, absolute, backslash or empty segment. */
export const safeRoot = (r) => r === '.' || (typeof r === 'string' && !r.startsWith('/') && !r.includes('\\') && r.split('/').every((s) => s && s !== '.' && s !== '..'));

// The proposer's note grammar (oats.okf 5.8's safeNote): any filename under
// notes/ ending .md, spaces and parentheses included; no backslash or control
// character, no empty, parent or hidden segment. It is data, never a path read here.
const note = (n) => typeof n === 'string' && n.length <= 512 && /^notes\/.+\.md$/.test(n) && !/[\\\x00-\x1f\x7f]/.test(n) && n.split('/').every((seg) => seg && seg !== '.' && seg !== '..' && !seg.startsWith('.'));
/** → { valid, problems[], value|null } for the FIRST okf-harvest or okf-proposal block in `body`. */
export function parseProvenance(body) {
  const problems = [];
  if (typeof body !== 'string') return { valid: false, problems: ['the PR has no body'], value: null };
  const m = FENCE.exec(body);
  if (!m) return { valid: false, problems: ['no ```okf-proposal or ```okf-harvest provenance block in the PR body'], value: null };
  if (m[2].length > 64 * 1024) return { valid: false, problems: ['provenance block exceeds 64KiB'], value: null };
  let v;
  try { v = JSON.parse(m[2]); } catch (e) { return { valid: false, problems: [`provenance block is not JSON (${e.message})`], value: null }; }
  const need = (cond, what) => { if (!cond) problems.push(what); return cond; };
  const only = (value, keys, at) => { for (const k of Object.keys(value)) if (!keys.includes(k)) problems.push(`${at}: unknown key ${JSON.stringify(k).slice(0, 80)}`); };
  if (!need(obj(v), 'provenance must be an object')) return { valid: false, problems, value: null };
  if (!need(v.version === 1 || v.version === 2 || v.version === 3, 'version must be 1, 2 or 3')) return { valid: false, problems, value: null };
  if (!need(FENCE_OF[v.version] === m[1], `version ${v.version} belongs in a \`\`\`${FENCE_OF[v.version]} block, not \`\`\`${m[1]}`)) return { valid: false, problems, value: null };
  if (v.version === 1) {
    only(v, ['version', 'run', 'input', 'source', 'tasks', 'harvester'], 'provenance');
    need(typeof v.run === 'string' && /^[0-9a-f-]{36}$/.test(v.run), 'run must be a run id');
    need(Array.isArray(v.input) && v.input.length > 0 && v.input.length <= 1000 && v.input.every((i) => typeof i === 'string' && /^[0-9a-f]{64}$/.test(i)), 'input must be a non-empty list of 64-hex input ids');
  } else {
    only(v, ['version', 'source', 'evidence', 'tasks', v.version === 2 ? 'harvester' : 'proposer'], 'provenance');
    need(Array.isArray(v.evidence) && v.evidence.length <= 100 && v.evidence.every((e) => obj(e) && Object.keys(e).every((k) => ['note', 'sha256'].includes(k))
      && note(e.note) && (e.sha256 === undefined || (typeof e.sha256 === 'string' && /^[0-9a-f]{64}$/.test(e.sha256)))),
    'evidence must be a list of up to 100 {note: notes/<path>.md, sha256?: 64-hex}');
  }
  if (need(obj(v.source), 'source must be an object')) {
    const s = v.source;
    only(s, v.version === 1 ? ['soul', 'soulId', 'owner', 'instance', 'ownedNodes', 'readNodes', 'bases'] : v.version === 2 ? ['soul', 'owner', 'instance', 'ownedNodes', 'readNodes', 'bases'] : ['soul', 'owner', 'instance', 'incarnation', 'subjects', 'ownedNodes', 'readNodes', 'bases'], 'source');
    // okf 4.0.1: the source's okf.json owner (what okf-base.json nodes record); optional for 4.0.0 PRs, required in v2.
    if (v.version === 1) need(s.owner === undefined || s.owner === null || str(s.owner, 128), 'source.owner must be a string or null');
    else if (v.version === 2 || s.subjects === undefined) need(str(s.owner, 128), 'source.owner must be the source soul\'s okf.json owner');
    else {
      // v3 with subjects: a version-2 soul; owner optional, no owned or read nodes.
      need(Array.isArray(s.subjects) && s.subjects.length > 0 && s.subjects.length <= 256 && s.subjects.every((x) => typeof x === 'string' && SUBJECT.test(x)) && new Set(s.subjects).size === s.subjects.length, 'source.subjects must be a non-empty list of distinct <kind>/<slug>');
      need(s.owner === null || str(s.owner, 128), 'source.owner must be a string or null');
      if (s.owner === null) need(Array.isArray(s.ownedNodes) && !s.ownedNodes.length && Array.isArray(s.readNodes) && !s.readNodes.length, 'source.ownedNodes and source.readNodes must be [] when source.owner is null');
    }
    need(str(s.soul, 128), 'source.soul must be a name');
    if (v.version === 1) need(s.soulId === null || str(s.soulId, 512), 'source.soulId must be a string or null');
    need(str(s.instance, 128), 'source.instance must be a name');
    if (v.version === 3) need(str(s.incarnation, 128), 'source.incarnation must be the source instance.json createdAt');
    for (const k of ['ownedNodes', 'readNodes']) need(Array.isArray(s[k]) && s[k].length <= 256 && s[k].every((n) => typeof n === 'string' && NODE.test(n)), `source.${k} must be a list of base/node`);
    need(Array.isArray(s.bases) && s.bases.length <= 64 && s.bases.every((b) => obj(b) && Object.keys(b).every((k) => ['alias', 'id', 'kind', 'root', 'repository'].includes(k)) && (v.version === 3 ? typeof b.alias === 'string' && new RegExp(`^${ID}$`).test(b.alias) : str(b.alias, 64)) && str(b.id, 128) && ['git', 'directory'].includes(b.kind) && (b.root === undefined || str(b.root, 512)) && (b.repository === undefined || str(b.repository, 512))), 'source.bases must be a list of {alias, id, kind, root?, repository?}');
    need(!Array.isArray(s.bases) || s.bases.every((b) => !obj(b) || b.root === undefined || safeRoot(b.root)), 'source.bases[].root must be a relative directory without ..');
    // v2 publishes no machine path: a base's repository is its GitHub owner/repo.
    if (v.version >= 2) need(!Array.isArray(s.bases) || s.bases.every((b) => !obj(b) || b.repository === undefined || (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(b.repository) && b.repository.split('/').every((x) => x !== '.' && x !== '..'))), 'source.bases[].repository must be the GitHub owner/repo, never a path or URL');
  }
  if (need(obj(v.tasks), 'tasks must be an object')) {
    only(v.tasks, ['provider', 'refs'], 'tasks');
    need(v.tasks.provider === null || str(v.tasks.provider, 128), 'tasks.provider must be a capability id or null');
    need(Array.isArray(v.tasks.refs) && v.tasks.refs.length <= 100 && v.tasks.refs.every((r) => str(r, 256)), 'tasks.refs must be a list of up to 100 strings');
  }
  if (v.version === 3) {
    if (need(obj(v.proposer), 'proposer must be an object')) {
      const p = v.proposer;
      only(p, ['form', 'instance', 'alias'], 'proposer');
      need(p.form === 'live' || p.form === 'recovery', 'proposer.form must be live or recovery');
      // The operator's recovery form may run from no instance at all.
      need(str(p.instance, 128) || (p.form === 'recovery' && p.instance === null), 'proposer.instance must be a name (or null in the recovery form)');
      need(p.alias === null || str(p.alias, 256), 'proposer.alias must be a string or null');
    }
  } else if (need(obj(v.harvester), 'harvester must be an object')) {
    only(v.harvester, ['instance', 'alias'], 'harvester');
    need(str(v.harvester.instance, 128), 'harvester.instance must be a name');
    need(v.harvester.alias === null || str(v.harvester.alias, 256), 'harvester.alias must be a string or null');
  }
  return { valid: problems.length === 0, problems, value: problems.length ? null : v };
}
