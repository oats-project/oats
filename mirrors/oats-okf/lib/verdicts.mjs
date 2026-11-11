// okf 6.0: the proposer's verdict check (`oats okf verdicts --check`, and
// `propose --check` on a base with the subject layout). Two lanes of the
// design's three; the lexical lane is not in this build.
//   1. identity: a claim naming a known id (its `id`, or the id it
//      `reconsiders`) reads that id's verdict; a rejected id proposed again
//      without a `reconsiders:` line refuses E_VERDICT with the verdict's reason.
//   2. exact title hash: sha256(<Type>|<normalized title>), 16 hex, against
//      every verdict's title-hash; a hit is a candidate for the PR body and
//      the reviewer, never a refusal.
// Pure: the caller supplies the committed verdicts/index.md and a reader for
// one verdict file, so consult reads blobs and propose reads its clone.
import { parseFrontmatter, parseVerdictsIndex, titleHash, textKey } from './okf-reindex.mjs';

const scalar = v => typeof v === 'string' ? v.trim() : '';

/** → { id, titleHash, identity, candidates, refusal } (refusal null or a message). */
export function verdictLanes(meta, indexText, readVerdict) {
  const rows = parseVerdictsIndex(indexText ?? '');
  const byId = new Map(rows.map(r => [textKey(r.id), r]));  // ids read from an untrusted index
  const id = scalar(meta?.id), reconsiders = scalar(meta?.reconsiders);
  const hash = titleHash(meta?.type, meta?.title);
  let identity = null, refusal = null;
  const known = [id, reconsiders].filter(Boolean).find(k => byId.has(textKey(k)));
  if (known) {
    const row = byId.get(textKey(known));
    let ruled = {};
    try { ruled = parseFrontmatter(readVerdict(known) ?? '').meta ?? {}; } catch { ruled = {}; }
    identity = { id: known, verdict: row.verdict, claimType: row.claimType, title: row.title, path: row.path,
      reason: scalar(ruled.reason), pr: scalar(ruled.pr), decidedBy: scalar(ruled['decided-by']), decidedOn: scalar(ruled['decided-on']),
      canonical: scalar(ruled.canonical) || null, reconsidered: !!reconsiders };
    if (row.verdict === 'rejected' && !reconsiders)
      refusal = `claim id ${known} was rejected${identity.decidedOn ? ` on ${identity.decidedOn}` : ''}${identity.pr ? ` (${identity.pr})` : ''}: ${identity.reason || 'no reason recorded'}; propose it again only with new evidence and a \`reconsiders: ${known}\` line`;
  }
  const candidates = rows.filter(r => r.titleHash === hash && r.id !== identity?.id)
    .map(r => ({ id: r.id, verdict: r.verdict, claimType: r.claimType, title: r.title, path: r.path, lane: 'title-hash' }));
  return { id: id || null, reconsiders: reconsiders || null, titleHash: hash, identity, candidates, refusal };
}
