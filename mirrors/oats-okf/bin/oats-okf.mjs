#!/usr/bin/env node
import { resolve, fail, unlock, redactUrls } from '../lib/io.mjs';
import { loadBindings } from '../lib/config.mjs';
import { service, ensureInstanceKnowledge, consultSource, checkSeat } from '../lib/sources.mjs';
import { CONSULT, subjectBriefLines, takeWarnings } from '../lib/consult.mjs';
import { initBase, migrate, deliverMigration, cutoverMigration, forgetMigration } from '../lib/migration.mjs';
import { inspect } from '../lib/inspection.mjs';
import { loadInvocationKnowledgeBinding } from '../lib/binding-wire.mjs';
import { refuseLegacySettings, refuseKnowledgeKeys, removeLegacySettings } from '../lib/legacy-settings.mjs';
import { writeHarvestPolicy, harvestPolicy } from '../lib/harvest-policy.mjs';
import { upgradePlan, upgradeApply } from '../lib/upgrade.mjs';
import { propose } from '../lib/propose.mjs';
const HELP=`oats okf status [--home PATH] [--json]
  (spawn-recorded duty to propose, as harvest and publish: on, off, or unknown; no base/network read)
oats okf inspect [--home PATH] [--json]
oats okf bases [--fresh] [--json]
oats okf index [--base ALIAS] [NODE | ALIAS/NODE] [--fresh] [--json]
oats okf cat --base ALIAS PATH [--from PATH] [--fresh] [--json]
oats okf ls --base ALIAS [DIR] [--fresh] [--json]
oats okf links --base ALIAS PATH [--fresh] [--json]
oats okf search [--base ALIAS | --all] [--node NODE] [--regex] [--case-sensitive] TEXT [--fresh] [--json]
oats okf propose --plan | --check | --apply --slug SLUG [--digest DIGEST] [--home PATH] [--json]
  (from the instance home: clone the owned bases, check the edits and print the
  outgoing diff and digest, then open one okf-proposal PR per changed base;
  operator form from the deployment: --home <instance home | retirement recovery> --soul SOUL)
Subject layout (a base whose okf-base.json lists the reserved nodes claims,
subjects and verdicts; each reads one committed generated index):
oats okf subjects [--kind system|workstream|project] [--base ALIAS] [--fresh] [--json]
oats okf subject KIND/SLUG [--base ALIAS] [--fresh] [--json]
oats okf claims --about KIND/SLUG [--type TYPE] [--kind KIND] [--base ALIAS] [--fresh] [--json]
oats okf index [KIND/SLUG]   (an okf.json version 2 soul: its subjects' indexes)
oats okf verdicts --check CLAIM-FILE [--base ALIAS] [--fresh] [--json]
Consult commands read the accepted state remotely (host cache, no local copy);
also accept --home PATH. PATH is /node/x.md from the base root, relative to
--from's directory, or bare node/x.md from the root.
oats okf init --base ALIAS --nodes FILE [--output PATH | --confirm] [--json]
oats okf migrate --legacy PATH --base ALIAS --node NODE --output PATH [--json]
oats okf migrate --deliver FILE | --cutover FILE --soul-dir PATH | --forget ID [--json]
oats okf unlock --lock PATH --token TOKEN [--json]
oats okf setup --remove-legacy-settings [--plan] --soul SOUL [--json]
  (from the deployment: deletes only settings.oats.okf.harvest/harvest-runtime/harvest-model
  from its oats-local.yaml; --plan writes nothing)
Knowledge reaches the accepted base only through PRs the knowledge maintainer merges.
Read the compulsory okf-propose skill for checkpoint and opt-out instructions; check
oats okf status from your instance home, then oats okf propose. Consultation settings
use one absolute bindings-file.
`;
// okf 5.0.0: the 4.x harvest surfaces refuse, naming the new way; they never
// capture, run, complete or drain anything.
// The shared inject and okf-propose skill own the conditional duty. The
// provider writes its effective policy at spawn; TASK.md carries none of it.
// The spawn hook answers no meta, on success or failure: the kernel keeps a
// hook's meta as the receipt of external state, and a capability with no retire
// hook that reported one is quarantined when the spawn rolls back. This hook
// only writes working memory and the policy in the home (removed with it) and
// primes the shared host cache.
const NEW_WAY='run `oats okf propose` from the instance home: the working agent proposes its own knowledge by PR at its checkpoints (the compulsory okf-propose skill; `oats okf status` first); oats.okf keeps no source custody, runs or drains (README#upgrading-to-60)';
const removed=(what)=>fail('E_REMOVED',`${what} was removed in oats.okf 5.0: ${NEW_WAY}`);
const args=process.argv.slice(2);
if(args.includes('--help') || args.includes('-h')) {process.stdout.write(HELP);}
// okf #106: the upgrade hook reads only the home and its recorded meta, before
// any settings, binding or invocation check: a 4.x home's recorded harvest
// keys would refuse it there, and it must answer that home with its remedy.
else if((process.env.OATS_EVENT || args[0])==='upgrade') {
  const phase=process.env.OATS_UPGRADE_PHASE,home=resolve(process.env.OATS_INSTANCE_HOME || process.env.OATS_HOME || process.cwd());
  let answer;
  try {
    if(phase==='plan') answer=upgradePlan(home);
    else if(phase==='apply') answer=upgradeApply(home);
    else fail('E_USAGE','OATS_UPGRADE_PHASE must be plan or apply');
  } catch(e) {answer={warning:`oats-okf ${e.code || 'E_OKF'}: ${redactUrls(e.message)}`};process.exitCode=1;}
  process.stdout.write(JSON.stringify(answer)+'\n');
}
else {
  const event=process.env.OATS_EVENT || args[0];
  const hook=['spawn','soul-scaffold'].includes(event);
  const consult=Object.hasOwn(CONSULT,event);
  let exit=0,answer,text,textMode=(consult || event==='propose') && !args.includes('--json');
  try {
    // Removed 4.x commands refuse whatever their (old) flags were.
    if(['harvest','run-source','complete','retry','harvest-status'].includes(event)) removed(`oats okf ${event}`);
    const flags={},positionals=[]; const boolean=new Set(['json','confirm','fresh','all','regex','case-sensitive','remove-legacy-settings','plan','check','apply','enable','disable','install-host','remove-schedules']);
    for(let i=1;i<args.length;i++) {
      if(consult && args[i]==='--') {positionals.push(...args.slice(i+1));break;}
      if(!args[i].startsWith('--')) {if(!consult) fail('E_USAGE',`unexpected argument ${args[i]}`);positionals.push(args[i]);continue;}
      const k=args[i].slice(2);if(k in flags) fail('E_USAGE',`duplicate --${k}`);
      if(boolean.has(k)) flags[k]=true;
      else {if(!args[i+1] || args[i+1].startsWith('--')) fail('E_USAGE',`--${k} needs a value`);flags[k]=args[++i];}
    }
    // Before anything else of this provider (bindings, state, hooks): a
    // forwarded 4.x harvest setting refuses with where it was set and the fix.
    // The one exemption is the cleanup that removes it (help is answered above).
    const cleanup=event==='setup' && flags['remove-legacy-settings']===true;
    if(!cleanup) {refuseLegacySettings();refuseKnowledgeKeys();}
    for(const name of ['OATS_SOURCE_RECEIPT_FILE','OATS_INVOCATION_CONTEXT_FILE']) if(Object.hasOwn(process.env,name)) removed(`the captured source receipt/invocation context (${name})`);
    if(flags.source!==undefined) removed('--source (a 4.x source descriptor)');
    const accepted={
      spawn:[],'soul-scaffold':[],status:['home'],inspect:['home'],read:['home','base','path','fresh'],refresh:['home'],
      bases:['home','fresh'],index:['home','base','fresh'],cat:['home','base','from','fresh'],ls:['home','base','fresh'],
      links:['home','base','fresh'],search:['home','base','all','node','regex','case-sensitive','fresh'],
      subjects:['home','base','kind','fresh'],subject:['home','base','fresh'],claims:['home','base','about','type','kind','fresh'],verdicts:['home','base','check','fresh'],
      setup:['remove-legacy-settings','plan','harvest','enable','disable','install-host','remove-schedules'],init:['base','nodes','output','confirm'],
      propose:['home','plan','check','apply','slug','digest'],
      migrate:['source-home','legacy','base','node','output','deliver','cutover','soul-dir','forget'],unlock:['lock','token']
    };
    for(const k of Object.keys(flags)) if(!['json','soul',...(accepted[event] || [])].includes(k)) fail('E_USAGE',`unknown flag --${k} for ${event}`);
    if(!cleanup && loadInvocationKnowledgeBinding().kind==='captured' && ['setup','init','migrate','unlock'].includes(event)) fail('E_MIGRATION',`captured ${event} is not supported; use an explicit operator administration path`);
    const home=resolve(flags.home || process.env.OATS_INSTANCE_HOME || process.env.OATS_HOME || process.cwd());
    let result;
    // oats.okf 6: `publish` is the same spawn-recorded value under its new name.
    if(event==='status') {const p=harvestPolicy(home);result={...p,publish:p.harvest};}
    else if(event==='read') fail('E_REMOVED','okf 4.0.0 removed read: use `oats okf cat --base ALIAS PATH` (same path, text and receipt)');
    else if(consult) {
      const answer=CONSULT[event](consultSource(home),flags,positionals);result=answer.result;text=answer.text;
      // okf 6.0: a stale generated index is read as committed, with a warning.
      const warnings=takeWarnings();
      if(warnings.length) {for(const w of warnings) process.stderr.write(`${w}\n`);result={...result,warnings};}
    }
    else if(event==='propose') {const answer=propose(home,flags);result=answer.result;text=answer.text;}
    else if(event==='refresh') fail('E_REMOVED','okf 3.0.0 has no per-instance views; index/cat always read the accepted state: run `oats okf index`, then `oats okf cat --base ALIAS PATH`');
    else if(event==='soul-scaffold') {
      // Souls are portable declarations, never an implicit knowledge store.
      result={meta:{scaffolded:false},brief:'OKF requires explicit external bindings and soul/okf.json before a working instance can spawn. Use init or migrate; no knowledge was created in this soul.'};
    } else if(event==='spawn') {
      if(service(home)) result={brief:'Service agent: follow your own task; no working-memory upkeep.'};
      else {
        const seat=checkSeat(home),{decl,bindings,accepted,warnings}=seat;ensureInstanceKnowledge(home);writeHarvestPolicy(home);
        const nodes=(list)=>list.join(', ') || 'none';
        // okf 6.0: a version-2 soul gets one line per declared subject (at most eight).
        const start=decl.version===2
          ?`\`oats okf index\` for your subjects:\n${subjectBriefLines(bindings,decl,accepted).map(l=>`- ${l}`).join('\n')}\nthen \`oats okf subject KIND/SLUG\`, \`oats okf claims --about KIND/SLUG\``
          :`\`oats okf index\` (owns: ${nodes(decl.owns)}; reads: ${nodes(decl.reads.filter(r=>!decl.owns.includes(r)))})`;
        const {stale=[]}=seat;
        result={brief:`Your soul knowledge is read remotely at its accepted state; there is no local copy. Start every task with your instance knowledge (STATE.md, log.md, notes/), then ${start} and \`oats okf cat --base ALIAS PATH\` for the concepts the task needs; \`oats okf search\` before re-deriving a decision. Load okf-consultation and okf-instance-knowledge. Never edit accepted knowledge.${stale.length?`\n${stale.join('\n')}`:''}`,
          ...(warnings.length?{warning:`oats-okf: ${warnings.join('; ')}`}:{})};
      }
    } else if(event==='inspect') result=inspect(consultSource(home));
    else if(cleanup) {
      const other=Object.keys(flags).filter(k=>!['json','soul','remove-legacy-settings','plan'].includes(k));
      if(other.length) fail('E_USAGE',`--remove-legacy-settings takes only --plan (got --${other.join(', --')})`);
      result=removeLegacySettings({plan:!!flags.plan});
    }
    else if(event==='setup' && flags.harvest!==undefined) removed('setup --harvest (the deployment harvest switch)');
    else if(event==='setup' && (flags.enable || flags.disable || flags['install-host'] || flags['remove-schedules'])) removed('setup --enable/--disable/--install-host/--remove-schedules');
    else if(event==='setup') fail('E_USAGE','setup needs --remove-legacy-settings [--plan]');
    else if(event==='init') result=initBase(loadBindings(),flags.base,flags.nodes,flags.output,{confirm:!!flags.confirm});
    else if(event==='migrate') {
      if(flags['source-home']) removed('migrate --source-home (4.x source registration)');
      else if(flags.forget) result=forgetMigration(loadBindings(),flags.forget);
      else if(flags.deliver) result=deliverMigration(resolve(flags.deliver));
      else if(flags.cutover) result=cutoverMigration(resolve(flags.cutover),flags['soul-dir']);
      else result=migrate(loadBindings(),{legacy:flags.legacy,alias:flags.base,node:flags.node,output:flags.output});
    } else if(event==='unlock') result=unlock(resolve(flags.lock),flags.token);
    else fail('E_USAGE',`unknown command ${event}; see --help`);
    answer=hook?result:{schemaVersion:1,ok:true,result};
  } catch(e) {const code=e.code || 'E_OKF',message=redactUrls(e.message);exit=1;answer=hook?{warning:`oats-okf ${code}: ${message}`}:{schemaVersion:1,ok:false,error:{code,message,...(e.result?{result:e.result}:{})}};}
  // Consult commands print text unless --json; every other answer is JSON.
  // Let Node drain the pipe; no process.exit after a possibly large answer.
  // A propose refusal's safe details (finding locations, retained report) go with it.
  if(textMode && exit) process.stderr.write(`oats okf ${event}: ${answer.error.code}: ${answer.error.message}\n${answer.error.result?JSON.stringify(answer.error.result,null,2)+'\n':''}`);
  else if(textMode) process.stdout.write(text+'\n');
  else process.stdout.write(JSON.stringify(answer)+'\n');
  process.exitCode=exit;
}
