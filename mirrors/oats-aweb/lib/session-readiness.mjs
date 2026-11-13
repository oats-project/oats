// Read-only queries of the selected kernel (OATS_CLI_BIN), for the live readiness,
// setup, invite, resident and wake paths.
import {execFileSync} from 'node:child_process';
import {isAbsolute,resolve} from 'node:path';
import {BINDING_WIRE_LIMITS,parseBindingJson} from './binding-wire.mjs';
const error=()=>{throw Object.assign(new Error('selected kernel observation unavailable'),{code:'provider-unavailable'});};
/** Preserve native HOME/profile/auth/Git; remove only the invoking instance's
 * OATS selectors so a read-only query cannot accidentally target its parent. */
export function kernelQueryEnvironment(inherited){
  const env={...inherited};
  for(const key of Object.keys(env))if(/^(OATS_(?!HOME_DIR$)|OAS_|PI_AGENT_)/.test(key)||key==='PI_AGENTS_ROOT')delete env[key];
  return env;
}
/** Use the caller-owned CLI location, never search PATH or import private kernel
 * indexes. Binding execution must receive the same OATS_CLI_BIN as hooks. */
export function querySelectedKernel(args,{env=process.env,cwd,timeout=10000}={}){
  const cli=env.OATS_CLI_BIN;
  if(typeof cli!=='string'||!isAbsolute(cli)||resolve(cli)!==cli||cli.includes('\0'))error();
  let bytes;
  try{bytes=execFileSync(process.execPath,[cli,...args],{env:kernelQueryEnvironment(env),cwd,timeout,maxBuffer:BINDING_WIRE_LIMITS.bytes,stdio:['ignore','pipe','pipe']});}catch{error();}
  try{return parseBindingJson(bytes,BINDING_WIRE_LIMITS);}catch{error();}
}
