import { isAbsolute } from 'node:path';
import { refuseLegacySettings, refuseKnowledgeKeys, withoutDefaults } from './legacy-settings.mjs';
import { SUBJECT_REF } from './okf-reindex.mjs';
import { fs, join, resolve, dirname, fail, readJSON, safePath, relPath, identifier, overlaps, hash, embedsCredential } from './io.mjs';
const obj = v => v && typeof v === 'object' && !Array.isArray(v);
function keys(value, allowed, label, code='E_CONFIG') {
  if(!obj(value)) fail(code, `${label} must be an object`);
  for(const key of Object.keys(value)) if(!allowed.includes(key)) fail(code, `unknown ${label} property: ${key}`);
}
export function settings() {
  refuseLegacySettings(); // okf 5.0: a forwarded harvest/harvest-runtime/harvest-model names its fix first
  refuseKnowledgeKeys(); // okf 6.0: knowledge.propose refuses; publish is only the soul's off
  // A 4.x manifest default (harvest off, harvest-runtime pi) is dropped, never a 5.0 setting;
  // `harvest` left here can only be the soul's own opt-out (off): refuseLegacySettings refused any other.
  const s = withoutDefaults(JSON.parse(process.env.OATS_SETTINGS || '{}'));
  keys(s,['bindings-file','state-dir','git-timeout','consult-max-age','screen-terms-file','harvest','publish'],'OATS_SETTINGS');
  if(s['git-timeout']!==undefined && (!Number.isInteger(s['git-timeout']) || s['git-timeout']<1)) fail('E_CONFIG','git-timeout must be a positive integer number of seconds');
  if(s['consult-max-age']!==undefined && (!Number.isInteger(s['consult-max-age']) || s['consult-max-age']<0)) fail('E_CONFIG','consult-max-age must be a non-negative integer number of seconds');
  if(s['screen-terms-file']!==undefined && (typeof s['screen-terms-file']!=='string' || !isAbsolute(s['screen-terms-file']) || resolve(s['screen-terms-file'])!==s['screen-terms-file'])) fail('E_CONFIG','screen-terms-file must be a normalized absolute path');
  if(s['state-dir']!==undefined && (typeof s['state-dir']!=='string' || !isAbsolute(s['state-dir']) || resolve(s['state-dir'])!==s['state-dir'])) fail('E_CONFIG','state-dir must be a normalized absolute path');
  return s;
}
/** Time budget for Git operations that talk to a remote (clone, fetch, push,
 *  ls-remote). Local object reads keep the short exec default. */
export function gitTimeoutMs() { return (settings()['git-timeout'] ?? 600)*1000; }
/** How old (seconds) the host cache's accepted commit may be before a consult
 *  read refetches the accepted branch; 0 fetches on every read. */
export function consultMaxAgeMs() { return (settings()['consult-max-age'] ?? 300)*1000; }
export function noGit(path) {
  for (let p = safePath(path); ; p = dirname(p)) {
    if (fs.existsSync(join(p, '.git')) || (fs.existsSync(join(p, 'HEAD')) && fs.existsSync(join(p, 'objects')) && fs.existsSync(join(p, 'refs')))) fail('E_DIRECTORY_GIT', `directory store is in Git custody: ${p}; use kind git`);
    if (dirname(p) === p) break;
  }
}
/** okf 4.2.0 removed harvest schedules; a live bindings document with the
 *  old cron/tz fields is refused with the fix. */
