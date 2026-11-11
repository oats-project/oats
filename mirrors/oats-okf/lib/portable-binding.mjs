import { isAbsolute, resolve } from 'node:path';
import { identifier, relPath, fail } from './io.mjs';
import { resolveNodes, validateBindings, validateDeclaration } from './config.mjs';
import { validateRepositoryLocator } from './source-contract.mjs';

export const KNOWLEDGE_CONTRACT='oats.okf.locations';
export const KNOWLEDGE_CONTRACT_VERSION=1;
/** okf 5.0.0: the bound payload (ProviderBinding1 payloadVersion) is 2: it no
 *  longer carries the 4.x harvest `execution` (runtime/model). Declarations
 *  and the normalized model stay at contract version 1. */
export const KNOWLEDGE_PAYLOAD_VERSION=2;
const candidateKinds=new Set(['workspace-default','import-adoption','operator']);
const obj=value=>value && typeof value==='object' && !Array.isArray(value);
const pointerKey=value=>String(value).replace(/~/g,'~0').replace(/\//g,'~1');
const clone=value=>JSON.parse(JSON.stringify(value));
const canonicalJson=value=>value===null || typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?`[${value.map(canonicalJson).join(',')}]`:`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
export const sameJson=(a,b)=>canonicalJson(a)===canonicalJson(b);
function keys(value,allowed,required,label) {
  if(!obj(value)) fail('E_CONFIG',`${label} must be an object`);
  for(const key of Object.keys(value)) if(!allowed.includes(key)) fail('E_CONFIG',`unknown ${label} property: ${key}`);
  for(const key of required) if(!Object.hasOwn(value,key)) fail('E_CONFIG',`${label} requires ${key}`);
  return value;
}
function bindingKey(value) {
  if(typeof value!=='string') fail('E_CONFIG','invalid knowledge binding key');
  // Reserved stores.<alias> addresses ONE legal alias; dots inside that suffix
  // are literal identity characters, never another hierarchy or fuzzy match.
  const parts=value.startsWith('stores.')?[value.slice(7)]:value.split('.');
  if(parts.some(part=>{try{identifier(part);return false;}catch{return true;}})) fail('E_CONFIG','invalid knowledge binding key');
  return value;
}
export const bindingChoiceKey=value=>{
  bindingKey(value);
  return value.startsWith('stores.')?storeChoiceKey(value.slice(7)):`/bindings/knowledge/${value.split('.').map(pointerKey).join('/')}`;
};
export const storeChoiceKey=alias=>`/bindings/knowledge/stores/${pointerKey(identifier(alias))}`;
function originAt({origins={},origin=null,pointer},suffix,kind) {
  const at=`${pointer}${suffix}`,specific=origins[at],found=specific ?? origin;
  if(!obj(found)) fail('E_CONFIG',`missing origin for ${at}`);
  return clone({...found,kind});
}

/** Portable, non-secret store locator. Filesystem existence/custody and remote
 * identity are checked later by bind/check; this function performs no I/O. */
export function validateStoreLocator(value) {
  if(!obj(value)) fail('E_CONFIG','knowledge store locator must be an object');
  identifier(value.id);
  if(value.kind==='directory') {
    keys(value,['id','kind','path'],['id','kind','path'],'directory store locator');
    if(typeof value.path!=='string' || !value.path.startsWith('path:') || !isAbsolute(value.path.slice(5)) || resolve(value.path.slice(5))!==value.path.slice(5)) fail('E_CONFIG','portable directory store requires a normalized absolute path: locator');
    return {id:value.id,kind:value.kind,path:value.path};
  } else if(value.kind==='git') {
    keys(value,['id','kind','repository','root','acceptedBranch','pr'],['id','kind','repository','root','acceptedBranch','pr'],'git store locator');
    validateRepositoryLocator(value.repository);
    relPath(value.root,true);
    if(typeof value.acceptedBranch!=='string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(value.acceptedBranch) || value.acceptedBranch.includes('..') || value.acceptedBranch.endsWith('/') || value.acceptedBranch.endsWith('.lock')) fail('E_CONFIG','invalid acceptedBranch');
    keys(value.pr,['repository'],['repository'],'git PR binding');if(typeof value.pr.repository!=='string' || !/^[\w.-]+\/[\w.-]+$/.test(value.pr.repository)) fail('E_CONFIG','git PR binding requires owner/repo');
    return {id:value.id,kind:value.kind,repository:value.repository,root:value.root,acceptedBranch:value.acceptedBranch,pr:{repository:value.pr.repository}};
  }
  fail('E_CONFIG',`unsupported knowledge store kind: ${value.kind}`);
}
function validateEnvelope(value) {
  keys(value,['contract','version','payload'],['contract','version','payload'],'knowledge declaration');
  if(value.contract!==KNOWLEDGE_CONTRACT || value.version!==KNOWLEDGE_CONTRACT_VERSION) fail('E_CONFIG',`unsupported knowledge contract: ${value.contract}@${value.version}`);
  return value.payload;
}

/** Validate the source-owned OKF payload and emit only field-level inputs for
 * the kernel's one resolver. No winner is selected here. */
export function normalizeKnowledgeDeclaration(envelope,{origins={},origin=null,pointer='/knowledge/payload'}={}) {
  const payload=validateEnvelope(envelope);
  // okf 6.0: the portable payload stays owner/stores/reads/owns (okf.json version 1);
  // a subjects declaration (version 2) is read from okf.json through the bindings-file setting.
  if(obj(payload) && Object.hasOwn(payload,'subjects')) fail('E_CONFIG','the portable knowledge binding (oats.okf.locations@1) carries okf.json version 1 owner/owns/reads only; a version-2 subjects declaration is read from the soul\'s okf.json through the bindings-file setting (oats.okf 6.0)');
  keys(payload,['owner','stores','reads','owns'],['owner','stores','reads','owns'],'OKF knowledge payload');
  const owner=identifier(payload.owner),stores={},requirements=[],candidates=[];
  if(!obj(payload.stores)) fail('E_CONFIG','knowledge stores must be an object');
  for(const [alias,spec] of Object.entries(payload.stores)) {
    identifier(alias);keys(spec,['fixed','default','inherit'],[],`knowledge store ${alias}`);
    const modes=['fixed','default','inherit'].filter(key=>Object.hasOwn(spec,key));
    if(modes.length!==1) fail('E_CONFIG',`knowledge store ${alias} needs exactly one of fixed, default or inherit`);
    const mode=modes[0],at=`/stores/${pointerKey(alias)}`,choiceKey=mode==='inherit'?bindingChoiceKey(bindingKey(spec.inherit)):storeChoiceKey(alias);
    const selectedOrigin=originAt({origins,origin,pointer},`${at}/${mode}`,mode==='default'?'soul-default':'soul-requirement');
    if(mode==='fixed') requirements.push({key:choiceKey,kind:'equals',value:validateStoreLocator(spec.fixed),origin:selectedOrigin});
    else if(mode==='default') candidates.push({key:choiceKey,kind:'soul-default',value:validateStoreLocator(spec.default),origin:selectedOrigin});
    else requirements.push({key:choiceKey,kind:'required',origin:selectedOrigin});
    stores[alias]={mode,choiceKey,origin:selectedOrigin};
  }
  if(!Array.isArray(payload.reads) || !Array.isArray(payload.owns)) fail('E_CONFIG','knowledge reads/owns must be arrays');
  const reads=[],owns=[],seenReads=new Set(),seenOwns=new Set();
  payload.reads.forEach((entry,index)=>{
    keys(entry,['store','node'],['store','node'],'knowledge read');
    const store=identifier(entry.store),node=identifier(entry.node),key=`${store}/${node}`;
    if(!Object.hasOwn(stores,store)) fail('E_CONFIG',`read references undeclared store: ${store}`);
    if(seenReads.has(key)) fail('E_CONFIG',`duplicate knowledge read: ${key}`);seenReads.add(key);
    reads.push({store,node,origin:originAt({origins,origin,pointer},`/reads/${index}`,'soul-requirement')});
  });
  payload.owns.forEach((entry,index)=>{
    keys(entry,['node','destination'],['node'],'knowledge ownership');
    const node=identifier(entry.node),destination=entry.destination===undefined?null:identifier(entry.destination);
    if(destination!==null && !Object.hasOwn(stores,destination)) fail('E_CONFIG',`owned node references undeclared destination: ${destination}`);
    const key=`${destination ?? '<write.default>'}/${node}`;
    if(seenOwns.has(key)) fail('E_CONFIG',`duplicate knowledge ownership: ${key}`);seenOwns.add(key);
    const itemOrigin=originAt({origins,origin,pointer},`/owns/${index}`,'soul-requirement');
    if(destination===null) requirements.push({key:bindingChoiceKey('write.default'),kind:'required',origin:itemOrigin});
    owns.push({node,destination,choiceKey:destination===null?bindingChoiceKey('write.default'):stores[destination].choiceKey,origin:itemOrigin});
  });
  return {contract:KNOWLEDGE_CONTRACT,version:KNOWLEDGE_CONTRACT_VERSION,owner,stores,reads,owns,requirements,candidates};
}

/** Convert already-parsed workspace/adoption/operator values to candidates.
 * This intentionally performs no precedence or recursive merging. */
export function normalizeKnowledgeBindingCandidates({bindings,kind,origins={},origin=null,pointer='/bindings'}={}) {
  if(!candidateKinds.has(kind)) fail('E_CONFIG',`invalid knowledge candidate kind: ${kind}`);
  if(!obj(bindings)) fail('E_CONFIG','knowledge bindings must be an object');
  const candidates=[];
  for(const [name,value] of Object.entries(bindings)) {
    const key=bindingChoiceKey(name),at=`/${pointerKey(name)}`;
    candidates.push({key,kind,value:validateStoreLocator(value),origin:originAt({origins,origin,pointer},at,kind)});
  }
  return candidates;
}

function selected(choices,key) {
  if(!obj(choices) || !obj(choices[key]) || !Object.hasOwn(choices[key],'value') || choices[key].value===null) fail('E_CONFIG',`unresolved knowledge binding: ${key}`);
  return validateStoreLocator(choices[key].value);
}
function runtimeStore(locator) {return locator.kind==='directory'?{...locator,path:locator.path.slice(5)}:locator;}

/** Render provider-owned nonsecret data after the kernel's shared resolver has
 * selected every field. Reads never imply a write destination. */
export function bindKnowledgeDomain({model,choices}) {
  if(!obj(model) || model.contract!==KNOWLEDGE_CONTRACT || model.version!==KNOWLEDGE_CONTRACT_VERSION) fail('E_CONFIG','invalid normalized OKF model');
  const aliases={},stores={},provenance=[];
  const add=(locator,choiceKey)=>{
    const rendered=runtimeStore(locator);
    if(Object.hasOwn(stores,locator.id) && !sameJson(stores[locator.id],rendered)) fail('E_CONFIG',`store identity ${locator.id} resolves to conflicting locations`);
    stores[locator.id]=rendered;
    const selectedBy=choices[choiceKey]?.selectedBy;if(obj(selectedBy)) provenance.push(clone(selectedBy));
    return locator.id;
  };
  for(const [alias,plan] of Object.entries(model.stores)) aliases[alias]=add(selected(choices,plan.choiceKey),plan.choiceKey);
  const reads=model.reads.map(entry=>({store:aliases[entry.store],node:entry.node}));
  const readKeys=new Set();for(const entry of reads) {const key=`${entry.store}/${entry.node}`;if(readKeys.has(key)) fail('E_CONFIG',`duplicate resolved knowledge read: ${key}`);readKeys.add(key);}
  const owns=model.owns.map(entry=>{
    const locator=entry.destination===null?selected(choices,entry.choiceKey):selected(choices,model.stores[entry.destination].choiceKey);
    const store=add(locator,entry.choiceKey);
    return {store,node:entry.node,steward:model.owner};
  });
  const ownKeys=new Set();for(const entry of owns) {const key=`${entry.store}/${entry.node}`;if(ownKeys.has(key)) fail('E_OWNER',`duplicate resolved knowledge steward: ${key}`);ownKeys.add(key);}
  for(const entry of [...model.reads,...model.owns]) provenance.push(clone(entry.origin));
  const unique=[];for(const item of provenance) if(!unique.some(prior=>sameJson(prior,item))) unique.push(item);
  return {contract:KNOWLEDGE_CONTRACT,version:KNOWLEDGE_PAYLOAD_VERSION,payload:{owner:model.owner,stores,reads,owns},credentialRefs:{},provenance:unique};
}

function absolutePath(value,label) {
  if(typeof value!=='string' || !isAbsolute(value) || resolve(value)!==value) fail('E_PATH',`${label} must be a normalized absolute path`);
  return value;
}
function boundStore(value) {
  if(!obj(value)) fail('E_CONFIG','bound knowledge store must be an object');
  const portable=value.kind==='directory'?{...value,path:`path:${value.path}`} : value;
  return runtimeStore(validateStoreLocator(portable));
}

/** Purely adapt a captured nonsecret provider domain to the existing OKF v1
 * documents. The host supplies durable custody paths; neither is derived from
 * a source home, and this function performs no filesystem access. */
export function renderKnowledgeRuntime({domain,stateDir,descriptorFile}={}) {
  keys(domain,['owner','stores','reads','owns'],['owner','stores','reads','owns'],'bound knowledge domain');
  const owner=identifier(domain.owner),bases={};
  if(!obj(domain.stores) || !Object.keys(domain.stores).length) fail('E_CONFIG','bound knowledge domain requires stores');
  for(const [alias,value] of Object.entries(domain.stores)) {
    identifier(alias);const store=boundStore(value);
    if(store.id!==alias) fail('E_ID',`runtime alias must equal stable store identity: ${alias}`);
    bases[alias]=store;
  }
  const references=(entries,label,owned=false)=>{
    if(!Array.isArray(entries)) fail('E_CONFIG',`bound knowledge ${label} must be an array`);
    return entries.map(entry=>{
      keys(entry,owned?['store','node','steward']:['store','node'],owned?['store','node','steward']:['store','node'],`bound knowledge ${label}`);
      const store=identifier(entry.store),node=identifier(entry.node);
      if(!Object.hasOwn(bases,store)) fail('E_CONFIG',`${label} references unbound store: ${store}`);
      if(owned && identifier(entry.steward)!==owner) fail('E_OWNER',`bound knowledge steward mismatch: ${store}/${node}`);
      return `${store}/${node}`;
    });
  };
  const declaration=validateDeclaration({version:1,owner,reads:references(domain.reads,'read'),owns:references(domain.owns,'ownership',true)});
  return {descriptorFile:absolutePath(descriptorFile,'OKF descriptor file'),bindings:{version:1,stateDir:absolutePath(stateDir,'OKF stateDir'),bases},declaration};
}

/** Read-only custody/accepted-base check for an already rendered capture.
 * `accepted` must come from the existing base validation path. */
export function checkKnowledgeRuntime({rendered,accepted,sourceHome,sourceWork}={}) {
  keys(rendered,['descriptorFile','bindings','declaration'],['descriptorFile','bindings','declaration'],'rendered OKF runtime');
  keys(rendered.bindings,['version','stateDir','bases'],['version','stateDir','bases'],'rendered OKF bindings');
  if(rendered.bindings.version!==1 || !obj(rendered.bindings.bases) || !Object.keys(rendered.bindings.bases).length) fail('E_CONFIG','invalid rendered OKF bindings');
  absolutePath(rendered.bindings.stateDir,'OKF stateDir');
  for(const [alias,value] of Object.entries(rendered.bindings.bases)) if(identifier(alias)!==boundStore(value).id) fail('E_ID',`runtime alias must equal stable store identity: ${alias}`);
  if(!obj(accepted)) fail('E_CONFIG','accepted OKF base metadata is required');
  const descriptorFile=absolutePath(rendered.descriptorFile,'OKF descriptor file');
  const bindings=validateBindings(rendered.bindings,descriptorFile,{sourceHome,sourceWork});
  const declaration=validateDeclaration(rendered.declaration);
  resolveNodes(declaration,bindings,accepted);
  return {descriptorFile,bindings,declaration};
}
