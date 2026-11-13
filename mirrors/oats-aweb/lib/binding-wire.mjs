import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { querySelectedKernel } from './session-readiness.mjs';
import { custodyPreflight } from './grant-custody.mjs';
import { selectClaudeChannel, recordedStart, expectedReceive, targetReceiveAssessment, wakeDaemonAssessment, claudeChannelModeUnset, CLAUDE_CHANNEL_MODE_DEFAULT } from './wake-receive.mjs';
import { channelConnection, channelReadiness } from './claude-channel.mjs';
import { piExtensionSkillsWarning, piSkillsPackageWarning, recordedPiAgentDir } from './pi-extension.mjs';
import { grantExpiryAssessment } from './grant-expiry.mjs';
import { renewalGrantTTL, resolveGrantTTL } from './grant-duration.mjs';
import { seatGrantLabel, strayGrants, teamGrants, unrevokedGrant } from './seat-grants.mjs';
import {healthPublish, healthSettings} from './health-settings.mjs';
import { identityBooleans } from './boolean-setting.mjs';
import { retainedSeatCheck } from './retained-seat-service.mjs';
import { childOutcome } from './child-outcome.mjs';
import { residentRegistryEnv } from './resident-registry.mjs';
import { teamKeyIn } from './aweb-team-id.mjs';

export const BINDING_WIRE_LIMITS=Object.freeze({bytes:1024*1024,depth:32,entries:16384});
/** The one fixed reason for the captured-execution path, removed in this release
 *  (awebai/oats-aweb#242): a check with a `binding` or `invocation` input, normalize and
 *  bind answer it, and the hook names each variable that selected it. The version is the
 *  release that removed it; release prep sets it here. */
export const CAPTURED_UNSUPPORTED='captured bindings are not supported since oats.aweb 1.42.0; readiness takes a workspace context (oats readiness)';
const CAPABILITY='oats.aweb',SLOT='messaging';
const phases=new Set(['normalize','bind','check']);
const errorCodes=new Set(['needs-configuration','invalid-binding','provider-not-qualified']);
const TEAM_SETTING_MESSAGE='teams are not a setting since oats.aweb 1.17 / OATS 0.30: use oats teams / oats soul teams';
const AWEB_TEAM_ID_MESSAGE='aweb team ids must have shape <name>:<namespace> (name matches ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$; namespace is a hostname)';
const obj=value=>value!==null && typeof value==='object' && !Array.isArray(value);
const wireError=(code,message=code)=>{throw Object.assign(new Error(message),{wireCode:code});};
function keys(value,allowed,required) {
  if(!obj(value)) wireError('invalid-binding');
  for(const key of Object.keys(value)) if(!allowed.includes(key)) wireError('invalid-binding');
  for(const key of required) if(!Object.hasOwn(value,key)) wireError('invalid-binding');
  return value;
}

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
// The settings a check carries (check is the one phase that reads input).
function settings(value) {
  if(!obj(value)) wireError('invalid-binding');
  if(Object.hasOwn(value,'team')) wireError('needs-configuration',TEAM_SETTING_MESSAGE);
  keys(value,['delivery','claudeChannelMode','root','roots','identity','residents','join','health'],[]);
  // health.publish's refusal is carried into the readiness result (readinessDetails), so the
  // wire checks every other health setting here.
  try {healthSettings(obj(value.health)?{...value,health:{...value.health,publish:undefined}}:value);} catch {wireError('needs-configuration');}
  if(value.delivery!==undefined && !['channel','session'].includes(value.delivery)) wireError('needs-configuration');
  if(value.root!==undefined && (typeof value.root!=='string' || !value.root.trim())) wireError('needs-configuration');
  if(value.join!==undefined && typeof value.join!=='string') wireError('needs-configuration');
  if(value.roots!==undefined && !obj(value.roots)) wireError('needs-configuration');
  if(obj(value.roots)) for(const [team,root] of Object.entries(value.roots)) if(!team || typeof root!=='string' || !root.trim()) wireError('needs-configuration');
  if(value.identity!==undefined && !obj(value.identity)) wireError('needs-configuration');
  if(value.residents!==undefined && !obj(value.residents)) wireError('needs-configuration');
  if(obj(value.residents)) for(const [name,custody] of Object.entries(value.residents)) if(!name || typeof custody!=='string' || !custody.trim()) wireError('needs-configuration');
  return value;
}
function request(value,phase) {
  keys(value,['schemaVersion','phase','slot','capability','settings','input'],['schemaVersion','phase','slot','capability','settings','input']);
  if(value.schemaVersion!==1 || value.phase!==phase || value.slot!==SLOT || value.capability!==CAPABILITY) wireError('invalid-binding');
  settings(value.settings);return value;
}
function checkProblems(problems) {return problems.length?{status:'needs-configuration',problems}:null;}
function workspaceReadinessContext(value) {
  keys(value,['kind','workspace','deployment','soul','team','instance','home'],['kind','workspace','deployment','soul']);
  if(value.kind!=='workspace' || typeof value.workspace!=='string' || !value.workspace.trim() || typeof value.deployment!=='string' || !value.deployment.trim() || typeof value.soul!=='string' || !value.soul.trim()) wireError('invalid-binding');
  if(value.team!==null && value.team!==undefined && (typeof value.team!=='string' || !value.team.trim())) wireError('invalid-binding');
  if(value.instance!==null && value.instance!==undefined && (typeof value.instance!=='string' || !value.instance.trim())) wireError('invalid-binding');
  if(value.home!==null && value.home!==undefined && (typeof value.home!=='string' || !value.home.trim())) wireError('invalid-binding');
  return value;
}
export function yamlScalar(text,key){const m=String(text).match(new RegExp(`^${key}:\\s*["']?([^"'\\n#]+)["']?\\s*$`,'m'));return m?m[1].trim():undefined;}
export { AW_MIN } from './aw-floor.mjs';
import { AW_MIN, awNewerThanTestedMessage, parseVersion, versionAtLeast } from './aw-floor.mjs';
export const NO_TEAMS_MESSAGE='no teams configured: run `oats aweb setup`';
/** The default team has a label but no provider id. The remedy names both forms of a new default, since a
 *  workspace without `localTeams: true` refuses `oats teams default` (team model 3). */
