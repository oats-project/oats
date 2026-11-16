import { TextDecoder } from 'node:util';
import { spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { displayRepo, redactUrls } from './io.mjs';
import {
  KNOWLEDGE_CONTRACT,
  KNOWLEDGE_CONTRACT_VERSION,
  bindKnowledgeDomain,
  bindingChoiceKey,
  normalizeKnowledgeBindingCandidates,
  normalizeKnowledgeDeclaration,
  renderKnowledgeRuntime,
} from './portable-binding.mjs';
import { declaration as soulDeclaration, loadBindings, validateBindings, validateDeclaration, declarationFile, resolveNodes, resolveSubjects } from './config.mjs';
import { gitEnv, validateBase } from './stores.mjs';
import { acceptedCommit, cacheDir, usableCache, verdict } from './consult.mjs';
import { legacySettings, withoutDefaults, REMOVED_TEMPLATE } from './legacy-settings.mjs';

export const BINDING_WIRE_LIMITS=Object.freeze({bytes:1024*1024,depth:32,entries:16384});
const CAPABILITY='oats.okf',SLOT='knowledge';
const phases=new Set(['normalize','bind','check']);
const unsupportedCapturedCommands=new Set(['setup','init','migrate','unlock']);
const declarationKinds=new Set(['soul','workspace','adoption','operator']);
const errorCodes=new Set(['needs-configuration','requirement-conflict','invalid-binding','authorization-required','host-requirement-missing','provider-unavailable','provider-not-qualified']);
const obj=value=>value!==null && typeof value==='object' && !Array.isArray(value);
const wireError=code=>{throw Object.assign(new Error(code),{wireCode:code});};
// Private diagnostic marker and closed literal vocabulary. Never serialize a
// caught exception's message, supplied value, path, alias or unknown key.
const settingDiagnostic=Symbol('runtime-setting-diagnostic');
// awebai/oats-aweb#242 part 2: the one fixed wording oats.okf and oats.aweb
// share for the removed captured bindings. Release prep may change the version
// here, its one place (oats.json binding.reasons carries the reason byte-exact).
const CAPTURED_REMOVED_SINCE='oats.okf 6.1.0';
const CAPTURED_REASON=`captured bindings are not supported since ${CAPTURED_REMOVED_SINCE}; readiness takes a workspace context (oats readiness)`;
const CAPTURED_VARIABLES=Object.freeze(['OATS_BINDING_FILE','OATS_SOURCE_RECEIPT_FILE','OATS_INVOCATION_CONTEXT_FILE']);
/** One warning per captured-binding variable present in `env`, naming it and
 *  never its value: every oats.okf command and hook ignores them. */
export function ignoredCapturedVariables(env=process.env) {
  return CAPTURED_VARIABLES.filter(name=>Object.hasOwn(env,name)).map(name=>`${name} is ignored: ${CAPTURED_REASON}`);
}
const settingMessages=Object.freeze({
  'bindings-file:missing':'setting bindings-file is required (absolute host path)',
  'bindings-file:invalid':'setting bindings-file must be a normalized absolute host path',
  'state-dir:missing':'setting state-dir is required (absolute host path)',
  'state-dir:invalid':'setting state-dir must be a normalized absolute host path',
});
// okf 5.0.0: a forwarded harvest/harvest-runtime/harvest-model answers the
// same E_REMOVED sentence as the commands, rendered from the closed
// `setting:removed` template with the kernel's own origin (never a value).
const removedMessage=(settings)=>{
  const found=legacySettings({OATS_SETTINGS:JSON.stringify(settings),OATS_SETTINGS_ORIGINS:process.env.OATS_SETTINGS_ORIGINS});
  return found.length?found.map(f=>renderTemplate('setting:removed',f)).join(' '):null;
};
function settingError(reason) {
  if(!Object.hasOwn(settingMessages,reason)) wireError('invalid-binding');
  throw Object.assign(new Error('needs-configuration'),{wireCode:'needs-configuration',[settingDiagnostic]:settingMessages[reason]});
}
function removedError(message) {throw Object.assign(new Error('needs-configuration'),{wireCode:'needs-configuration',[settingDiagnostic]:message});}
function keys(value,allowed,required,label) {
  if(!obj(value)) wireError('invalid-binding');
  for(const key of Object.keys(value)) if(!allowed.includes(key)) wireError('invalid-binding');
  for(const key of required) if(!Object.hasOwn(value,key)) wireError('invalid-binding');
  return value;
}
function absolute(value) {return typeof value==='string' && isAbsolute(value) && resolve(value)===value;}

class StrictJsonParser {
  constructor(text,{depth,entries}) {this.text=text;this.maxDepth=depth;this.maxEntries=entries;this.at=0;this.entries=0;}
  whitespace() {while(/[\u0009\u000a\u000d\u0020]/.test(this.text[this.at] || '')) this.at++;}
  count() {if(++this.entries>this.maxEntries) wireError('invalid-binding');}
  string() {
    if(this.text[this.at]!=='"') wireError('invalid-binding');
    const start=this.at++;
    while(this.at<this.text.length) {
      const code=this.text.charCodeAt(this.at++);
      if(code===0x22) {try{return JSON.parse(this.text.slice(start,this.at));}catch{wireError('invalid-binding');}}
      if(code<0x20) wireError('invalid-binding');
      if(code===0x5c) {
        const escaped=this.text[this.at++];
        if(escaped==='u') {if(!/^[0-9a-fA-F]{4}$/.test(this.text.slice(this.at,this.at+4))) wireError('invalid-binding');this.at+=4;}
        else if(!'"\\/bfnrt'.includes(escaped || '')) wireError('invalid-binding');
      }
    }
    wireError('invalid-binding');
  }
  value(depth=1) {
    this.whitespace();const char=this.text[this.at];
    if(char==='"') return this.string();
    if(char==='{') {
      if(depth>this.maxDepth) wireError('invalid-binding');this.at++;this.whitespace();
      const result=Object.create(null),seen=new Set();if(this.text[this.at]==='}') {this.at++;return result;}
      while(true) {
        this.whitespace();const key=this.string();if(seen.has(key)) wireError('invalid-binding');seen.add(key);this.count();
        this.whitespace();if(this.text[this.at++]!==':') wireError('invalid-binding');result[key]=this.value(depth+1);this.whitespace();
        const next=this.text[this.at++];if(next==='}') return result;if(next!==',') wireError('invalid-binding');
      }
    }
    if(char==='[') {
      if(depth>this.maxDepth) wireError('invalid-binding');this.at++;this.whitespace();
      const result=[];if(this.text[this.at]===']') {this.at++;return result;}
      while(true) {this.count();result.push(this.value(depth+1));this.whitespace();const next=this.text[this.at++];if(next===']') return result;if(next!==',') wireError('invalid-binding');}
    }
    for(const [token,value] of [['true',true],['false',false],['null',null]]) if(this.text.startsWith(token,this.at)) {this.at+=token.length;return value;}
    const match=/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.text.slice(this.at));
    if(!match) wireError('invalid-binding');this.at+=match[0].length;const number=Number(match[0]);if(!Number.isFinite(number)) wireError('invalid-binding');return number;
  }
  parse() {this.whitespace();const value=this.value();this.whitespace();if(this.at!==this.text.length) wireError('invalid-binding');return value;}
}

