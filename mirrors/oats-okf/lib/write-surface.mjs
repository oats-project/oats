// okf 6.0: what `oats okf propose --check` does on a base with the subject
// layout (spec 2026-11-10-subject-layer-in-oats-okf.md §3), over the proposal's
// clone of the accepted base. The rule is advisory where the tool applies it
// (propose runs with the proposer's own push rights); the maintainer's review
// at merge is the gate.
//
//   version 1 soul: its owned nodes and the root index.md, as before; on a
//     bridged base every new claim gets `about:` from the subject whose
//     `legacy-nodes` names its node (E_SUBJECT when none does).
//   version 2 soul (a bridged base): add or change files under claims/**, add
//     Markdown files under subjects/system/** and subjects/project/** (never
//     a reserved index.md or log.md), set
//     `status: superseded` on a concept it supersedes; never verdicts/**,
//     subjects/workstream/**, okf-base.json, the root index.md by hand, or any
//     other old-node file.
//   both: the generated indexes are regenerated, and nothing else may differ
//     in them from the regenerator's output.
import { fs, join, fail } from './io.mjs';
import { parseFrontmatter, generate, readConcepts, withSubjectsSection, subjectOfPath, place, isReservedFile, bridged as isBridged, orphanViews, assertSafeTree, writeInBase, textKey } from './okf-reindex.mjs';
import { verdictLanes } from './verdicts.mjs';

