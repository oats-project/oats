import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { fs, join, dirname, safePath, readJSON, atomic, tree, materialize, digest, hash, withLock, exec, cleanEnv, fail, relPath, overlaps, resolve, within, redactUrls, displayRepo } from './io.mjs';
import { metadata, noGit, gitTimeoutMs } from './config.mjs';
import { isBridgedMeta, subjectOfPath } from './okf-reindex.mjs';
const validator = fileURLToPath(new URL('./okf-validate.mjs', import.meta.url));
// Never let local replace refs reinterpret frozen OIDs, including inside Git's
// transport subprocesses. Override even an explicitly supplied command env.
// History is read from the commit objects alone: a checkout's replace refs,
// grafts (info/grafts) or commit-graph file could otherwise rewrite parents,
// and so ancestry, without changing a single object. The graft file is a path
// that cannot exist: an existing one, even empty, makes Git print a warning.
export const gitEnv = (env = cleanEnv()) => ({...env,GIT_NO_REPLACE_OBJECTS:'1',GIT_GRAFT_FILE:'/dev/null/no-grafts'});
export const git = (cwd,args,opts={}) => exec('git',['--no-replace-objects','-c','core.hooksPath=/dev/null','-c','protocol.ext.allow=never','-c','core.commitGraph=false','-C',cwd,...args],{cwd,...opts,env:gitEnv(opts.env)});
function baseError(code,message,base,alias,step,reason) {throw Object.assign(new Error(redactUrls(message)),{code,base:alias,repository:displayRepo(base.repository),step,reason});}
function baseRemedy(alias) {return `fix the binding for base alias "${alias}" in the bindings file, or remove the base from the bindings`;}
function classifyGitFailure(error) {
  const text=String(error?.message || '');
  if(error?.code==='ETIMEDOUT' || /ETIMEDOUT|timed out|timeout/i.test(text)) return 'timeout';
  if(/authentication|permission denied|publickey|access denied|could not read Username|authorization|not authorized/i.test(text)) return 'auth';
  if(/not found|repository .*not exist|does not exist|no such (file|repository)|couldn't find remote ref|Repository not found/i.test(text)) return 'not-found';
  if(/could not resolve host|failed to connect|connection refused|network is unreachable|no route to host|proxy/i.test(text)) return 'network';
  return 'unknown';
}
export function unavailable(base,alias,step,error,{detail:withDetail=true}={}) {
  // withDetail false (oats okf propose): a fixed classification only, never the tool's own bytes.
  const reason=classifyGitFailure(error),detail=reason==='unknown'&&withDetail?`; original Git failure: ${redactUrls(String(error?.message || 'unknown failure'))}`:'';
  const message=`Git base "${alias}" repository "${displayRepo(base.repository)}" is required by the deployment's bindings, but ${step} failed (reason: ${reason}${detail}); ${baseRemedy(alias)}`;
  baseError('E_BASE_UNAVAILABLE',message,base,alias,step,reason);
}
export function requireNotShallow(base,alias,cwd) {
  const shallow=git(cwd,['rev-parse','--is-shallow-repository']);
  if(shallow==='true') baseError('E_BASE_SHALLOW',`Git base "${alias}" repository "${displayRepo(base.repository)}" is required by the deployment's bindings, but the repository is shallow; oats.okf requires full accepted history before staging; ${baseRemedy(alias)}`,base,alias,'clone','shallow');
}
export function preflightLocalRepository(base,alias,opts) {
  if(!base.repository.startsWith('/')) return;
  if(!fs.existsSync(base.repository)) unavailable(base,alias,'clone',Object.assign(new Error('repository not found'),{code:'ENOENT'}),opts);
  try { requireNotShallow(base,alias,base.repository); }
  catch(e) { if(e.code==='E_BASE_SHALLOW') throw e; unavailable(base,alias,'clone',e,opts); }
}
export const baseLock = b => `${b.path}.okf-lock`;
// okf consult readers hold a directory base's lock briefly; staging and
// publication queue behind them for a bounded time instead of failing.
const CONSULT_READER_WAIT_MS = 10000;
export const journalPath = b => `${b.path}.okf-publication.json`;
// okf 6.0: on a base with the subject layout, a READER (`reader: true`:
// consult's validation, spawn, readiness) tolerates the two maintainer-upkeep
// warnings: a stale (missing, orphaned) generated index and an old-node
// concept awaiting its id; it reads the committed indexes as they are and
// warns (W_INDEX_STALE). Every writer (propose, migration, publication) keeps
// the default, strict: what it writes is refused until regenerated.
const INDEX_WARNING=/: generated index is (stale|missing|orphan); run okf-reindex\.mjs$/;
const ID_WARNING=/: missing 'id' \(stamped by the maintainer at acceptance\)$/;
/** `allow(findings)` (okf 6.0, propose only) returns the findings that still
 *  refuse: a proposed claim may wait for the maintainer's id. → {..., stale:
 *  the number of generated files a reader found stale (0 unless `reader`)}. */
export function validateBase(root, base, { allow = findings => findings, reader = false } = {}) {
  const files=tree(root,{git:base.kind==='git' && base.root==='.'}); const meta=metadata(files,base);
  const result=JSON.parse(exec(process.execPath,[validator,root,'--strict','--json'],{acceptedStatus:[0,1]}));
  const tolerated=reader && result.layout==='subjects' ? result.warnings.filter(w=>INDEX_WARNING.test(w) || ID_WARNING.test(w)) : [];
  const findings=allow([...result.errors,...result.warnings.filter(w=>!tolerated.includes(w))]);
  if(findings.length) fail('E_VALIDATION', findings.join('; '));
  return {files,meta,digest:digest(files),subjects:subjectsOf(files,meta),stale:tolerated.filter(w=>INDEX_WARNING.test(w)).length};
}
/** The reader's warning for a base whose generated indexes are stale. */
export const staleWarning=(n,at)=>`W_INDEX_STALE: ${n} generated file${n===1?'':'s'} stale at ${at}; the maintainer regenerates (okf-reindex.mjs)`;
/** okf 6.0: the subject refs of a base with the subject layout (its subject
 *  files, subjects/<kind>/<slug>.md), or null for a plain base. */
export function subjectsOf(files,meta) {
  if(!isBridgedMeta(meta)) return null;
  return Object.keys(files).map(p=>subjectOfPath(p)?.ref).filter(Boolean).sort();
}
/** Git must never fetch a missing blob on its own, one round trip per object:
 *  a read of a blob the stage lacks fails instead (git 2.45+; an older git
 *  ignores the variable and fetches it). fetchBlobs fetches them in one batch. */
const noLazyFetch=()=>({...gitEnv(),GIT_NO_LAZY_FETCH:'1'});
/** Fetch the blobs among `oids` that a partial stage lacks, in ONE fetch by id. */
function fetchBlobs(cwd,oids) {
  if(!oids.length) return;
  // rev-list --missing=print reports a missing object without fetching it on
  // any git with partial clone (cat-file would fetch each one before 2.45).
  const missing=git(cwd,['rev-list','--objects','--no-object-names','--missing=print','--no-walk','--stdin'],{env:noLazyFetch(),input:oids.join('\n')+'\n'}).split('\n').filter(l=>l.startsWith('?')).map(l=>l.slice(1));
  if(!missing.length) return;
  git(cwd,['-c','fetch.negotiationAlgorithm=noop','fetch','-q','--no-tags','--no-write-fetch-head','--recurse-submodules=no','--stdin','origin'],{input:missing.join('\n')+'\n',timeout:gitTimeoutMs()});
}
/** Write a blob straight to a file descriptor: no in-memory buffer, so object
 *  size never limits what a base may hold. The remote budget applies because a
 *  partial clone fetches a missing blob on its first read. */
function writeBlob(cwd,oid,target,mode) {
  const fd=fs.openSync(target,'wx',mode);
  let result; try { result=spawnSync('git',['--no-replace-objects','-c','core.hooksPath=/dev/null','-C',cwd,'cat-file','blob',oid],{cwd,env:noLazyFetch(),timeout:gitTimeoutMs(),stdio:['ignore',fd,'pipe']}); } finally { fs.closeSync(fd); }
  if(result.error || result.status!==0) fail('E_COMMAND','Git object read failed');
  fs.chmodSync(target,mode);
}
/** A tree entry the store never materializes: outside the knowledge base root.
 *  Its absence from a staging tree is by construction; its presence is a
 *  worker's doing and is judged like any other change. */
const outsideBase=(base,p)=>!(base.root==='.' || p===base.root || p.startsWith(base.root+'/'));
function materializeGitObjects(base,dest,head) {
  immutableCommit(dest,head);
  const entries=gitTreeEntries(dest,head);
  // Preflight paths/modes before materialization. No checkout/smudge/process/
  // working-tree-encoding conversion: accepted bytes come directly from OIDs.
  for(const [p,entry] of entries) {
    relPath(p);const inBase=base.root==='.' || p===base.root || p.startsWith(base.root+'/');
    if(!['100644','100755','120000','160000'].includes(entry.mode) || (entry.mode==='160000'?entry.type!=='commit':entry.type!=='blob')) fail('E_PATH','unsupported Git tree entry');
    if(inBase && !['100644','100755'].includes(entry.mode)) fail('E_PATH','symlink or submodule in knowledge base is not allowed');
  }
  // Index/HEAD updates do not apply content filters. They preserve the normal
  // Git worktree needed by existing diff/publication guards without checkout.
  git(dest,['read-tree',head]);git(dest,['update-ref','--no-deref','HEAD',head]);
  // Only the knowledge base is materialized: the index carries the whole tree
  // for publication, but bytes outside the base root are never read, so the
  // size of the rest of the repository does not matter. The scope checks know
  // that an entry outside the root is expected to be absent (see outsideBase).
  fetchBlobs(dest,[...new Set([...entries].filter(([p])=>!outsideBase(base,p)).map(([,entry])=>entry.oid))]);
  for(const [p,entry] of entries) {
    if(outsideBase(base,p)) continue;
    // relPath above already refused traversal; containment is asserted again
    // on the resolved target before any write (okf 4.0.1 #1).
    const target=resolve(dest,p);if(target===resolve(dest) || !within(dest,target)) fail('E_PATH','Git tree entry escapes the stage');safePath(target);fs.mkdirSync(dirname(target),{recursive:true});
    writeBlob(dest,entry.oid,target,entry.mode==='100755'?0o755:0o644);
  }
}
function clone(base, dest, selectedHead, { alias = base.id } = {}) {
  safePath(dest);
  if(fs.existsSync(dest)) fail('E_PATH',`staging destination exists: ${dest}`);
  preflightLocalRepository(base,alias);
  fs.mkdirSync(dirname(dest),{recursive:true});
  // Fetch only what the store reads: the accepted branch, trees now and blobs
  // on demand. Only a remote that does not offer object filtering gets a plain
  // single-branch clone instead; any other failure is the failure it is. The
  // ancestry the publication checks walk is present either way.
  const cloneArgs=['clone','--no-local','--no-hardlinks','--no-checkout','--single-branch','--branch',base.acceptedBranch];
  try { git(dirname(dest),[...cloneArgs,'--filter=blob:none','--',base.repository,dest],{timeout:gitTimeoutMs()}); }
  catch(e) {
    if(e.code==='E_COMMAND' && /filter/i.test(e.message)) {
      fs.rmSync(dest,{recursive:true,force:true});
      try { git(dirname(dest),[...cloneArgs,'--',base.repository,dest],{timeout:gitTimeoutMs()}); }
      catch(error) { unavailable(base,alias,'clone',error); }
    } else unavailable(base,alias,'clone',e);
  }
  try { requireNotShallow(base,alias,dest); }
  catch(e) { if(e.code==='E_BASE_SHALLOW') throw e; unavailable(base,alias,'clone',e); }
  try { git(dest,['fetch','origin',`refs/heads/${base.acceptedBranch}`],{timeout:gitTimeoutMs()}); }
  catch(e) { unavailable(base,alias,'fetch',e); }
  const head=selectedHead ?? git(dest,['rev-parse','FETCH_HEAD']);
  try { requireNotShallow(base,alias,dest);verifyRemote(base,dest);materializeGitObjects(base,dest,head); }
  catch(e) { if(['E_BASE_SHALLOW','E_OWNER','E_CONFIRM','E_PATH','E_BASE','E_VALIDATION'].includes(e.code)) throw e; unavailable(base,alias,'checkout',e); }
  // Reject a linked bundle even if Git happily checked the link out.
  safePath(join(dest,base.root));
  return head;
}
export function stageBase(base, dest, { alias = base.id } = {}) {
  safePath(dest);
  if(fs.existsSync(dest)) fail('E_PATH',`staging destination exists: ${dest}`);
  const acceptedPath=base.kind==='directory'?base.path:(base.repository.startsWith('/')?resolve(base.repository,base.root):null);
  if(acceptedPath && overlaps(acceptedPath,dest)) fail('E_PATH','stage overlaps accepted base');
  if(base.kind==='git') {
    const head=clone(base,dest,undefined,{alias}); const root=join(dest,base.root);
    const validated=validateBase(root,base);
    verifyPublicationTree(base,dest,head,head,validated.files);
    return { ...validated, head, root, checkout:dest };
  }
  noGit(base.path);
  return withLock(baseLock(base),()=>{
    if(fs.existsSync(journalPath(base))) fail('E_RECOVERY',`publication pending: ${journalPath(base)}; retry its recorded run before reading`);
    const result=validateBase(base.path,base); materialize(dest,result.files);
    return {...result,root:dest};
  },{waitMs:CONSULT_READER_WAIT_MS});
}
export function allowedChanges(before, after, meta, owned) {
  const changed=[...new Set([...Object.keys(before),...Object.keys(after)])].filter(p=>before[p]!==after[p]);
  if(changed.includes('okf-base.json')) fail('E_OWNER','harvest cannot change base identity/ownership');
  const paths=owned.map(n=>meta.nodes[n]?.path || fail('E_OWNER',`unknown owned node ${n}`));
  for(const p of changed) if(!['index.md','log.md'].includes(p) && !paths.some(n=>p.startsWith(n+'/'))) fail('E_OWNER',`unauthorized touched path: ${p}`);
  // Base navigation can only gain/remove listings for this worker's nodes.
  if(changed.includes('index.md')) {
    const filter=value=>Buffer.from(value || '', 'base64').toString().split('\n').filter(l=>!paths.some(p=>l.includes(`](${p}/`) || l.includes(`](/${p}/`))).join('\n');
    if(filter(before['index.md'])!==filter(after['index.md'])) fail('E_OWNER','base index edits must be navigation for owned nodes only');
  }
  if(changed.includes('log.md')) {
    const old=Buffer.from(before['log.md']||'','base64').toString();
    const next=Buffer.from(after['log.md']||'','base64').toString();
    if(!next.includes(old)) fail('E_OWNER','base log is append/prepend-only, preserve history bytes');
  }
  return changed;
}
const INDEX_SNAPSHOT_LIMIT=16*1024*1024;
const indexFailure=()=>fail('E_INDEX','Git verification requires a stable regular self-contained index within 16 MiB');
function readVerificationIndex(source) {
  let fd;
  try {
    const before=fs.lstatSync(safePath(source),{bigint:true});
    const regular=stat=>stat.isFile() && stat.size>=0n && stat.size<=BigInt(INDEX_SNAPSHOT_LIMIT);
    const same=stat=>regular(stat) && ['dev','ino','size','mtimeNs','ctimeNs'].every(key=>stat[key]===before[key]);
    if(!regular(before) || typeof fs.constants.O_NOFOLLOW!=='number' || typeof fs.constants.O_NONBLOCK!=='number') indexFailure();
    // lstat alone races. NONBLOCK prevents a swapped FIFO from hanging open;
    // NOFOLLOW plus descriptor identity/type checks precede every byte read.
    fd=fs.openSync(source,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    if(!same(fs.fstatSync(fd,{bigint:true})) || !same(fs.lstatSync(safePath(source),{bigint:true}))) indexFailure();
    const bytes=Buffer.alloc(Number(before.size));
    for(let offset=0;offset<bytes.length;) {
      const count=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);
      if(!count) indexFailure();offset+=count;
    }
    if(!same(fs.fstatSync(fd,{bigint:true})) || !same(fs.lstatSync(safePath(source),{bigint:true}))) indexFailure();
    return bytes;
  } catch {indexFailure();}
  finally {if(fd!==undefined) fs.closeSync(fd);}
}
function withVerificationIndex(cwd,fn) {
  // Git 2.44 diff refreshes even with optional locks disabled. Use a COPY,
  // never a worker-index write/restore or the private publication index.
  const scratch=fs.mkdtempSync(join(fs.realpathSync(tmpdir()),'oats-okf-verify-index-')),owned=fs.lstatSync(scratch);
  try {
    const index=join(scratch,'index'),source=resolve(cwd,git(cwd,['rev-parse','--git-path','index']));
    fs.writeFileSync(index,readVerificationIndex(source),{flag:'wx',mode:0o600});
    const env={...cleanEnv(),GIT_INDEX_FILE:index},format=git(cwd,['rev-parse','--show-object-format']);
    if(!['sha1','sha256'].includes(format)) indexFailure();
    // Native split-index parsing freshens backing files BEFORE splitIndex=false
    // takes effect. Preflight in an EMPTY private gitdir: original sharedindex
    // files are never searched/opened, and missing dependencies refuse. Merely
    // putting a backing copy beside GIT_INDEX_FILE would not isolate that read.
    const gitdir=join(scratch,'repository');
    git(scratch,['init','--bare','--quiet','--template=',`--object-format=${format}`,gitdir]);
    try {
      const shared=git(scratch,['--no-optional-locks','-c','core.splitIndex=false','-c','core.fsmonitor=false','rev-parse','--shared-index-path'],{env:{...env,GIT_DIR:gitdir}});
      if(shared) indexFailure();
    } catch {indexFailure();}
    return fn(args=>git(cwd,['--no-optional-locks','-c','diff.autoRefreshIndex=true','-c','core.splitIndex=false',...args],{env}));
  } finally {
    const current=fs.lstatSync(scratch);
    if(!current.isDirectory() || current.dev!==owned.dev || current.ino!==owned.ino) fail('E_INDEX','Git verification scratch ownership changed; cleanup refused');
    fs.rmSync(scratch,{recursive:true,force:true});
  }
}
export function verifyGitScope(base, dest, baseline, { checkModes = true } = {}) {
  return withVerificationIndex(dest,read=>{
    // Entries outside the root are never materialized, so their absence is
    // not a deletion; a present outside file that differs still is a change.
    const names=read(['diff','--name-only','-z',baseline,'--']).split('\0').filter(Boolean).filter(p=>!(outsideBase(base,p) && !fs.existsSync(join(dest,p))));
    // A restored working file can conceal a staged, unauthorized index entry.
    names.push(...read(['diff','--cached','--name-only','-z',baseline,'--']).split('\0').filter(Boolean));
    names.push(...read(['ls-files','--others','--exclude-standard','-z']).split('\0').filter(Boolean));
    if(base.root!=='.' && names.some(p=>!p.startsWith(base.root+'/'))) fail('E_OWNER','Git worker touched files outside its knowledge base');
    // --others without exclude-standard includes ignored additions as well.
    // Unchanged code symlinks outside the base are not knowledge and need not be
    // traversed. Bundle symlinks are rejected by validateBase/tree.
    const extra=read(['ls-files','--others','-z']).split('\0').filter(Boolean);
    if(base.root!=='.' && extra.some(p=>!p.startsWith(base.root+'/'))) fail('E_OWNER','untracked/ignored file outside knowledge');
    if(checkModes) {
      // Harvest judgments authorize content, not executable-bit edits. Inspect
      // the filesystem against frozen objects, not core.fileMode or index flags.
      for(const [p,entry] of gitTreeEntries(dest,baseline)) {
        if(!['100644','100755'].includes(entry.mode)) continue;
        const path=join(dest,p);
        let stat;try {stat=fs.lstatSync(path);} catch(e) {if(e.code==='ENOENT' || e.code==='ENOTDIR') continue;throw e;}
        if(stat.isFile() && (stat.mode & 0o100 ? '100755':'100644')!==entry.mode) fail('E_OWNER',`harvest cannot change Git file mode: ${p}`);
      }
    }
    verifyRemote(base,dest);
  });
}
// Caller MUST hold the cooperative base lock. Intent is durable before journal
// installation; publishing is durable AFTER it and BEFORE the first accepted
// write. The journal is removed only after a durable accepted receipt. Thus an
// absent journal can cancel an intent, but never a write-authorized publication.
export function reconcileDirectoryIntent(base, receipt, persist) {
  if(fs.existsSync(journalPath(base))) return;
  if(receipt.status==='publication-intent') {
    receipt.status='validated'; persist();
  } else if(!['validated','staged','accepted','no-change'].includes(receipt.status)) {
    fail('E_RECOVERY','directory publication journal missing after writes were authorized; inspect and restore custody before retrying or rejudging');
  }
}
export function directoryPublish(base, proposal, receipt, persist, { afterWrite } = {}) {
  noGit(base.path);
  return withLock(baseLock(base),()=>{
    const jp=journalPath(base);
    reconcileDirectoryIntent(base,receipt,persist);
    if(receipt.status==='accepted' && !fs.existsSync(jp)) return receipt;
    const changed=[...new Set([...Object.keys(proposal.before),...Object.keys(proposal.after)])].filter(p=>proposal.before[p]!==proposal.after[p]);
    // A mount boundary cannot support our cross-directory atomic rename.
    // Detect it BEFORE journal intent or any deletion/replacement, rather than
    // leaving a partially applied publication that can only fail with EXDEV.
    const device=fs.statSync(baseLock(base)).dev;
    for(const p of changed.filter(p=>proposal.after[p]!==undefined)) {
      let parent=dirname(safePath(join(base.path,relPath(p))));
      while(!fs.existsSync(parent)) parent=dirname(parent);
      if(fs.statSync(parent).dev!==device) fail('E_PATH','directory publication targets and sibling lock must share a filesystem');
    }
    let journal;
    if(fs.existsSync(jp)) {
      journal=readJSON(jp);
      if(journal.run!==proposal.run || journal.proposalHash!==hash(proposal)) fail('E_RECOVERY',`another publication must recover first: ${jp}`);
    } else {
      const current=validateBase(base.path,base);
      if(current.digest!==digest(proposal.before)) fail('E_BASELINE','directory base changed; retain evidence and rejudge on a fresh run');
      journal={version:1,run:proposal.run,proposalHash:hash(proposal),proposalFile:proposal.file,status:'publishing'};
      receipt.status='publication-intent'; persist();
      atomic(jp,JSON.stringify(journal,null,2)+'\n',{tempDir:baseLock(base)});
    }
    if(receipt.status==='accepted') {
      // A death after receipt persistence needs only journal cleanup, never
      // another accepted write (nor a replay over unexpected newer bytes).
      const final=validateBase(base.path,base);
      if(final.digest!==digest(proposal.after) || receipt.acceptedDigest!==final.digest) fail('E_CONFIRM','accepted directory receipt differs from journalled bytes');
      fs.rmSync(jp); syncParent(jp); return receipt;
    }
    const current=tree(base.path);
    for(const p of new Set([...Object.keys(current),...Object.keys(proposal.before),...Object.keys(proposal.after)])) {
      if(current[p]!==proposal.before[p] && current[p]!==proposal.after[p]) fail('E_BASELINE',`unexpected bytes during publication recovery: ${p}`);
      if(!changed.includes(p) && current[p]!==proposal.before[p]) fail('E_BASELINE',`unchanged file differs: ${p}`);
    }
    receipt.status='publishing'; persist();
    let count=0;
    for(const p of changed) {
      const target=safePath(join(base.path,relPath(p)));
      // A previous death may follow rename/unlink but precede its directory
      // fsync. Confirm that metadata without replacing accepted bytes again.
      if(current[p]===proposal.after[p]) {syncParent(target);continue;}
      if(proposal.after[p]===undefined) { fs.rmSync(target,{force:true}); syncParent(target); }
      // The lock owns scratch files as well as owner.json. A dead-owner unlock
      // removes incomplete scratch; it never leaves temp files in the bundle.
      else atomic(target,Buffer.from(proposal.after[p],'base64'),{tempDir:baseLock(base)});
      afterWrite?.(++count); // fault injection is programmatic tests only, never an environment switch
    }
    const final=validateBase(base.path,base);
    if(final.digest!==digest(proposal.after)) fail('E_CONFIRM','directory publication confirmation differs');
    receipt.status='accepted'; receipt.acceptedDigest=final.digest; receipt.acceptedAt=new Date().toISOString(); persist();
    fs.rmSync(jp); syncParent(jp);
    return receipt;
  },{waitMs:CONSULT_READER_WAIT_MS});
}
function syncParent(p) { const fd=fs.openSync(dirname(p),'r'); try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);} }
function prRows(base,branch,cwd,{identity,allBases=false}={}) {
  const fields='number,url,state,headRefOid,baseRefName,headRefName,mergedAt,mergeCommit';
  // Once observed, a PR is addressed by repository + number, never a mutable
  // head/base filter. A missing/inaccessible identity is an error, not absence.
  if(identity) {
    if(!Number.isInteger(identity.number) || identity.number<1 || !/^https:\/\//.test(identity.url)) fail('E_RECOVERY','invalid recorded PR identity');
    const pr=JSON.parse(exec('gh',['pr','view',String(identity.number),'--repo',base.pr.repository,'--json',fields],{cwd,env:gitEnv()}));
    if(!pr || Array.isArray(pr) || typeof pr!=='object') fail('E_RECOVERY','known PR missing; reconcile custody before rejudging');
    return [pr];
  }
  const raw=exec('gh',['pr','list','--repo',base.pr.repository,'--head',branch,...(allBases?[]:['--base',base.acceptedBranch]),'--state','all','--json',fields],{cwd,env:gitEnv()});
  const rows=JSON.parse(raw); if(!Array.isArray(rows)) fail('E_PR','invalid gh PR list'); return rows;
}
// Git terminates each record it prints; a URL's own whitespace is kept, since
// a leading space turns a path into another (relative) repository.
const records=(out,terminator)=>out?out.split(terminator).slice(0,-1):[];
const remoteUrls=(cwd,remote,side)=>records(git(cwd,['remote','get-url',...(side==='push'?['--push']:[]),'--all',remote],{trim:false}),'\n');
/** The fetch and push URLs this host's Git gives the binding's repository:
 *  its global and system insteadOf/pushInsteadOf rules apply, and no clone's
 *  local config does. Asked of a throwaway repository holding only that remote. */
function hostDestinations(repository) {
  const scratch=fs.mkdtempSync(join(fs.realpathSync(tmpdir()),'oats-okf-remote-'));
  try {
    const probe=join(scratch,'probe.git');
    git(scratch,['init','--bare','--quiet','--template=',probe]);
    git(probe,['remote','add','probe','--',repository]);
    return {fetch:remoteUrls(probe,'probe','fetch'),push:remoteUrls(probe,'probe','push')};
  } finally { fs.rmSync(scratch,{recursive:true,force:true}); }
}
// The clone's origin must be the binding's repository as written, with no
// pushurl, and its effective fetch and push destinations must be the ones this
// host resolves that repository to. A host-wide URL rewrite therefore applies
// to both sides alike, while a clone-local rewrite is a redirect.
export function verifyRemote(base,cwd) {
  const refuse=detail=>fail('E_OWNER',redactUrls(`worker changed frozen Git publication remote or effective push destination: ${detail}`));
  const configured=key=>records(git(cwd,['config','-z','--get-all',key],{acceptedStatus:[0,1],trim:false}),'\0');
  // Quoted, so whitespace in a URL shows.
  const list=urls=>urls.length?urls.map(u=>JSON.stringify(u)).join(', '):'none';
  const url=configured('remote.origin.url'),pushurl=configured('remote.origin.pushurl');
  if(url.length!==1 || url[0]!==base.repository) refuse(`fetch origin is configured as ${list(url)}, not the binding's ${list([base.repository])}`);
  if(pushurl.length) refuse(`push origin has pushurl ${list(pushurl)}; the binding allows none`);
  const expected=hostDestinations(base.repository);
  for(const side of ['fetch','push']) {
    const actual=remoteUrls(cwd,'origin',side);
    if(actual.length!==expected[side].length || actual.some((u,i)=>u!==expected[side][i])) refuse(`${side} destination is ${list(actual)}, while this host resolves the binding's ${list([base.repository])} to ${list(expected[side])}`);
  }
}
function changedPaths(before,after) {
  return [...new Set([...Object.keys(before),...Object.keys(after)])].filter(p=>before[p]!==after[p]);
}
function gitTreeEntries(cwd,treeId) {
  return new Map(git(cwd,['ls-tree','-r','-z',treeId]).split('\0').filter(Boolean).map(entry=>{
    const tab=entry.indexOf('\t'),[mode,type,oid]=entry.slice(0,tab).split(' ');
    return [entry.slice(tab+1),{mode,type,oid}];
  }));
}
// Verify the REAL tree, not Git's working-tree view. Blob hashes include the
// exact bytes (no text trimming); Git filters/attributes and ignores cannot
// substitute something different from the validated proposal. Modes come only
// from the frozen baseline (new files are non-executable), never worker state.
function verifyPublicationTree(base,cwd,baseline,treeId,after,before=after) {
  const names=git(cwd,['diff-tree','--no-commit-id','--no-renames','--name-only','-r','-z',baseline,treeId,'--']).split('\0').filter(Boolean);
  if(base.root!=='.' && names.some(p=>!p.startsWith(base.root+'/'))) fail('E_OWNER','publication tree changes files outside its knowledge base');
  const format=git(cwd,['rev-parse','--show-object-format']);
  const prefix=base.root==='.'?'':base.root+'/';
  const changed=new Set(changedPaths(before,after).map(p=>prefix+p));
  if(names.some(p=>!changed.has(p))) fail('E_OWNER','publication tree changes paths outside the validated content changes');
  const baselineEntries=gitTreeEntries(cwd,baseline);
  const found=new Set();
  for(const [path,{mode,type,oid}] of gitTreeEntries(cwd,treeId)) {
    if(!path.startsWith(prefix)) continue;
    const p=path.slice(prefix.length);
    if(!Object.hasOwn(after,p) || type!=='blob' || !['100644','100755'].includes(mode)) fail('E_CONFIRM',`publication tree differs from validated proposal: ${p}`);
    if(mode!==(baselineEntries.get(path)?.mode || '100644')) fail('E_OWNER',`publication tree changes frozen Git file mode: ${p}`);
    const bytes=Buffer.from(after[p],'base64');
    const expected=createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if(oid!==expected) fail('E_CONFIRM',`publication tree bytes differ from validated proposal: ${p}`);
    found.add(p);
  }
  if(found.size!==Object.keys(after).length) fail('E_CONFIRM','publication tree omits validated proposal files (check Git ignores/attributes)');
}
function immutableCommit(cwd,oid) {
  if(typeof oid!=='string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) fail('E_CONFIRM','publication requires an immutable full commit OID');
  if(git(cwd,['cat-file','-t',oid])!=='commit') fail('E_CONFIRM','publication OID must identify a commit object, not a peelable tag');
  // Read object headers, not revision history (which can honor grafts).
  const header=git(cwd,['cat-file','commit',oid]).split('\n\n')[0].split('\n');
  return {tree:header.find(l=>l.startsWith('tree '))?.slice(5),parents:header.filter(l=>l.startsWith('parent ')).map(l=>l.slice(7))};
}
/** The tree of a base root at `commit`, or null when the commit has none. */
function rootTree(cwd,base,commit) {
  try { return git(cwd,['rev-parse','--verify','-q',base.root==='.'?`${commit}^{tree}`:`${commit}:${base.root}`]); } catch { return null; }
}
/** Whether the root of a Git base at `head` still holds the bytes judged at
 *  `stage`. A head that moved outside the root leaves the root's tree as it
 *  was; a tree that differs is staged at `head` and compared by digest, so only
 *  changed bytes (never a mode alone) count as a baseline change. */
function rootUnchanged(base,stage,cwd,head) {
  if(head===stage.head) return true;
  const before=rootTree(cwd,base,stage.head);
  if(before && before===rootTree(cwd,base,head)) return true;
  const scratch=fs.mkdtempSync(join(fs.realpathSync(tmpdir()),'oats-okf-baseline-'));
  try { clone(base,join(scratch,'base'),head);return validateBase(join(scratch,'base',base.root),base).digest===stage.digest; }
  finally { fs.rmSync(scratch,{recursive:true,force:true}); }
}
function fetchAccepted(base,cwd) {
  git(cwd,['fetch','origin',`refs/heads/${base.acceptedBranch}`],{timeout:gitTimeoutMs()});
  return git(cwd,['rev-parse','FETCH_HEAD']);
}
/** Whether `pr` is this publication's PR: its branch into the accepted
 *  branch, a real identity, and the known identity when there is one. The
 *  caller decides what its head must be. */
const prMatches=(pr,base,branch,identity)=>pr?.headRefName===branch && pr.baseRefName===base.acceptedBranch && Number.isInteger(pr.number) && pr.number>=1 && /^https:\/\//.test(pr.url) && (!identity || (pr.number===identity.number && pr.url===identity.url));
const MERGE_VERDICTS=['merge','amend+merge'],REVIEWER_ASSOCIATIONS=['OWNER','MEMBER','COLLABORATOR'];
/** The verdict of the latest okf-review comment (the knowledge-review skill's
 *  record) left on `pr` for the head it merged, by a repository member or by
 *  the account that merged it (merging proves write access; a GitHub App
 *  token's comments carry no member association): a merge verdict, or null
 *  when there is none or it is not a merge. */
function mergeVerdict(base,pr,cwd) {
  const {comments,mergedBy}=JSON.parse(exec('gh',['pr','view',String(pr.number),'--repo',base.pr.repository,'--json','comments,mergedBy'],{cwd,env:gitEnv()}));
  // gh prints an App merger as app/<name> but its comments' author as <name>;
  // a login cannot contain '/', so stripping the prefix is safe for users.
  const merger=typeof mergedBy?.login==='string' && mergedBy.login?mergedBy.login.replace(/^app\//,''):null;
  for(const comment of [...(Array.isArray(comments)?comments:[])].reverse()) {
    if(!REVIEWER_ASSOCIATIONS.includes(comment?.authorAssociation) && !(merger && comment?.author?.login===merger)) continue;
    // A body written in GitHub's web UI has CRLF line endings.
    const block=/```okf-review[ \t]*\r?\n([\s\S]*?)\r?\n```/.exec(String(comment.body || ''));
    let review;try {review=block && JSON.parse(block[1]);} catch {continue;}
    if(review?.pr===pr.url && review.headSha===pr.headRefOid) return MERGE_VERDICTS.includes(review.verdict)?review.verdict:null;
  }
  return null;
}
/** Record acceptance of the receipt's merged PR, at its merge commit. The PR
 *  was merged either at the delivered commit, or at a head the maintainer
 *  amended, which a member's okf-review merge verdict must name. Either way the
 *  merge settles the inputs: never a baseline check, never a rejudge. */
function acceptMerged(base,cwd,branch,receipt,pr,persist,acceptedHead) {
  if(!prMatches(pr,base,branch,receipt.pr)) fail('E_PR','merged PR identity/head/base could not be verified');
  const merge=pr.mergeCommit?.oid;
  if(!merge) fail('E_CONFIRM','merged PR lacks merge commit');
  let verdict=null;
  if(pr.headRefOid!==receipt.commit) {
    verdict=mergeVerdict(base,pr,cwd);
    if(!verdict) fail('E_PR',`PR ${pr.url} was merged at head ${pr.headRefOid}, not at the delivered commit ${receipt.commit}, and no okf-review verdict (merge or amend+merge) from a repository member or the account that merged it names that head; record the maintainer's verdict on the PR, then run complete again (merged inputs need no rejudgment)`);
  }
  git(cwd,['merge-base','--is-ancestor',merge,acceptedHead]);
  Object.assign(receipt,{status:'accepted',acceptedCommit:acceptedHead,mergeCommit:merge,...(verdict?{mergedHead:pr.headRefOid,verdict}:{}),acceptedAt:new Date().toISOString()});persist();
  return receipt;
}
/** Whether a PR head on `branch` is the delivered commit or descends from it
 *  (the maintainer amended on top of it), by Git ancestry on objects fetched
 *  from the publication branch, never by message text. */
function carriesDelivered(cwd,branch,commit,head) {
  if(head===commit) return true;
  if(typeof head!=='string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) return false;
  git(cwd,['fetch','--no-tags','--no-write-fetch-head','origin',`refs/heads/${branch}`],{timeout:gitTimeoutMs()});
  try {git(cwd,['merge-base','--is-ancestor',commit,head]);return true;}
  catch(e) {if(e.status===1) return false;throw e;}
}
export function gitPublish(base, stage, proposal, receipt, persist, {beforePublish=()=>{},prIdentity=receipt.pr,pr:presentation}={}) {
  const cwd=stage.checkout, branch=`okf/${proposal.attempt || proposal.run}-${base.id}`;
  verifyRemote(base,cwd);
  const baseline=immutableCommit(cwd,stage.head);
  verifyPublicationTree(base,cwd,baseline.tree,baseline.tree,proposal.before);
  // The judged root must still be accepted. A head that moved outside it is
  // delivered onto; changed root bytes are never rebased without rejudging.
  const accepted=fetchAccepted(base,cwd);
  // A PR that is merged is settled by its merge, whatever the accepted branch
  // holds now (the merge itself changes the root). Without a known identity
  // (creation uncertain), it is the one PR of this branch.
  if(receipt.commit && (prIdentity || ['pr-intent','pr-unknown'].includes(receipt.status))) {
    const rows=prRows(base,branch,cwd,prIdentity?{identity:prIdentity}:{});
    if(rows.length===1 && rows[0].mergedAt) return acceptMerged(base,cwd,branch,receipt,rows[0],persist,accepted);
  }
  if(accepted!==receipt.confirmedHead && !rootUnchanged(base,stage,cwd,accepted)) {
    // A known or uncertain previously created PR may be reconciled, but a
    // committed/pushed proposal alone does not authorize a NEW stale-base PR.
    const prior=receipt.commit?prRows(base,branch,cwd,{identity:prIdentity}).filter(p=>prMatches(p,base,branch,prIdentity) && carriesDelivered(cwd,branch,receipt.commit,p.headRefOid)):[];
    if(prior.length!==1) fail('E_BASELINE','accepted Git head changed before verified PR delivery; explicit rejudgment required');
  }
  if(!receipt.commit) {
    // Publication consumes a frozen content proposal, also on migration/retry
    // where materialization may have reset filesystem permissions. Its modes
    // are reconstructed below, not authorized by the mutable worktree.
    verifyGitScope(base,cwd,stage.head,{checkModes:false});
    if(digest(tree(stage.root,{git:base.root==='.'}))!==digest(proposal.after)) fail('E_BASELINE','staged proposal changed after validation');
    beforePublish();
    receipt.status='commit-intent'; receipt.branch=branch; receipt.parent=accepted; persist();
    const parent=immutableCommit(cwd,accepted);
    // Never trust the model's index. Start a private publication index from
    // the accepted commit it is delivered onto, and leave the worker's own index intact.
    const scratch=fs.mkdtempSync(join(dirname(proposal.file),'git-index-'));
    let treeId;
    try {
      const env={...cleanEnv(),GIT_INDEX_FILE:join(scratch,'index')};
      git(cwd,['read-tree',parent.tree],{env});
      const prefix=base.root==='.'?'':base.root+'/';
      const entries=gitTreeEntries(cwd,parent.tree);
      // Recompute the delta from validated bytes, never trust proposal.changed
      // or stage an entire directory (which also collects mode-only edits).
      for(const p of changedPaths(proposal.before,proposal.after)) {
        const path=prefix+relPath(p);
        // An ignored addition can exit 1. The exact tree check below must still
        // reject its omission; no ignore/filter failure becomes a partial PR.
        git(cwd,['--literal-pathspecs','add','--all','--chmod=-x','--',path],{env,acceptedStatus:[0,1]});
        if(Object.hasOwn(proposal.after,p) && entries.get(path)?.mode==='100755') git(cwd,['--literal-pathspecs','update-index','--chmod=+x','--',path],{env});
      }
      // A partial stage lacks the blobs outside the root: never fetch them to
      // validate the index. The tree check below proves the root's content and
      // that every entry outside it is the accepted tree's (by oid).
      treeId=git(cwd,['write-tree','--missing-ok'],{env});
      verifyPublicationTree(base,cwd,parent.tree,treeId,proposal.after,proposal.before);
    } finally {fs.rmSync(scratch,{recursive:true,force:true});}
    // Deterministic commit-tree permits replay after process death between the
    // real Git write and receipt persistence; no guessed commit or fake repository.
    const stamp=proposal.created;
    const env={...cleanEnv(),GIT_AUTHOR_NAME:'OKF harvest',GIT_AUTHOR_EMAIL:'okf@localhost',GIT_COMMITTER_NAME:'OKF harvest',GIT_COMMITTER_EMAIL:'okf@localhost',GIT_AUTHOR_DATE:stamp,GIT_COMMITTER_DATE:stamp};
    receipt.commit=git(cwd,['commit-tree',treeId,'-p',accepted,'-m',`okf-harvest: ${proposal.run}`],{env});
    receipt.status='committed'; persist();
  }
  const publication=immutableCommit(cwd,receipt.commit),parentHead=receipt.parent ?? stage.head;
  if(publication.parents.length!==1 || publication.parents[0]!==parentHead) fail('E_CONFIRM','publication commit must have exactly its recorded accepted parent');
  verifyPublicationTree(base,cwd,immutableCommit(cwd,parentHead).tree,publication.tree,proposal.after,proposal.before);
  const remoteTip=()=>git(cwd,['ls-remote','--heads','origin',`refs/heads/${branch}`],{timeout:gitTimeoutMs()}).split(/\s/)[0] || null;
  let tip=remoteTip();
  if(tip && tip!==receipt.commit) {
    // The branch moved past the delivered commit: only the maintainer's
    // amendment of the known, open PR, on top of that commit, is delivered.
    const amended=prIdentity && prRows(base,branch,cwd,{identity:prIdentity}).some(p=>p.state==='OPEN' && p.headRefOid===tip && prMatches(p,base,branch,prIdentity));
    if(!amended || !carriesDelivered(cwd,branch,receipt.commit,tip)) fail('E_PR','publication branch has unexpected commit; never force push');
  }
  if(!tip) {
    beforePublish();
    receipt.status='push-intent'; persist();
    try { verifyRemote(base,cwd);git(cwd,['push','--no-follow-tags','--recurse-submodules=no','origin',`${receipt.commit}:refs/heads/${branch}`],{timeout:gitTimeoutMs()}); }
    catch(e) { receipt.status='push-unknown'; receipt.error=e.message; persist(); throw e; }
    tip=remoteTip(); if(tip!==receipt.commit) {receipt.status='push-unknown';persist();fail('E_CONFIRM','pushed head not confirmed');}
  }
  receipt.status='pushed'; persist();
  let rows;
  try {rows=prRows(base,branch,cwd,{identity:prIdentity});} catch(e) {receipt.status='pr-unknown';receipt.error=e.message;persist();throw e;}
  if(!rows.length) {
    beforePublish();
    receipt.status='pr-intent'; persist();
    const title=presentation?.title || `okf-harvest: ${proposal.run}`,body=presentation?.body || `Knowledge-only proposal from durable OKF run ${proposal.run}. Review provenance and promotion judgment.`;
    const label=presentation?.label;
    // The label is what the review trigger watches: make sure the
    // repository has it (idempotent), then open the PR carrying it.
    if(label) try {exec('gh',['label','create',label,'--repo',base.pr.repository,'--force','--color','0E8A16','--description','OKF harvest PR (oats.okf)'],{cwd,env:gitEnv()});} catch { /* may exist already or be unmanageable; pr create reports a real problem */ }
    try { exec('gh',['pr','create','--repo',base.pr.repository,'--head',branch,'--base',base.acceptedBranch,'--title',title,'--body',body,...(label?['--label',label]:[])],{cwd,env:gitEnv()}); }
    catch(e) {receipt.status='pr-unknown';receipt.error=e.message;persist();throw e;}
    rows=prRows(base,branch,cwd);
  }
  const matching=rows.filter(p=>prMatches(p,base,branch,prIdentity) && carriesDelivered(cwd,branch,receipt.commit,p.headRefOid));
  if(matching.length!==1 || rows.length!==1) {receipt.status='pr-unknown';persist();fail('E_PR','actual PR identity/head/base could not be uniquely verified');}
  const pr=matching[0];receipt.pr=pr;receipt.status='delivered';receipt.deliveredAt ||= new Date().toISOString();persist();
  if(pr.state==='CLOSED' && !pr.mergedAt) {receipt.status='rejected';persist();fail('E_PR','PR closed without merge; retained proposal requires operator review');}
  if(pr.mergedAt) acceptMerged(base,cwd,branch,receipt,pr,persist,fetchAccepted(base,cwd));
  return receipt;
}