export const SCHEDULE_REMOVED = 'oats.okf harvests no schedule since 4.2: remove cron/tz from the bindings file, and remove each okf-<source id> job okf <= 4.1 created with oats schedule remove <id> --dir <deployment> (README#upgrading-from-41).';
export function validateBindings(doc, file, { sourceHome, sourceWork } = {}) {
  keys(doc,['version','stateDir','bases','cron','tz'],'bindings');
  if (!obj(doc) || doc.version !== 1 || !obj(doc.bases) || !Object.keys(doc.bases).length || (typeof doc.stateDir !== 'string' || !doc.stateDir)) fail('E_CONFIG', 'bindings require {version:1,stateDir,bases}');
  const legacy = ['cron','tz'].filter(key => Object.hasOwn(doc, key));
  if (legacy.length) fail('E_HARVEST_SCHEDULE_REMOVED', `${file}: ${legacy.join(' and ')} ${legacy.length > 1 ? 'are' : 'is'} no longer supported. ${SCHEDULE_REMOVED}`);
  const stateDir = safePath(resolve(dirname(file), doc.stateDir));
  const bases = {}; const ids = new Set(); const paths = [];
  for (const [alias, raw] of Object.entries(doc.bases)) {
    identifier(alias); if (!obj(raw)) fail('E_CONFIG', 'invalid base');
    const id = identifier(raw.id); if(ids.has(id)) fail('E_ID', `duplicate base identity ${id}`); ids.add(id);
    if (raw.kind === 'directory') {
      keys(raw,['id','kind','path'],'directory base');
      if(typeof raw.path !== 'string' || !raw.path || ['repository','root','acceptedBranch','pr'].some(k=>k in raw)) fail('E_CONFIG', 'directory base requires only path custody');
      const path = safePath(resolve(dirname(file), raw.path)); noGit(path);
      bases[alias] = { id, kind: 'directory', path }; paths.push(path);
      for(const artifact of [`${path}.okf-lock`,`${path}.okf-publication.json`]) if(overlaps(artifact,stateDir) || [sourceHome,sourceWork,file].filter(Boolean).some(p=>overlaps(artifact,p))) fail('E_PATH','coordination artifacts overlap state/source/bindings');
      if ([sourceHome, sourceWork].filter(Boolean).some(p=>overlaps(path,p))) fail('E_PATH', 'directory base overlaps source home/work');
    } else if (raw.kind === 'git') {
      keys(raw,['id','kind','repository','root','acceptedBranch','pr'],'git base');
      keys(raw.pr,['repository'],'git pr');
      if(typeof raw.repository !== 'string' || !raw.repository || raw.repository.startsWith('-') || /[\r\n\0]/.test(raw.repository) || 'path' in raw) fail('E_CONFIG', 'git base requires repository');
      if(embedsCredential(raw.repository)) fail('E_CONFIG', `git base "${alias}": the repository locator embeds a credential (user:token@); bind the plain URL and let a Git credential helper or SSH key supply access`);
      const root = relPath(raw.root, true);
      if (typeof raw.acceptedBranch !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(raw.acceptedBranch) || raw.acceptedBranch.includes('..') || raw.acceptedBranch.endsWith('/') || raw.acceptedBranch.endsWith('.lock')) fail('E_CONFIG','invalid acceptedBranch');
      if (!obj(raw.pr) || typeof raw.pr.repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(raw.pr.repository)) fail('E_CONFIG','git pr requires repository: owner/repo (same-repository PRs)');
      let repository = raw.repository;
      if(!/^(https:\/\/|ssh:\/\/|git@)/.test(repository)) {
        repository = safePath(resolve(dirname(file), repository));
        if(sourceHome && overlaps(repository,sourceHome) && repository.startsWith(sourceHome)) fail('E_PATH','Git locator is disposable source custody');
        if(fs.existsSync(join(repository,'.git')) && fs.lstatSync(join(repository,'.git')).isFile()) fail('E_PATH','Git repository locator is a linked worktree; bind the durable canonical repository/remote');
        paths.push(safePath(resolve(repository,root)));
      }
      bases[alias] = { id, kind:'git', repository, root, acceptedBranch:raw.acceptedBranch, pr:{repository:raw.pr.repository} };
    } else fail('E_CONFIG', `unsupported base kind ${raw.kind}`);
  }
  for (const p of paths) if (overlaps(p,stateDir)) fail('E_PATH', 'state overlaps accepted base');
  for (let i=0;i<paths.length;i++) for(let j=0;j<i;j++) if(overlaps(paths[i],paths[j])) fail('E_PATH','overlapping bases');
  const gitBases=Object.values(bases).filter(b=>b.kind==='git');
  for(let i=0;i<gitBases.length;i++) for(let j=0;j<i;j++) if(gitBases[i].repository===gitBases[j].repository && overlaps(resolve('/',gitBases[i].root),resolve('/',gitBases[j].root))) fail('E_PATH','overlapping Git base namespaces');
  for (const p of [sourceHome,sourceWork].filter(Boolean)) if(overlaps(stateDir,p)) fail('E_PATH','state overlaps source home/work');
  if(overlaps(stateDir,file) || paths.some(p=>overlaps(p,file))) fail('E_PATH','bindings document must be outside state and bases');
  return { version:1, stateDir, bases };
}
export function loadBindings(file = settings()['bindings-file'], opts = {}) {
  if(typeof file !== 'string' || !isAbsolute(file)) fail('E_CONFIG','set one absolute bindings-file; explicit provisioning/migration is required');
  safePath(file); return { file, ...validateBindings(readJSON(file),file,opts) };
}
export function declaration(soul) {
  if(fs.existsSync(join(soul,'.okf-cutover.json'))) fail('E_MIGRATION','incomplete explicit migration cutover: rerun its recorded migrate --cutover command');
  if(fs.existsSync(join(soul,'knowledge'))) fail('E_MIGRATION','legacy soul/knowledge exists: use oats okf migrate --soul <soul> to preserve and stage it, then explicit cutover; no automatic loss');
  if(!fs.existsSync(join(soul,'okf.json'))) fail('E_CONFIG',`soul has no okf.json: this soul reads/owns no knowledge yet. Provision it explicitly (oats okf init --soul <soul>, or oats okf migrate --soul <soul> for a legacy soul), or deactivate oats.okf for this soul; nothing was created`);
  return validateDeclaration(readJSON(join(soul,'okf.json')));
}
/** okf.json: version 1 `{owner, owns, reads}` (nodes) or, okf 6.0, version 2
 *  `{subjects}` (reading defaults on a base with the subject layout; no
 *  owner, owns or reads). Both normalize to `{version, owns, reads, ...}`, a
 *  v2 one with empty owns/reads, so node-based code paths see no nodes. */