export const unmappedDefaultMessage=(label)=>`the default team ${label} has no provider id yet: its owner runs oats aweb setup, then commits the id, or choose another default: \`oats teams default <label>\`, or \`defaultTeam:\` in oats-workspace.yaml when the workspace doesn't allow local teams`;
// The version token after `aw`: while output streams in, only a token something
// has followed is complete (`aw 1.36.53` may still grow `-rc.3`); at close the
// end of the text completes it too.
const AW_VERSION_STREAM_RE=/aw\s+v?(\d[0-9A-Za-z.+-]*)(?=[^0-9A-Za-z.+-])/;
const AW_VERSION_RE=/aw\s+v?(\d[0-9A-Za-z.+-]*)(?![0-9A-Za-z.+-])/;
const versionToken=(re,text) => {const m=re.exec(text);return m && (parseVersion(m[1]) ? m[1] : undefined);};
/** The installed aw version ("x.y.z", with its pre-release if any), or undefined when it cannot be read.
 *  `aw version` prints its version line first and then makes a blocking update
 *  check against GitHub (aw 1.36.17 cmd/aw/root.go versionCmd, which ignores
 *  AW_NO_UPDATE_CHECK), so the reader resolves once the version token is
 *  complete and kills the child instead of waiting for it. A token that isn't
 *  semver is unreadable. The ceiling still bounds a child
 *  that never prints; a child that exits without a match is unreadable. The
 *  promise settles only after the child has exited, so no aw is left behind. */