export function parseBindingJson(bytes,limits=BINDING_WIRE_LIMITS) {
  if(!Buffer.isBuffer(bytes)) bytes=Buffer.from(bytes);
  if(bytes.length>limits.bytes) wireError('invalid-binding');
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{wireError('invalid-binding');}
  return new StrictJsonParser(text,limits).parse();
}

function request(value,phase) {
  keys(value,['schemaVersion','phase','slot','capability','settings','input'],['schemaVersion','phase','slot','capability','settings','input'],'binding request');
  if(value.schemaVersion!==1 || value.phase!==phase || value.slot!==SLOT || value.capability!==CAPABILITY || !obj(value.settings)) wireError('invalid-binding');
  return value;
}
function declaration(value) {
  keys(value,['kind','value','origin','origins'],['kind','value','origin','origins'],'provider declaration');
  if(!declarationKinds.has(value.kind) || !obj(value.value) || !obj(value.origin) || !obj(value.origins)) wireError('invalid-binding');
  return value;
}
function contract(value,{required=false}={}) {
  if(value===undefined) {if(required) wireError('needs-configuration');return null;}
  if(!obj(value) || value.contract!==KNOWLEDGE_CONTRACT || value.version!==KNOWLEDGE_CONTRACT_VERSION) wireError('invalid-binding');
  return value;
}
function runtimeSettings(settings) {
  if(obj(settings)) {const removed=removedMessage(settings);if(removed) removedError(removed);}
  // A 4.x manifest default is dropped; `harvest` left can only be the soul's own opt-out (off).
  settings=withoutDefaults(settings);
  keys(settings,['bindings-file','state-dir','screen-terms-file','harvest','publish'],[], 'OKF settings');
  const descriptorFile=settings['bindings-file'],stateDir=settings['state-dir'];
  for(const name of ['bindings-file','state-dir']) {
    if(settings[name]===undefined) settingError(`${name}:missing`);
    if(!absolute(settings[name])) settingError(`${name}:invalid`);
  }
  return {descriptorFile,stateDir};
}
// Shared maps contain other providers' opaque values. Ownership comes from
// this source's declared/default/required knowledge addresses, not from a value
// looking like a locator or a blanket stores.* prefix. Validate OWN values later.
function ownedBindings(bindings,ownedKeys) {
  return Object.fromEntries(Object.entries(bindings).filter(([name])=>{
    let key;try{key=bindingChoiceKey(name);}catch{return false;}
    return ownedKeys.has(key);
  }));
}
function normalizePhase(req) {
  keys(req.input,['declarations','context'],['declarations','context'],'normalize input');
  if(!Array.isArray(req.input.declarations) || !obj(req.input.context)) wireError('invalid-binding');
  const requirements=[],candidates=[],bindingInputs=[];let domain=null;
  const collect=input=>{if(!obj(input.bindings)) wireError('invalid-binding');bindingInputs.push(input);};
  for(const raw of req.input.declarations) {
    const item=declaration(raw);
    if(item.kind==='soul') {
      const envelope=contract(item.value.knowledge,{required:true});
      if(domain) wireError('requirement-conflict');
      domain=normalizeKnowledgeDeclaration(envelope,{origin:item.origin,origins:item.origins,pointer:'/knowledge/payload'});
      continue;
    }
    if(item.kind==='workspace') {
      const stores=item.value.knowledge?.stores;
      if(stores===undefined) continue;
      if(!Array.isArray(stores)) wireError('invalid-binding');
      stores.forEach((rawStore,index)=>{
        if(!obj(rawStore)) wireError('invalid-binding');
        if(rawStore.contract!==KNOWLEDGE_CONTRACT) return;
        const store=contract(rawStore);
        keys(store.payload,['bindings'],['bindings'],'workspace OKF payload');
        collect({bindings:store.payload.bindings,kind:'workspace-default',origin:item.origin,origins:item.origins,pointer:`/knowledge/stores/${index}/payload/bindings`});
      });
      continue;
    }
    if(item.value.bindings===undefined) continue;
    collect({bindings:item.value.bindings,kind:item.kind==='adoption'?'import-adoption':'operator',origin:item.origin,origins:item.origins,pointer:'/bindings'});
  }
  if(!domain) wireError('needs-configuration');
  // Collect first so declaration order cannot change who owns a binding. Keep
  // all declared addresses, including dotted aliases and explicit/implicit
  // write.default or custom inheritance; the kernel still resolves precedence.
  const ownedKeys=new Set([...domain.requirements,...domain.candidates].map(item=>item.key));
  for(const input of bindingInputs) candidates.push(...normalizeKnowledgeBindingCandidates({...input,bindings:ownedBindings(input.bindings,ownedKeys)}));
  requirements.push(...domain.requirements);candidates.unshift(...domain.candidates);
  return {requirements,candidates,model:{domain,runtime:runtimeSettings(req.settings)}};
}
function choiceMap(value) {
  if(!obj(value)) wireError('invalid-binding');
  for(const [key,choice] of Object.entries(value)) {
    if(!key.startsWith('/bindings/knowledge/') || key.includes('//') || /~(?![01])/.test(key)) wireError('invalid-binding');
    keys(choice,['value','selectedBy','constraints','considered'],['value','selectedBy','constraints','considered'],'knowledge choice');
    if(!Array.isArray(choice.constraints) || !Array.isArray(choice.considered) || (choice.selectedBy!==null && !obj(choice.selectedBy))) wireError('invalid-binding');
  }
  return value;
}
function bindPhase(req) {
  keys(req.input,['model','choices','context'],['model','choices','context'],'bind input');if(!obj(req.input.context)) wireError('invalid-binding');
  keys(req.input.model,['domain','runtime'],['domain','runtime'],'OKF binding model');
  keys(req.input.model.runtime,['stateDir','descriptorFile'],['stateDir','descriptorFile'],'OKF runtime model');
  let bound;try{bound=bindKnowledgeDomain({model:req.input.model.domain,choices:choiceMap(req.input.choices)});}catch(error){if(/unresolved knowledge binding/.test(error.message)) wireError('needs-configuration');throw error;}
  const runtime=renderKnowledgeRuntime({domain:bound.payload,...req.input.model.runtime});
  return {payloadContract:bound.contract,payloadVersion:bound.version,payload:{...bound.payload,runtime},credentialRefs:bound.credentialRefs,provenance:bound.provenance};
}
// Closed vocabulary of check-phase reasons: one fixed literal per cause, so the
// operator learns WHICH qualification failed without any value, path, alias or
// caught message reaching the wire. Every literal is also in oats.json
// binding.reasons (byte-exact) — the manifest test pins that.
const checkReasons=Object.freeze({
  'action:not-admitted':'check action is not an admitted knowledge operation',
  'settings:missing':'OKF settings missing bindings-file: set settings.oats.okf bindings-file, or deactivate oats.okf',
  'soul:missing':'OKF soul declaration missing: create okf.json for this soul, or deactivate oats.okf',
  'binding:captured':CAPTURED_REASON,
  'bindings:invalid':'OKF bindings file missing or invalid: repair configured bindings file, or deactivate oats.okf',
  'bases:too-many':'more than 64 git knowledge bases declared',
  'base:stage-failed':'declared knowledge base could not be staged from its git source',
  'base:not-validated':'declared knowledge base is not a validated knowledge tree',
  'base:owner-unmet':'knowledge base owner or remote custody requirement not met',
  'base:source-mismatch':'staged git source does not match the declared knowledge base',
  'declaration:unresolved':'declared knowledge nodes do not resolve in the accepted bases',
});
const checkReasonTemplates=Object.freeze({
  'cache-stale':'okf base <alias>: cached <cached>, accepted is now <accepted>; the next okf read refreshes it (or run `oats okf bases --fresh`)',
  'base-unreachable:warm':'okf base <alias>: <repository> unreachable; readers serve the cached <cached> fetched <fetchedAt>',
  'cache-not-primed':'okf base <alias> is not cached on this host yet: run `oats okf bases` (a spawn primes it)',
  'cache-not-validated':'okf base <alias>: cached <cached> not yet validated on this host: run `oats okf bases`',
  'base-unreachable:cold':'okf base <alias>: <repository> <acceptedBranch> unreachable (<reason>)',
  'base-unresolved':'okf base <alias>: declared node check skipped because the base is not cached',
  'setting:removed':`E_REMOVED: ${REMOVED_TEMPLATE}`,
  'base-not-primed:spawn':'okf base <alias> not primed: <reason>; run `oats okf bases`',
});
function renderTemplate(name,values={}) {
  if(!Object.hasOwn(checkReasonTemplates,name)) wireError('invalid-binding');
  return checkReasonTemplates[name].replace(/<([a-zA-Z0-9]+)>/g,(_,key)=>String(values[key] ?? ''));
}
function problem(code,reason) {
  if(reason===undefined) return {code};
  if(!Object.hasOwn(checkReasons,reason)) wireError('invalid-binding');
  return {code,message:checkReasons[reason]};
}
function templatedProblem(code,reason,values) {return {code,message:renderTemplate(reason,values)};}
function warning(code,reason,values) {return {code,message:renderTemplate(reason,values)};}
export const CHECK_REASONS=[...Object.values(checkReasons),...Object.values(checkReasonTemplates)];
export const CHECK_REASON_TEMPLATES=checkReasonTemplates;
function providerActionName(action) {
  if(action.kind==='operation' && action.slot===SLOT) return action.name;
  if(action.kind!=='command') return null;
  if(action.namespace==='okf' || action.capability===CAPABILITY) return action.name;
  if(typeof action.name==='string' && action.name.startsWith('okf:')) return action.name.slice(4);
  return null;
}
function readinessRuntime(settings,env=process.env) {
  // A ProviderBinding1 as the settings is a captured binding: never checked.
  if(settings.schemaVersion!==undefined) return {problem:problem('needs-configuration','binding:captured')};
  const removed=removedMessage(settings);if(removed) return {problem:{code:'needs-configuration',message:removed}};
  if(Object.hasOwn(settings,'bindings-file')) {
    try {
      if(typeof settings['bindings-file']!=='string' || !absolute(settings['bindings-file'])) return {problem:problem('needs-configuration','settings:missing')};
      const bindings=loadBindings(settings['bindings-file']);
      if(!env.OATS_SOUL) return {problem:problem('needs-configuration','soul:missing')};
      const decl=soulDeclaration(env.OATS_SOUL);
      return {runtime:{descriptorFile:bindings.file,bindings:{version:1,stateDir:bindings.stateDir,bases:bindings.bases},declaration:decl}};
    } catch(error) {
      const message=String(error?.message || '');
      if(error?.code==='E_CONFIG' && /okf\.json|soul has no/.test(message)) return {problem:problem('needs-configuration','soul:missing')};
      return {problem:problem('needs-configuration','bindings:invalid')};
    }
  }
  return {problem:problem('needs-configuration','settings:missing')};
}
const shortOid=oid=>String(oid||'').slice(0,12);
const firstLine=text=>String(text||'').split(/\r?\n/).map(s=>s.trim()).find(Boolean) || 'unknown error';
const PROBE_OUTPUT_LIMIT=64*1024;
function killGroup(child,signal='SIGKILL') {
  if(!child.pid) return;
  try { process.kill(-child.pid,signal); }
  catch { try { child.kill(signal); } catch { /* already gone */ } }
}
function lsRemote(base) {
  return new Promise(resolveProbe=>{
    const args=['--no-replace-objects','-c','core.hooksPath=/dev/null','-c','protocol.ext.allow=never','ls-remote','--exit-code','--',base.repository,`refs/heads/${base.acceptedBranch}`];
    const env={...gitEnv(),GIT_TERMINAL_PROMPT:'0'};
    const child=spawn('git',args,{env,stdio:['ignore','pipe','pipe'],detached:true});
    let stdout='',stderr='',settled=false;
    const finish=result=>{if(settled) return;settled=true;clearTimeout(timer);child.stdout?.destroy();child.stderr?.destroy();resolveProbe(result);};
    const timer=setTimeout(()=>{killGroup(child);finish({ok:false,error:'timed out'});},10000);
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    const collect=(which,chunk)=>{
      if(settled) return;
      if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)+Buffer.byteLength(chunk)>PROBE_OUTPUT_LIMIT) {killGroup(child);finish({ok:false,error:'git ls-remote output exceeded 64 KiB'});return;}
      if(which==='stdout') stdout+=chunk; else stderr+=chunk;
    };
    child.stdout.on('data',chunk=>collect('stdout',chunk));child.stderr.on('data',chunk=>collect('stderr',chunk));
    child.on('error',error=>finish({ok:false,error:error.message}));
    child.on('close',status=>{
      if(settled) return;
      if(status===0) {
        const oid=stdout.trim().split(/\s+/)[0];
        if(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) finish({ok:true,commit:oid});
        else finish({ok:false,error:'accepted branch did not resolve to a commit'});
      } else finish({ok:false,error:firstLine(redactUrls(stderr || stdout || `git ls-remote exited ${status}`))});
    });
  });
}
function checkError(error,stage) {
  if(error.code==='E_COMMAND') return {status:'unavailable',problem:problem('provider-unavailable')};
  if(error.code==='E_OWNER') return {status:'needs-configuration',problem:problem('provider-not-qualified','base:owner-unmet')};
  if(error.code==='E_CONFIRM') return {status:'needs-configuration',problem:problem('provider-not-qualified','base:source-mismatch')};
  if(stage==='declaration') return {status:'needs-configuration',problem:problem('needs-configuration','declaration:unresolved')};
  if(['E_BASE','E_VALIDATION','E_DIRECTORY_GIT','E_PATH','E_ID','E_CONFIG'].includes(error.code)) return {status:'needs-configuration',problem:problem('provider-not-qualified',stage==='stage'?'base:stage-failed':'base:not-validated')};
  return {status:'unavailable',problem:problem('provider-unavailable')};
}
function statusOf(problems) {
  if(problems.some(p=>p.code==='provider-unavailable')) return 'unavailable';
  if(problems.some(p=>p.code==='needs-configuration' || p.code==='provider-not-qualified')) return 'needs-configuration';
  return 'ready';
}
async function checkPhase(req) {
  keys(req.input,['context','action'],['context','action'],'check input');
  if(!obj(req.input.context) || !obj(req.input.action)) wireError('invalid-binding');
  const action=req.input.action,name=providerActionName(action);
  const prepared=readinessRuntime(req.settings);
  if(prepared.problem) return {status:'needs-configuration',problems:[prepared.problem]};
  const runtime=prepared.runtime;
  if(name && (unsupportedCapturedCommands.has(name) || name==='run-source' || name==='harvest')) return {status:'needs-configuration',problems:[problem('provider-not-qualified','action:not-admitted')]};
  if(action.kind==='hook' && action.name==='soul-scaffold') return {status:'ready',problems:[]};
  let bindings;try{bindings=validateBindings(runtime.bindings,runtime.descriptorFile);}catch{return {status:'needs-configuration',problems:[problem('needs-configuration','bindings:invalid')]};}
  const accepted={},problems=[],warnings=[],unresolved=[];
  const gitBases=Object.entries(bindings.bases).filter(([,base])=>base.kind==='git');
  if(gitBases.length>64) return {status:'unavailable',problems:[problem('provider-not-qualified','bases:too-many')]};
  const probes=new Map(await Promise.all(gitBases.map(async ([alias,base])=>[alias,await lsRemote(base)])));
  for(const [alias,base] of Object.entries(bindings.bases)) {
    if(base.kind==='directory') {
      try { const validated=validateBase(base.path,base,{reader:true});accepted[alias]={...validated.meta,subjects:validated.subjects}; }
      catch(error) { const out=checkError(error,'validate');problems.push(out.problem); }
      continue;
    }
    const cache=cacheDir(bindings,base),state=usableCache(cache,base),probe=probes.get(alias);
    if(!state) {
      unresolved.push(alias);
      if(probe?.ok) warnings.push(warning('cache-not-primed','cache-not-primed',{alias}));
      else problems.push(templatedProblem('provider-unavailable','base-unreachable:cold',{alias,repository:displayRepo(base.repository),acceptedBranch:base.acceptedBranch,reason:firstLine(probe?.error)}));
      continue;
    }
    const commit=acceptedCommit(cache,base);
    const ctx={alias,base,bindings,kind:'git',cache,commit,receipt:{base:alias,id:base.id,kind:'git',commit,fetchedAt:state.fetchedAt,stale:!!state.error,...(state.error?{reason:state.error}:{})}};
    try {
      const v=verdict(ctx,{fetchMissing:false,saveResult:false});
      if(v.ok) accepted[alias]={nodes:v.nodes,subjects:v.subjects};
      else problems.push(problem('provider-not-qualified','base:not-validated'));
    } catch(error) {
      if(error.code==='E_BASE_UNAVAILABLE' && error.step==='read') {unresolved.push(alias);warnings.push(warning('cache-not-validated','cache-not-validated',{alias,cached:shortOid(commit)}));}
      else { const out=checkError(error,'validate');problems.push(out.problem); }
    }
    if(probe?.ok) {
      if(probe.commit!==commit) warnings.push(warning('cache-stale','cache-stale',{alias,cached:shortOid(commit),accepted:shortOid(probe.commit)}));
    } else warnings.push(warning('base-unreachable','base-unreachable:warm',{alias,repository:displayRepo(base.repository),cached:shortOid(commit),fetchedAt:state.fetchedAt}));
  }
  for(const alias of unresolved) warnings.push(warning('base-unresolved','base-unresolved',{alias}));
  // The soul's declared nodes resolve in the accepted bases it can read now
  // (by the bindings' own aliases; a base not cached yet is skipped above).
  const resolvable=ref=>!unresolved.includes(ref.split('/')[0]);
  try { const decl=validateDeclaration(declarationFile(runtime.declaration));resolveNodes({...decl,owns:decl.owns.filter(resolvable),reads:decl.reads.filter(resolvable)},bindings,accepted);resolveSubjects(decl,bindings,accepted); }
  catch(error) { const out=checkError(error,'declaration');problems.push(out.problem); }
  const result={status:statusOf(problems),problems};
  if(warnings.length) result.warnings=warnings;
  return result;
}

