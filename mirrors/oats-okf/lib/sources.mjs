// okf 5.0.0: what a working instance consults, and what its spawn checks.
// There is no source custody: no descriptor, marker, capture or worker. An
// instance consults through its soul's declaration (the kernel's OATS_SOUL)
// and the deployment's bindings, or a captured provider binding snapshot.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fs, join, safePath, readJSON, atomic, fail } from './io.mjs';
import { loadBindings, declaration, settings, validateBindings, resolveNodes, resolveSubjects } from './config.mjs';
import { short } from './consult.mjs';
import { loadInvocationKnowledgeBinding } from './binding-wire.mjs';
import { validateBase, staleWarning } from './stores.mjs';

const primeBasesScript=fileURLToPath(new URL('./prime-bases.mjs',import.meta.url));

export function service(home) {
  if(fs.existsSync(join(home,'instance.json'))) return readJSON(join(home,'instance.json')).kind==='capability';
  return process.env.OATS_KIND==='capability';
}
/** Instance knowledge (STATE.md, log.md, notes/): the instance's own working
 *  memory, and where a checkpoint's backing notes live. */
export function ensureInstanceKnowledge(home) {
  for(const [p,text] of [['STATE.md','# Working state\n\n# Task\n\n# Next\n'],['log.md','# Instance log\n']]) if(!fs.existsSync(join(home,p))) atomic(join(home,p),text);
  fs.mkdirSync(join(home,'notes'),{recursive:true});
}
const firstLine=text=>String(text||'unknown error').split(/\r?\n/).map(s=>s.trim()).find(Boolean) || 'unknown error';
function validateRefs(bindings,decl,primed={}) {
  const accepted={},referenced=refsByAlias(decl,bindings);
  for(const [alias,base] of Object.entries(bindings.bases)) if(base.kind==='directory' && Object.hasOwn(referenced,alias)) {
    const validated=validateBase(base.path,base,{reader:true});accepted[alias]={nodes:validated.meta.nodes,subjects:validated.subjects,stale:validated.stale,at:`${alias}@directory`};
  }
  for(const [alias,v] of Object.entries(primed)) {
    if(!v?.ok) fail(v?.error?.code || 'E_VALIDATION',`base "${alias}" at ${short(v?.receipt || {base:alias,kind:'git',commit:'unknown'})}: ${v?.error?.message || 'base is not a validated knowledge tree'}`);
    accepted[alias]={nodes:v.nodes,subjects:v.subjects ?? null,stale:v.stale ?? 0,at:short(v.receipt || {base:alias,kind:'git',commit:'unknown'})};
  }
  const unprimedGit=new Set(Object.entries(bindings.bases).filter(([alias,base])=>base.kind==='git' && !Object.hasOwn(primed,alias)).map(([alias])=>alias));
  const notSkipped=ref=>!unprimedGit.has(ref.split('/')[0]);
  resolveNodes({...decl,owns:decl.owns.filter(notSkipped),reads:decl.reads.filter(notSkipped)},bindings,accepted);
  resolveSubjects(decl,bindings,accepted);
  return accepted;
}
/** The bases a declaration reads: its nodes' bases (v1), or every bound base
 *  (v2: a subject may live in any base with the subject layout). */