const read = (root, p) => { try { return fs.readFileSync(join(root, p), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const under = (p, dir) => p === dir || p.startsWith(`${dir}/`);
/** Whether a base path is one of the regenerator's outputs. */
export function generatedPath(p) {
  return p === 'subjects/index.md' || p === 'verdicts/index.md' || /^subjects\/(system|workstream|project)\/[^/]+\/index\.md$/.test(p);
}
/** The file's text with its `status:` frontmatter line removed. */
function withoutStatus(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  if (!m) return text;
  return `---\n${m[1].split('\n').filter(l => !/^status:/.test(l)).join('\n')}\n---${m[2]}${text.slice(m[0].length)}`;
}
/** A change that only sets `status: superseded` on an existing concept. */
export function onlySupersedes(before, after) {
  if (before === null || after === null) return false;
  const meta = parseFrontmatter(after);
  return meta.parsed && meta.meta.status === 'superseded' && withoutStatus(before) === withoutStatus(after);
}

/** The base's legacy-nodes map: node name → subject ref (get/has by node
 *  name; keyed inside by textKey, node names being untrusted base text). */
export function legacyMap(root) {
  const out = new Map();
  for (const [p, meta] of readConcepts(root)) {
    const s = subjectOfPath(p);
    if (s && Array.isArray(meta['legacy-nodes'])) for (const node of meta['legacy-nodes']) if (!out.has(textKey(node))) out.set(textKey(node), s.ref);
  }
  return { get: node => out.get(textKey(node)), has: node => out.has(textKey(node)), get size() { return out.size; } };
}

/** Insert `about: [<ref>]` after `description:` (else at the end of the
 *  frontmatter), touching no other line. */
export function addAbout(text, ref) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  if (!m) return null;
  const lines = m[1].split('\n'), at = lines.findIndex(l => /^description:/.test(l));
  lines.splice(at < 0 ? lines.length : at + 1, 0, `about: [${ref}]`);
  return `---\n${lines.join('\n')}\n---${m[2]}${text.slice(m[0].length)}`;
}

/** Replace the frontmatter's `about:` line with the given list, touching no other line. */
export function setAbout(text, refs) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  const lines = m[1].split('\n').map(l => /^about:/.test(l) ? `about: [${refs.join(', ')}]` : l);
  return `---\n${lines.join('\n')}\n---${m[2]}${text.slice(m[0].length)}`;
}
/** okf 6.0 preparation of a proposal clone on a bridged base, before the
 *  checks: a version-1 soul's new claims get `about:` from `legacy-nodes`,
 *  then every generated index is regenerated. `changes`: [{path, status}]
 *  with status A (added), M (modified) or D (deleted), base paths.
 *  → { about: [paths], regenerated: [paths] } (nothing on a plain base). */
export function prepareSubjectProposal({ root, decl, ownedNodes, changes }) {
  if (!isBridged(root)) return { about: [], regenerated: [] };
  // Nothing is read or written through a symlink or a hardlink (E_PATH).
  assertSafeTree(root);
  const about = [];
  if (decl.version !== 2) {
    const map = legacyMap(root);
    for (const c of changes.filter(c => c.status === 'A' && c.path.endsWith('.md') && !isReservedFile(c.path))) {
      const node = Object.entries(ownedNodes).find(([, path]) => under(c.path, path))?.[0];
      if (!node) continue; // outside the owned nodes: the scope check names it
      // Every new claim: its node's subject first (E_SUBJECT when none absorbs
      // the node), whatever `about:` the proposer wrote.
      const ref = map.get(node);
      if (!ref) fail('E_SUBJECT', `${c.path}: no subject on this base names node ${node} in its legacy-nodes, so the claim has no subject; ask the knowledge maintainer to add ${node} to a subject's legacy-nodes, or move this soul to okf.json version 2`);
      const text = read(root, c.path), fm = parseFrontmatter(text ?? '');
      if (!fm.parsed) continue; // the validator refuses it
      if (fm.meta.about === undefined) writeInBase(root, c.path, addAbout(text, ref));
      else if (Array.isArray(fm.meta.about)) { if (fm.meta.about.includes(ref)) continue; writeInBase(root, c.path, setAbout(text, [ref, ...fm.meta.about])); }
      else fail('E_SUBJECT', `${c.path}: about must be a flow list [<kind>/<slug>, ...]; it is completed with ${ref}, the subject of node ${node}`);
      about.push(c.path);
    }
  }
  const concepts = readConcepts(root), expected = generate(concepts, read(root, 'index.md') ?? ''), regenerated = [];
  for (const [p, text] of expected) if (read(root, p) !== text) { writeInBase(root, p, text); regenerated.push(p); }
  for (const p of orphanViews(root, concepts)) { fs.rmSync(join(root, p)); regenerated.push(p); }
  return { about, regenerated };
}

/** The write-surface rule over the proposal's changes (after preparation).
 *  `before(path)` reads the accepted text. Every violation is collected and
 *  refused together: E_SCOPE, naming each path and its rule. */
/** What the proposal's own claims supersede: the base paths and ids in the
 *  `supersedes:` lists of the claims it adds or changes. */
function superseded(root, changes) {
  const out = new Set();
  for (const { path: p, status } of changes) {
    if (status === 'D' || !p.endsWith('.md') || isReservedFile(p) || place(p) !== 'claim') continue;
    const fm = parseFrontmatter(read(root, p) ?? '');
    if (!fm.parsed || fm.meta.status === 'superseded') continue;
    const list = Array.isArray(fm.meta.supersedes) ? fm.meta.supersedes : typeof fm.meta.supersedes === 'string' && fm.meta.supersedes ? [fm.meta.supersedes] : [];
    // keyed by textKey: supersedes items are free text (many long ones would make a plain Set quadratic)
    for (const ref of list) out.add(textKey(String(ref).trim().replace(/^\/+/, '')));
  }
  return out;
}
export function checkWriteSurface({ root, decl, ownedNodes, changes, before }) {
  const bridgedBase = isBridged(root), owned = Object.values(ownedNodes), problems = [];
  const supersedes = bridgedBase ? superseded(root, changes) : new Set();
  const v1Rule = `a version-1 soul writes only its owned nodes (${owned.map(p => `${p}/`).join(', ') || 'none'}) and the root index.md`;
  for (const { path: p, status } of changes) {
    const after = status === 'D' ? null : read(root, p);
    // The regenerator's own outputs: allowed exactly as it writes them.
    if (bridgedBase && (generatedPath(p) || p === 'index.md' && decl.version === 2)) {
      if (p === 'index.md') {
        const old = before(p);
        if (after !== old && after !== withSubjectsSection(old ?? '')) problems.push(`${p}: a version-2 proposal changes the root index.md only through the regenerator's Subjects section`);
      }
      continue; // content checked against the regenerator below
    }
    if (decl.version !== 2) {
      if (p === 'index.md' || owned.some(n => under(p, n))) continue;
      problems.push(`${p}: ${v1Rule}`);
      continue;
    }
    if (!bridgedBase) { problems.push(`${p}: a version-2 soul proposes only to a base with the subject layout`); continue; }
    if (status === 'D') { problems.push(`${p}: a proposal deletes nothing; supersede a concept with status: superseded`); continue; }
    if (under(p, 'claims')) { if (!p.endsWith('.md')) problems.push(`${p}: claims/ holds Markdown concepts only`); continue; }
    if (under(p, 'subjects/system') || under(p, 'subjects/project')) {
      // As claims/: Markdown only; and a reserved name (a node's index.md or
      // log.md) is never a subject, at any depth (the generated views were
      // judged above).
      if (!p.endsWith('.md')) problems.push(`${p}: subjects/system/ and subjects/project/ hold Markdown subject files only`);
      else if (isReservedFile(p)) problems.push(`${p}: ${p.split('/').pop()} is a reserved name; a proposal adds subject files subjects/<system|project>/<slug>.md`);
      else if (status !== 'A') problems.push(`${p}: a proposal adds system and project subjects; it never changes an existing one`);
      continue;
    }
    if (under(p, 'verdicts')) { problems.push(`${p}: only the knowledge maintainer writes verdicts/`); continue; }
    if (under(p, 'subjects/workstream')) { problems.push(`${p}: workstreams change only on a person's cited acceptance, by the knowledge maintainer`); continue; }
    if (p === 'okf-base.json') { problems.push(`${p}: a proposal never changes okf-base.json`); continue; }
    // A concept only: a node's reserved index.md/log.md is never superseded.
    if (status === 'M' && place(p) === 'claim' && !isReservedFile(p) && onlySupersedes(before(p), after)) {
      // Only a concept one of the proposal's own claims supersedes, by path or id.
      const id = parseFrontmatter(after).meta.id;
      if (supersedes.has(textKey(p)) || (typeof id === 'string' && id && supersedes.has(textKey(id)))) continue;
      problems.push(`${p}: status: superseded only on a concept a claim of this proposal supersedes (supersedes: [/${p}] or its id)`);
      continue;
    }
    problems.push(`${p}: outside the write surface (claims/**, new subjects/system/** and subjects/project/** files, status: superseded on a concept it supersedes)`);
  }
  if (bridgedBase) {
    const expected = generate(readConcepts(root), read(root, 'index.md') ?? '');
    for (const [p, text] of expected) if (read(root, p) !== text) problems.push(`${p}: a generated index differs from okf-reindex.mjs's output; regenerate, never edit it`);
  }
  if (problems.length) fail('E_SCOPE', problems.join('; '));
}

/** The validator's findings a proposal may carry: a claim it adds or changes
 *  has no `id` until the maintainer stamps one at acceptance. */
export function proposalFindings(findings, changes) {
  const mine = new Set(changes.filter(c => c.status !== 'D').map(c => c.path));
  return findings.filter(f => { const m = /^(.+): missing 'id' \(stamped by the maintainer at acceptance\)$/.exec(f); return !(m && mine.has(m[1])); });
}

/** Verdict lanes 1 and 2 for every claim the proposal adds or changes, read
 *  from the clone (the accepted verdict record). Refuses E_VERDICT on the first
 *  rejected id without `reconsiders:`; → [{ path, ...lanes }] with candidates. */
export function proposalVerdicts(root, changes) {
  if (!isBridged(root)) return [];
  const index = read(root, 'verdicts/index.md') ?? '', out = [];
  for (const { path: p, status } of changes) {
    if (status === 'D' || !p.endsWith('.md') || isReservedFile(p) || place(p) !== 'claim') continue;
    const fm = parseFrontmatter(read(root, p) ?? '');
    if (!fm.parsed) continue;
    const lanes = verdictLanes(fm.meta, index, id => read(root, `verdicts/${id}.md`));
    if (lanes.refusal) throw Object.assign(new Error(`${p}: ${lanes.refusal}`), { code: 'E_VERDICT', result: { path: p, ...lanes } });
    out.push({ path: p, ...lanes });
  }
  return out;
}
/** The PR body's section for title-hash candidates and reconsiderations. */
export function verdictSection(reports) {
  const rows = reports.flatMap(r => [
    ...(r.identity ? [`- \`${r.path}\` reconsiders \`${r.identity.id}\` (${r.identity.verdict})${r.identity.reason ? `: ${r.identity.reason}` : ''}`] : []),
    ...r.candidates.map(c => `- \`${r.path}\`: title-hash candidate \`${c.id}\` (${c.verdict}, ${c.claimType}) "${c.title}"`)
  ]);
  return rows.length ? `## Verdict candidates\n\n${rows.join('\n')}\n\nThe proposer says for each whether its claim is the same, a reconsideration or different; the reviewer resolves them to canonical ids.\n` : '';
}