export async function handleBindingRequest(phase,value) {
  if(!phases.has(phase)) wireError('invalid-binding');
  const req=request(value,phase);
  if(phase==='normalize') return normalizePhase(req);
  if(phase==='bind') return bindPhase(req);
  return checkPhase(req);
}
function response(phase,body) {return {schemaVersion:1,phase,slot:SLOT,capability:CAPABILITY,...body};}
function errorCode(error) {if(errorCodes.has(error?.wireCode)) return error.wireCode;if(error?.code==='E_OWNER') return 'requirement-conflict';return 'invalid-binding';}
function errorProblem(error) {
  // The private symbol is set only by settingError (closed literals) and
  // removedError (the `setting:removed` template, rendered), never by a caught message.
  const code=errorCode(error),message=error?.[settingDiagnostic];
  return {code,...(code==='needs-configuration' && typeof message==='string'?{message}:{})};
}
function enforceOutputLimits(value,depth=1,state={entries:0}) {
  if(depth>BINDING_WIRE_LIMITS.depth) wireError('provider-not-qualified');
  if(value===null || typeof value!=='object') return;
  for(const child of Array.isArray(value)?value:Object.values(value)) {
    if(++state.entries>BINDING_WIRE_LIMITS.entries) wireError('provider-not-qualified');
    enforceOutputLimits(child,depth+1,state);
  }
}
export async function runBindingWire(phase,input=process.stdin,output=process.stdout) {
  let answer;
  try {
    const chunks=[];let length=0;
    for await(const chunk of input) {const bytes=Buffer.from(chunk);length+=bytes.length;if(length>BINDING_WIRE_LIMITS.bytes) wireError('invalid-binding');chunks.push(bytes);}
    const result=await handleBindingRequest(phase,parseBindingJson(Buffer.concat(chunks,length)));
    answer=response(phase,{ok:true,result});
  } catch(error) {answer=response(phases.has(phase)?phase:'check',{ok:false,error:errorProblem(error)});}
  let bytes;
  try {enforceOutputLimits(answer);bytes=Buffer.from(JSON.stringify(answer)+'\n');if(bytes.length>BINDING_WIRE_LIMITS.bytes) wireError('provider-not-qualified');}
  catch {bytes=Buffer.from(JSON.stringify(response(phases.has(phase)?phase:'check',{ok:false,error:{code:'provider-not-qualified'}}))+'\n');}
  output.write(bytes);
  return answer.ok;
}