function refsByAlias(decl,bindings) {
  const out={};
  if(decl.version===2) {for(const alias of Object.keys(bindings.bases)) out[alias]=[];return out;}
  for(const ref of [...decl.owns,...decl.reads]) {const [alias,node]=ref.split('/');(out[alias]??=[]).push(node);}
  for(const alias of Object.keys(out)) out[alias]=[...new Set(out[alias])];
  return out;
}
function primeGitBases(bindings,decl,{refreshDue=false}={}) {
  const refs=refsByAlias(decl,bindings);
  const allAliases=Object.keys(refs).filter(alias=>bindings.bases[alias]?.kind==='git');
  const aliases=allAliases.slice(0,64), skipped=allAliases.slice(64);
  if(!aliases.length) return {warnings:[],primed:{}};
  const currentSettings=settings();
  const primingSettings={...currentSettings,'git-timeout':Math.min(currentSettings['git-timeout'] ?? 20,20)};
  const result=spawnSync(process.execPath,[primeBasesScript],{input:JSON.stringify({bindings,aliases,refs,decl,refreshDue}),encoding:'utf8',timeout:25000,killSignal:'SIGTERM',env:{...process.env,OATS_SETTINGS:JSON.stringify(primingSettings)}});
  const skippedWarnings=skipped.map(alias=>`okf base ${alias} not primed: too many git bases to prime concurrently; run \`oats okf bases\``);
  const warnAll=reason=>({warnings:[...aliases.map(alias=>`okf base ${alias} not primed: ${firstLine(reason)}; run \`oats okf bases\``),...skippedWarnings],primed:{}});
  if(result.error?.code==='ETIMEDOUT') return warnAll('timed out');
  if(result.status!==0 || result.error) return warnAll(result.stderr || result.error?.message);
  let rows;try{rows=JSON.parse(result.stdout || '[]');}catch{return warnAll('invalid priming result');}
  const primed={},warnings=[];
  for(const row of rows) {
    if(row?.primed) primed[row.alias]=row;
    else warnings.push(`okf base ${row?.alias || 'unknown'} not primed: ${firstLine(row?.reason)}; run \`oats okf bases\``);
  }
  return {primed,warnings:[...warnings,...skippedWarnings]};
}
/** What an instance (or, from the deployment, its soul) consults: the soul's
 *  declaration and the deployment's bindings as they are now, or a captured
 *  provider binding snapshot (OATS_BINDING_FILE). From a deployment there is
 *  no instance home to keep apart from the bases. */
export function consultSource(home) {
  home=safePath(home);
  const work=fs.existsSync(join(home,'work'))?fs.realpathSync(join(home,'work')):join(home,'work');
  const seat=fs.existsSync(join(home,'instance.json'))?{sourceHome:home,sourceWork:work}:{};
  const invocation=loadInvocationKnowledgeBinding();
  if(invocation.kind==='captured') {
    const {file,...doc}=invocation.runtime.bindings;
    return {home,work,decl:invocation.runtime.decl,bindings:{file,...validateBindings(doc,file,seat)}};
  }
  if(!process.env.OATS_SOUL) fail('E_OATS_SOUL_MISSING','OATS_SOUL is not set; oats.okf commands run only under the OATS kernel');
  return {home,work,decl:declaration(fs.realpathSync(process.env.OATS_SOUL)),bindings:loadBindings(undefined,seat)};
}
/** The spawn's check: the soul's declared nodes resolve in the accepted bases
 *  (only owns/reads bases are primed; a usable cached commit is checked offline,
 *  with one bounded normal resolution on a due node/owner mismatch). Cold Git
 *  bases retain bounded priming; unavailable priming warns rather than refusing.
 *  Successful cached checks leave freshness to consultation. → { decl, warnings }. */
export function checkSeat(home) {
  const {decl,bindings}=consultSource(home);
  let priming=primeGitBases(bindings,decl),accepted;
  try { accepted=validateRefs(bindings,decl,priming.primed); }
  catch(e) {
    // okf 6.0: a version-2 declaration that does not resolve against the cached
    // commits gets one bounded refresh of the due caches (a base may have been
    // bridged, or a subject added, upstream since), never a fetch on success.
    if(decl.version!==2 || e.code!=='E_CONFIG') throw e;
    priming=primeGitBases(bindings,decl,{refreshDue:true});
    accepted=validateRefs(bindings,decl,priming.primed);
  }
  // okf 6.0: a base whose generated indexes are stale is read as committed,
  // with one warning per base (the maintainer regenerates).
  const stale=Object.values(accepted).filter(a=>a.stale>0).map(a=>staleWarning(a.stale,a.at));
  return {decl,bindings,accepted,warnings:[...priming.warnings,...stale],stale};
}