export function validateDeclaration(d) {
  if(obj(d) && d.version===2) {
    keys(d,['version','subjects'],'soul declaration (version 2)');
    if(!Array.isArray(d.subjects) || !d.subjects.length || new Set(d.subjects).size!==d.subjects.length) fail('E_CONFIG','okf.json version 2 requires subjects: a non-empty unique array of <kind>/<slug> references');
    for(const ref of d.subjects) if(typeof ref!=='string' || !SUBJECT_REF.test(ref)) fail('E_CONFIG',`subject reference must be <system|workstream|project>/<slug>: ${JSON.stringify(ref)}`);
    return { version:2, subjects:[...d.subjects], owns:[], reads:[] };
  }
  keys(d,['version','owner','owns','reads'],'soul declaration');
  if(!obj(d) || d.version!==1) fail('E_CONFIG','soul/okf.json requires version:1 (owner/owns/reads) or version:2 (subjects)');
  identifier(d.owner);
  for(const key of ['owns','reads']) {
    if(!Array.isArray(d[key]) || new Set(d[key]).size !== d[key].length) fail('E_CONFIG', `${key} must be a unique array`);
    for(const ref of d[key]) splitRef(ref);
  }
  return { version:1, owner:d.owner, owns:d.owns, reads:d.reads };
}
export function splitRef(ref) {
  if(typeof ref !== 'string' || ref.split('/').length !== 2) fail('E_CONFIG', `node reference must be base/node: ${ref}`);
  return ref.split('/').map(identifier);
}
export function metadata(files, base) {
  let m; try { m=JSON.parse(Buffer.from(files['okf-base.json'],'base64').toString()); } catch { fail('E_BASE','missing/invalid accepted okf-base.json; run explicit init, never bootstrap on read'); }
  keys(m,['version','id','nodes'],'base metadata','E_BASE');
  if(!base || typeof base.id!=='string') fail('E_BASE','invalid bound base identity');
  if(!obj(m) || m.version !==1 || m.id!==base.id || !obj(m.nodes) || !Object.keys(m.nodes).length) fail('E_BASE','base identity/nodes mismatch');
  const paths=[];
  for(const [node, spec] of Object.entries(m.nodes)) {
    identifier(node); keys(spec,['path','owner'],'node','E_BASE'); identifier(spec.owner); relPath(spec.path);
    if(spec.path.split('/').some(p=>p.startsWith('.'))) fail('E_BASE','hidden node paths are not valid knowledge');
    if(paths.some(p=>overlaps(resolve('/',p),resolve('/',spec.path)))) fail('E_BASE','overlapping nodes'); paths.push(spec.path);
    if(!Object.hasOwn(files,`${spec.path}/index.md`) || !Object.hasOwn(files,`${spec.path}/log.md`)) fail('E_BASE',`missing node index/log ${node}`);
  }
  if(!files['index.md'] || !files['log.md']) fail('E_BASE','base index.md and log.md required');
  for(const p of Object.keys(files)) {
    if(p.split('/').some(part=>part.startsWith('.'))) fail('E_BASE','hidden knowledge files would evade the OKF validator');
    if(['okf-base.json','index.md','log.md'].includes(p)) continue;
    if(!p.endsWith('.md') || !paths.some(n=>p.startsWith(n+'/'))) fail('E_BASE',`file outside node knowledge: ${p}`);
  }
  return m;
}
/** A normalized declaration back to its file form (a v2 one drops the empty
 *  owns/reads it was given), for re-validation of a carried runtime. */