export function readAwVersion({timeout=10000,env=process.env}={}) {
  return new Promise((settle) => {
    const childEnv={...env,AW_NO_UPDATE_CHECK:'1'};delete childEnv.AWEB_IDENTITY_HOME;
    if(!(timeout>0)){settle(undefined);return;} // no time left to ask: unreadable, nothing started
    let child,text='',answer,decided=false,exited=false,timer;
    // 'exit' can precede the last stdout chunk, so only 'close' judges the
    // output of a child that ended on its own; a decided read waits for 'exit'.
    const decide=(value) => {if(decided) return;decided=true;answer=value;clearTimeout(timer);if(exited) settle(answer);else child.kill('SIGKILL');};
    try {child=spawn('aw',['version'],{env:childEnv,stdio:['ignore','pipe','ignore']});} catch {settle(undefined);return;}
    timer=setTimeout(() => decide(undefined),timeout);
    child.on('error',() => {exited=true;decide(undefined);settle(answer);});
    child.on('exit',() => {exited=true;if(decided) settle(answer);});
    child.on('close',() => decide(versionToken(AW_VERSION_RE,text)||undefined));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',(chunk) => {text=(text+chunk).slice(-4096);const v=versionToken(AW_VERSION_STREAM_RE,text);if(v!==null) decide(v);});
  });
}
const CLASSIC_REFUSAL = 'oats.aweb 1.14 needs OATS 0.26.0 or newer (workspace model); on an older kernel pin oats.aweb v1.13.x';
function classicEnv(env=process.env) {return !!env.OATS_TEAM_SCOPE && !(env.OATS_WORKSPACE_KEY || env.OATS_WORKSPACE_NAME || env.OATS_DEFAULT_TEAM);}
export function grantYamlCustodySocket(text) {
  const lines=String(text??'').split(/\r?\n/);let inCustody=false,baseIndent=0;
  for(const line of lines) {
    const custody=/^(\s*)custody:\s*(?:#.*)?$/.exec(line);if(custody){inCustody=true;baseIndent=custody[1].length;continue;}
    if(inCustody){const ind=/^(\s*)/.exec(line)?.[1].length||0;if(line.trim()&&ind<=baseIndent)inCustody=false;const socket=/^\s*socket_path:\s*["']?([^"'\n#]+)["']?\s*$/.exec(line);if(socket)return socket[1].trim();}
  }
  return undefined;
}
function grantAttachmentProblem(home) {
  const grantHome=home?recordedStart(home).meta?.identity?.grant?.home:null;
  if(typeof grantHome!=='string' || !isAbsolute(grantHome)) return null;
  const grantYaml=join(grantHome,'grant.yaml');
  if(!existsSync(grantYaml)) return null;
  let text;try{text=readFileSync(grantYaml,'utf8');}catch{return null;}
  if(grantYamlCustodySocket(text)) return null;
  const id=yamlScalar(text,'grant_id')||'<unknown>';
  return {code:'custody',message:`grant ${id} is not attached to custody; retire and respawn on aw >= ${AW_MIN}`};
}
function activeTeamAt(root){try{const text=readFileSync(join(resolve(root),'.aw','teams.yaml'),'utf8');return yamlScalar(text,'active_team')||yamlScalar(text,'active');}catch{return undefined;}}
function residentCustodyRoot(settings){const identity=obj(settings.identity)?settings.identity:{},residents=obj(settings.residents)?settings.residents:{};const name=typeof identity.resident==='string'?identity.resident:'';const root=name&&typeof residents[name]==='string'?residents[name]:undefined;return identity.mode==='global'&&root&&isAbsolute(root)?root:undefined;}
function teamFromSettings(settings,candidate,{env=process.env}={}) {
  return typeof env.OATS_DEFAULT_TEAM_ID==='string' && env.OATS_DEFAULT_TEAM_ID.trim()?env.OATS_DEFAULT_TEAM_ID.trim():undefined;
}
function rootCandidate(settings,team,{deployment,env=process.env}={}) {
  const roots=obj(settings.roots)?settings.roots:{};
  const key=team?teamKeyIn(roots,team):undefined;
  if(key!==undefined && typeof roots[key]==='string' && roots[key].trim()) return {root:roots[key].trim(),key:`settings.oats.aweb.roots[${JSON.stringify(key)}]`,declared:true};
  if(typeof settings.root==='string' && settings.root.trim()) return {root:settings.root.trim(),key:'settings.oats.aweb.root',declared:true};
  const candidates=[env.OATS_WORKSPACE || deployment || process.cwd()];
  for(const root of candidates) if(isAbsolute(root) && existsSync(join(resolve(root),'.aw'))) return {root,key:'settings.oats.aweb.root',declared:false};
  return {root:candidates[0] || process.cwd(),key:'settings.oats.aweb.root',declared:false};
}
/** The service a root's `.aw/workspace.yaml` names (`aweb_url`), read only to
 *  classify it, never shown: a valid URL the invite's disclosure filter rejects
 *  (IPv6, an IDN, a trailing comment) is still a service. undefined when the
 *  root names none or can't be read; aw's default service is the Cloud. */
function rootServiceForClassification(root) {
  let text;
  try { text=readFileSync(join(root,'.aw','workspace.yaml'),'utf8'); } catch { return undefined; }
  const m=/^aweb_url:[ \t]*(.*)$/m.exec(text);
  if(!m) return undefined;
  let value=m[1].replace(/\s+#.*$/,'').trim();
  if(/^(["']).*\1$/.test(value)) value=value.slice(1,-1).trim();
  return value || undefined;
}
/** The aw-newer-than-tested warning for a home, or undefined. Decided by the
 *  home's own team roots (roots[team], as each minting root is chosen), not the
 *  deployment's default root, so readiness and every spawn mode agree: the
 *  default team's, and any `joinTeams` a spawn also mints into. One warning,
 *  whichever root is off the Cloud. */
export function awTestedWarning(settings,version,{deployment,env=process.env,joinTeams=[]}={}) {
  for(const team of [teamFromSettings(settings,null,{env}),...joinTeams]) {
    const {root}=rootCandidate(settings,team,{deployment,env});
    const message=root && isAbsolute(root) ? awNewerThanTestedMessage(version,rootServiceForClassification(root)) : undefined;
    if(message) return message;
  }
  return undefined;
}
function validHostname(value){const s=String(value||'');return s.length<=253&&s.split('.').every(label=>/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));}
function validAwebTeamId(value){const m=/^([A-Za-z0-9][A-Za-z0-9._-]{0,127}):([^:]+)$/.exec(String(value||''));return !!m&&validHostname(m[2]);}
function invalidAwebTeamId(env=process.env){const id=typeof env.OATS_DEFAULT_TEAM_ID==='string'&&env.OATS_DEFAULT_TEAM_ID.trim()?env.OATS_DEFAULT_TEAM_ID.trim():null;if(id&&!validAwebTeamId(id))return id;try{const rows=JSON.parse(env.OATS_TEAMS||'[]');if(Array.isArray(rows))for(const r of rows)if(r&&typeof r.team==='string'&&r.team.trim()&&!validAwebTeamId(r.team.trim()))return r.team.trim();}catch{}return null;}
function parseOatsTeams(env=process.env){try{const rows=JSON.parse(env.OATS_TEAMS||'[]');return Array.isArray(rows)?rows.filter(r=>r&&typeof r==='object').map(r=>({label:String(r.label||''),team:typeof r.team==='string'?r.team:null,default:r.default===true,from:r.from==='shared'?'shared':'local'})):[];}catch{return [];}}
function primaryTeamLabel(env=process.env){return typeof env.OATS_DEFAULT_TEAM==='string'&&env.OATS_DEFAULT_TEAM.trim()?env.OATS_DEFAULT_TEAM.trim():null;}
function unmappedPrimary(env=process.env){return undefined;}

/** Whether readiness requires a minting root: a global seat with a resident
 *  acts through that resident's grant, so it needs none (whether the resident
 *  resolves is the custody check's). Both the workspace readiness phase and the
 *  binding path ask this through readinessDetails. */
function needsMintingRoot(settings) {
  const identity=obj(settings.identity)?settings.identity:{};
  return !(identity.mode==='global' && typeof identity.resident==='string' && identity.resident.trim());
}
/** retainedSeat: a soul-scope retained seat (identity.source), whose spawn mints nothing and
 *  takes its team from the seat's own predicate (retainedSeatCheck), so neither the messaging
 *  root nor the generic no-team problem applies; the caller reports the seat's own refusal. */
async function readinessDetails(settings,{deployment,env=process.env,retainedSeat=false}={}) {
  try { selectClaudeChannel(settings.claudeChannelMode); }
  catch (error) { return {team:undefined,candidate:null,warnings:[],result:{status:'needs-configuration',problems:[{code:'needs-configuration',message:error.message}]}}; }
  // The refusal spawn and start, or the health commands, give for a boolean setting that is
  // neither a boolean nor its string.
  try { identityBooleans(obj(settings.identity)?settings.identity:{}); healthPublish(settings); }
  catch (error) { return {team:undefined,candidate:null,warnings:[],result:{status:'needs-configuration',problems:[{code:'needs-configuration',message:error.message}]}}; }
  if(classicEnv(env)) return {team:undefined,candidate:null,warnings:[],result:{status:'needs-configuration',problems:[{code:'needs-configuration',message:CLASSIC_REFUSAL}]}};
  const invalidTeam=invalidAwebTeamId(env);if(invalidTeam)return {team:undefined,candidate:null,warnings:[],result:{status:'needs-configuration',problems:[{code:'needs-configuration',message:AWEB_TEAM_ID_MESSAGE}]}};
  const team=teamFromSettings(settings,null,{env}),candidate=rootCandidate(settings,team,{deployment,env}),problems=[],warnings=[];
  const aw=await awFloorObservation();if(aw.message) problems.push({code:'needs-configuration',message:aw.message});
  const tested=aw.message?undefined:awTestedWarning(settings,aw.version,{deployment,env});
  if(tested) warnings.push({code:'aw-newer-than-tested',message:tested});
  if(!team && !retainedSeat) {
    const label=typeof env.OATS_DEFAULT_TEAM==='string'&&env.OATS_DEFAULT_TEAM.trim()?env.OATS_DEFAULT_TEAM.trim():'';
    problems.push({code:'needs-configuration',message:label?unmappedDefaultMessage(label):NO_TEAMS_MESSAGE});
  }
  if(!retainedSeat && needsMintingRoot(settings) && (!candidate.root || !isAbsolute(candidate.root) || !existsSync(join(resolve(candidate.root),'.aw')))) problems.push({code:'needs-configuration',message:`no messaging root at ${candidate.root?resolve(candidate.root):process.cwd()}: run oats aweb setup there or set ${candidate.key}`});
  return {team,candidate,awVersion:aw.version,warnings,result:checkProblems(problems) || {status:'ready',problems:[]}};
}
function runAw(argv,cwd,{unsetEnv=[],timeout=60000}={}) {
  // An inherited AWEB_IDENTITY_HOME is the caller's identity, never this check's.
  const env={...process.env,AW_NO_UPDATE_CHECK:'1'};delete env.AWEB_IDENTITY_HOME;for(const name of unsetEnv) delete env[name];
  try {return execFileSync(argv[0],argv.slice(1),{cwd,env,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout}).trim();}
  catch(e) {throw new Error(`${argv.slice(0,3).join(' ')} ${childOutcome(e,timeout)}`);}
}
/** The first executable `cmd` on env's PATH, as an absolute path, or undefined. */
export function onPath(cmd,env=process.env){for(const dir of String(env.PATH||'').split(delimiter)){if(!dir)continue;try{const p=resolve(join(dir,cmd));const st=statSync(p);if(st.isFile()&&(st.mode&0o111))return p;}catch{}}return undefined;}
const AW_INSTALL_COMMAND=`\`npm i -g @awebai/aw@latest\` (or \`npm i -g @awebai/aw@${AW_MIN}\`)`;
/** The aw on PATH against AW_MIN: `{version, message}`, where message says why
 *  it falls short and is undefined when it doesn't. */
export async function awFloorObservation({env=process.env,timeout}={}) {
  if(!onPath('aw',env)) return {message:`aw CLI not on PATH; install aw >= ${AW_MIN} with ${AW_INSTALL_COMMAND}`};
  const version=await readAwVersion({env,...(timeout===undefined?{}:{timeout})});
  if(!version) return {message:`aw version could not be read; install aw >= ${AW_MIN} with ${AW_INSTALL_COMMAND}`};
  return {version,message:!versionAtLeast(version,AW_MIN)?`aw ${version} is older than required ${AW_MIN}; upgrade with ${AW_INSTALL_COMMAND}`:undefined};
}
/** Why the aw on PATH does not meet AW_MIN, or undefined when it does: the one
 *  wording every path that refuses below the floor uses. `env` is the PATH to
 *  search and the environment `aw version` runs in. */
export async function awFloorMessage(options){return (await awFloorObservation(options)).message;}
/** Whether these soul-scope settings join a team: a non-empty `join`. */
function soulJoinsTeams(settings) {return typeof settings.join==='string' && settings.join.split(',').some(label=>label.trim());}
/** The kernel's captured per-leaf settings origins for a home (JSON pointer to
 *  {kind,at}); anything unparseable is no origin. */
function settingsOrigins(env) {try {const origins=JSON.parse(env.OATS_SETTINGS_ORIGINS??'');return obj(origins)?origins:undefined;} catch {return undefined;}}
/** Whether the deployment publishes health now: the soul's current oats.aweb
 *  `health.publish`, the setting `oats aweb health publish` reads before it
 *  counts unread mail each minute. False when the kernel can't say, or can't
 *  say before the phase's deadline. */
// The kernel's resolved view, never oats-local.yaml read here: layering is the resolver's, and the observer reads its payload.
export function healthPublishesNow(ctx,env,deadline) {
  const left=Math.min(10000,deadline-Date.now());
  if(left<1) return false;
  try {
    const doc=querySelectedKernel(['inspect','--soul',ctx.soul,'--dir',ctx.deployment,'--json'],{env,cwd:ctx.deployment,timeout:left});
    const rows=doc?.ok===true && Array.isArray(doc.result?.capabilities)?doc.result.capabilities.filter(c=>c?.id==='oats.aweb'):[];
    return rows.length===1 && obj(rows[0].settings) && healthSettings(rows[0].settings).publish;
  } catch {return false;}
}
async function workspaceReadinessPhase(req,{env=process.env}={}) {
  // Phase-start clock bounds the calls and judges the already-recorded grant.
  const now=Date.now(),deadline=now+28000;
  const localAw=(argv,cwd)=>runAw(argv,cwd,{timeout:Math.max(1,Math.min(5000,deadline-Date.now()))});
  const ctx=workspaceReadinessContext(req.input.context);
  if(!obj(req.input.action) || req.input.action.kind!=='readiness') wireError('invalid-binding');
  const identity=obj(req.settings.identity)?req.settings.identity:{},mode=identity.mode===undefined || identity.mode===null || identity.mode===''?'local':String(identity.mode);
  // A retained seat's spawn (identity.source, a local identity) refuses before any effect on
  // what the settings and the source decide; soul scope reports the same refusal from the same
  // predicate. A seated home's start does not read the source again, so home scope does not.
  const retainedSoul=!ctx.home && mode==='local' && !!identity.source;
  const details=await readinessDetails(req.settings,{deployment:ctx.deployment,retainedSeat:retainedSoul}),problems=[...details.result.problems],warnings=[...details.warnings];
  // Soul scope has no captured harness: only explicit session delivery proves
  // that its primary will use the broker. Home scope uses expectedReceive's
  // captured runtime/delivery (including Codex on channel settings).
  let primaryBroker = !ctx.home && req.settings.delivery === 'session';
  if(retainedSoul) {
    const seat=retainedSeatCheck(identity.source,env);
    if(seat.refusal) problems.push({code:'needs-configuration',message:seat.refusal});
  }
  if(mode==='global') {
    const grantProblem=grantAttachmentProblem(ctx.home);if(grantProblem) problems.push(grantProblem);
    const resident=typeof identity.resident==='string' && identity.resident.trim()?identity.resident.trim():undefined;
    const residents=obj(req.settings.residents)?req.settings.residents:{};
    const custody=resident?residents[resident]:undefined;
    if(!resident) problems.push({code:'custody',message:'identity.mode "global" requires identity.resident; set oats-local.yaml settings.oats.aweb.residents.<name> to the absolute custody directory for that resident identity'});
    else if(typeof custody!=='string' || !isAbsolute(custody) || !existsSync(join(custody,'.aw','identity.yaml'))) problems.push({code:'custody',message:`identity.mode "global" resident ${JSON.stringify(resident)} is not resolvable; set oats-local.yaml settings.oats.aweb.residents.${resident} to an absolute custody directory whose .aw/identity.yaml exists`});
    else {
      const registry=residentRegistryEnv(custody);
      if(registry.problem) problems.push({code:'custody',message:registry.problem});
      if(details.team) {
        try {
          // A never-grant in use, or the next mint's ttl (a renewal keeps the seat's
          // duration; a new seat's default is never), decides the custody's ops.
          const recorded=ctx.home?recordedStart(ctx.home).meta?.identity?.grant:undefined;
          const next=recorded?.id?renewalGrantTTL(identity.ttl,recorded.ttl):resolveGrantTTL(identity.ttl);
          const preflight=custodyPreflight({custody,resident,team:details.team,e2eeRequired:identityBooleans(identity).e2ee,ttl:recorded?.expiresAt==='never'?'never':next,fatalOnError:false,runAw:localAw});
          for(const message of preflight.warnings) warnings.push({code:'e2ee-disabled',message});
          // This seat's active grants other than the current one, from the custody's
          // list: each stays valid until the next start or retire revokes it.
          const seat=ctx.home?recordedStart(ctx.home).meta?.identity?.seat:undefined;
          if(seat) {
            try {
              const label=seatGrantLabel(ctx.instance||basename(ctx.home),seat);
              for(const g of strayGrants(teamGrants(argv=>localAw(argv,custody),details.team),label,recorded?.id)) warnings.push({code:'grant-revoke-pending',message:`${unrevokedGrant({...g,custody})}; the next start or retire revokes it`});
            }
            catch(e) {warnings.push({code:'grant-revoke-unchecked',message:`could not check for orphaned grants (${String(e.message||e).slice(0,200)}); this seat may hold grants that stay valid`});}
          }
        }
        catch(e) {problems.push({code:'custody',message:e.message});}
      }
    }
  }
  const receiveProblems=[];
  if(ctx.home) {
    const expiry=grantExpiryAssessment(recordedStart(ctx.home).meta?.identity,{home:ctx.home,now,configuredTtl:obj(req.settings.identity)?req.settings.identity.ttl:undefined});
    receiveProblems.push(...expiry.problems);warnings.push(...expiry.warnings);
  }
  // Preserve prerequisite diagnostics; receive evidence is meaningful only
  // after configuration and custody checks succeed.
  if(ctx.home && !problems.length) {
    const expected=expectedReceive(ctx.home,{delivery:req.settings.delivery||'channel'});
    primaryBroker = expected.primaryBroker === true;
    receiveProblems.push(...expected.problems);
    warnings.push(...(expected.warnings||[]));
    for(const team of expected.polled||[]) warnings.push({code:'joined-team-polled',message:`joined team ${team.label} is read at task boundaries on this Claude home, as expected. An idle session doesn't read its mail until something else wakes it. No wake broker is needed for this team.`});
    if(!expected.problems.length) {
      // A Claude channel home is on the channel only with Claude's own
      // registration line from after its last start (awebai/oats#981).
      const channel=expected.native && expected.runtime==='claude'?channelReadiness(channelConnection({home:ctx.home,startedAt:expected.startedAt}),ctx.home):undefined;
      if(channel) {receiveProblems.push(...channel.problems);warnings.push(...channel.warnings);}
      if(expected.native) warnings.push({code:'native-receive-unproven',message:channel?.receiveMessage??'native receive connection is unproven: plugin/extension configuration and confirmation do not establish connected receive'});
      // req.settings is the home's captured payload, its origins the captured ones.
      if(expected.capturedDelivery==='channel' && expected.runtime==='claude' && claudeChannelModeUnset(req.settings,settingsOrigins(env))) warnings.push({...CLAUDE_CHANNEL_MODE_DEFAULT});
      if(expected.brokerRequired) {
        let status;
        try {status=JSON.parse(localAw(['aw','wake','status','--json'],ctx.home));} catch { /* unavailable below */ }
        // aw stamps updated_at during the status call, so judge its evidence
        // against a post-read clock, not the phase start. No skew allowance.
        const target=targetReceiveAssessment(status,{home:ctx.home,...expected},{minimumVersion:AW_MIN,now:Date.now(),clientVersion:details.awVersion});
        const targetProblems=target.problems;
        warnings.push(...target.warnings);
        receiveProblems.push(...targetProblems);
        // A joined team that passes the broker route prerequisites needs no
        // action, so it is not a warning (awebai/oats#881): the spawn brief and
        // `oats aweb teams --json` already give its receive mode.
        if(targetProblems.length) for(const joined of expected.joined) warnings.push({code:'joined-team-poll-only',message:`joined team ${joined.label} has unproven broker receive; check aw --identity-home ${joined.identityHome} mail inbox and chat pending at task boundaries`});
      }
    }
  }
  // A pi home's pi folder loads no aweb skills: the extension below 0.5.0
  // filters out its bundled ones, and @awebai/claude-skills is not listed
  // unfiltered. These warnings stand apart from receive, so they are read
  // whatever else failed.
  if(ctx.home) {
    const agentDir=recordedPiAgentDir(ctx.home,env);
    for(const w of [piExtensionSkillsWarning(agentDir),piSkillsPackageWarning(agentDir)]) if(w) warnings.push(w);
  }
  // Soul scope has no target row: only the daemon a spawn will need, read once.
  // It sees no harness either, so a join alone can't say the daemon is needed.
  const session=req.settings.delivery==='session';
  if(!ctx.home && !problems.length && (session || soulJoinsTeams(req.settings))) {
    let status;
    try {status=JSON.parse(localAw(['aw','wake','status','--json'],ctx.deployment));} catch { /* unavailable below */ }
    const daemon=wakeDaemonAssessment(status,{minimumVersion:AW_MIN});
    warnings.push(...daemon.warnings);
    if(session) receiveProblems.push(...daemon.problems);
    else if(daemon.problems.length) warnings.push({code:'joined-team-broker-unconfirmed',message:'the host wake broker is not confirmed running. A joined team needs it on a pi or Codex home. A Claude channel home reads its joined teams at task boundaries and needs no broker.'});
  }
  const excludedGrantSeat = mode === 'global' && (!ctx.home || recordedStart(ctx.home).meta?.retained !== true);
  // A home's settings are its spawn's capture: it asks whether health
  // publishes now, so a later `health enable` or `disable` counts.
  if (primaryBroker && !excludedGrantSeat && !problems.length && (ctx.home ? healthPublishesNow(ctx,env,deadline) : healthSettings(req.settings).publish)) {
    let countOnly = false;
    try { countOnly = localAw(['aw','mail','inbox','--help'],ctx.deployment).includes('--count-only'); } catch { /* unknown capability */ }
    if (!countOnly) warnings.push({code:'unread-count-unavailable',message:'aw mail inbox does not advertise --count-only; unread-delivery attention counts are unknown. Upgrade aw to a build with read-only count support; failed counts never clear existing claims.'});
  }
  const result=checkProblems(problems) || {status:receiveProblems.length?'unavailable':'ready',problems:[]};
  return {...result,problems:[...result.problems,...receiveProblems],warnings};
}
async function checkPhase(req) {
  keys(req.input,['binding','context','action','invocation'],['context','action']);
  if(Object.hasOwn(req.input,'binding') || Object.hasOwn(req.input,'invocation')) wireError('provider-not-qualified',CAPTURED_UNSUPPORTED);
  if(!obj(req.input.action) || typeof req.input.action.kind!=='string') wireError('invalid-binding');
  return workspaceReadinessPhase(req);
}

// check answers through a promise (its aw floor read is asynchronous).
// normalize and bind are named because the kernel requires all three phases; they accept
// no input since the captured path was removed.
export function handleBindingRequest(phase,value) {
  if(!phases.has(phase)) wireError('invalid-binding');
  if(phase!=='check') wireError('provider-not-qualified',CAPTURED_UNSUPPORTED);
  return checkPhase(request(value,phase));
}
function response(phase,body) {return {schemaVersion:1,phase,slot:SLOT,capability:CAPABILITY,...body};}
function errorCode(error) {if(errorCodes.has(error?.wireCode)) return error.wireCode;if(errorCodes.has(error?.code)) return error.code;return 'invalid-binding';}
// Only these literal domain diagnostics may cross the wire. Never reflect a
// caught exception's dynamic alias/key/path, native stderr or credential text.
const safeReasons=new Map([
  ['needs-configuration',[
    TEAM_SETTING_MESSAGE,
    AWEB_TEAM_ID_MESSAGE,
  ]],
  ['provider-not-qualified',[CAPTURED_UNSUPPORTED]],
]);
const fallbackReasons=Object.freeze({
  'needs-configuration':'messaging settings and explicit binding selections are required',
  'invalid-binding':'messaging input must match the supported binding contract',
  'provider-not-qualified':'the requested messaging configuration is not qualified',
});
function errorProblem(error) {
  const code=errorCode(error),message=safeReasons.get(code)?.find(literal=>literal===error?.message)??fallbackReasons[code];
  return {code,message};
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
    // normalize and bind answer the fixed reason whatever they are sent; their input is read
    // to its end and not parsed.
    if(phase==='normalize' || phase==='bind') {for await(const chunk of input) void chunk;handleBindingRequest(phase);}
    for await(const chunk of input) {const bytes=Buffer.from(chunk);length+=bytes.length;if(length>BINDING_WIRE_LIMITS.bytes) wireError('invalid-binding');chunks.push(bytes);}
    const result=await handleBindingRequest(phase,parseBindingJson(Buffer.concat(chunks,length)));
    answer=response(phase,{ok:true,result});
  } catch(error) {answer=response(phases.has(phase)?phase:'check',{ok:false,error:errorProblem(error)});}
  let bytes;
  try {enforceOutputLimits(answer);bytes=Buffer.from(JSON.stringify(answer)+'\n');if(bytes.length>BINDING_WIRE_LIMITS.bytes) wireError('provider-not-qualified');}
  catch {bytes=Buffer.from(JSON.stringify(response(phases.has(phase)?phase:'check',{ok:false,error:{code:'provider-not-qualified',message:'messaging response exceeds the supported wire limits'}}))+'\n');}
  output.write(bytes);return answer.ok;
}