export const declarationFile=d=>obj(d) && d.version===2 && Array.isArray(d.owns) && !d.owns.length && Array.isArray(d.reads) && !d.reads.length && !('owner' in d) ? {version:2,subjects:d.subjects} : d;
/** okf 6.0: a version-2 declaration's subjects resolve to subject files in
 *  the accepted bases that have the subject layout (`accepted[alias].subjects`
 *  lists their refs; null on a plain base). A base not judged yet (not
 *  primed) is skipped, as resolveNodes' callers skip it. */
export function resolveSubjects(d, bindings, accepted) {
  if(d.version!==2) return;
  const all=Object.keys(bindings.bases),known=all.filter(a=>accepted[a]),layout=known.filter(a=>Array.isArray(accepted[a].subjects));
  if(!layout.length) {
    if(known.length<all.length) return;
    fail('E_CONFIG',`${known.length>1?`bases ${known.join(', ')} have`:`base ${known[0]} has`} no subject layout; declare owns/reads (version 1) or bridge the base (release note §7.2)`);
  }
  for(const ref of d.subjects) {
    const found=layout.filter(a=>accepted[a].subjects.includes(ref));
    if(found.length>1) fail('E_CONFIG',`subject ${ref} resolves in several bases (${found.join(', ')}); bind one base with the subject layout`);
    if(!found.length && known.length===all.length) fail('E_CONFIG',`unresolved subject: ${ref}`);
  }
}
export function resolveNodes(d, bindings, accepted) {
  for(const ref of [...d.owns,...d.reads]) {
    const [alias,node]=splitRef(ref);
    if(!Object.hasOwn(bindings.bases,alias) || !accepted[alias] || !Object.hasOwn(accepted[alias].nodes,node)) fail('E_CONFIG', `unresolved node: ${ref}`);
    if(d.owns.includes(ref) && accepted[alias].nodes[node].owner!==d.owner) fail('E_OWNER',`owner mismatch: ${ref}`);
  }
}
export const bindingFingerprint = b => hash({stateDir:b.stateDir,bases:b.bases});
