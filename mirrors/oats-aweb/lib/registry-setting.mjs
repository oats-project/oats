// A saved aw URL is a locator. Only this operator-owned setting grants a
// process private-network registry access (aw rc.3 registry_pin.go).
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

export const REGISTRY_SETTING='settings.oats.aweb.registry';
export const REGISTRY_MIGRATION='registry-setting-required: settings.oats.aweb.registry: `oats aweb setup --registry <origin>`; restart serve: `oats aweb resident create <name>`; restart wake: `oats aweb wake install` (own shell).';
const invalid=detail=>{throw new Error(`${REGISTRY_SETTING}: ${detail}`);};
export function registryOrigin(settings={}) {
  if(!Object.hasOwn(settings,'registry')) return undefined;
  const raw=settings.registry;
  if(typeof raw!=='string'||!raw||/[\s\\\x00-\x1f\x7f]/.test(raw)) invalid('must be an absolute http/https origin without whitespace or backslashes');
  if(raw.includes('?')||raw.includes('#')) invalid('queries and fragments, including empty delimiters, are unsupported; use an http/https origin');
  // Inspect the original path before WHATWG normalization could erase /../.
  const parts=/^https?:\/\/([^/]+)(\/.*)?$/i.exec(raw);
  if(!parts) invalid('must be an absolute http/https origin');
  if(parts[1].includes('@')) invalid('userinfo is unsupported; use an origin without credentials');
  if(parts[2]&&parts[2]!=='/') invalid(parts[2].replace(/\/+$/, '')==='/api' ? '/api aliases are unsupported in this setting; give the bare origin (aw treats it as equivalent)' : 'path-prefixed registry URLs are unsupported; put the registry on its own hostname and give an origin with no path');
  let url;
  try {url=new URL(raw);} catch {invalid('must be an absolute http/https origin');}
  if(url.hostname.endsWith('.')) url.hostname=url.hostname.slice(0,-1);
  return url.origin;
}

/** Registry use includes diagnostic admission verdicts. Version/help,
 * recorded team lists, local custody and wake control need no admission. */
export function registryCommand(args) {
  args=[...args];
  if(args[0]==='aw') args.shift();
  while(args[0]?.startsWith('--')) {
    const flag=args.shift();
    if(!flag.includes('=')) args.shift(); // --identity-home <path>
  }
  if(args.includes('--help')) return false;
  // aw rc.3 doctor_identity.go addRegistryPinningCheck uses the live pin
  // to assess a private locator even in --offline mode (no network request).
  if(args[0]==='doctor'&&args[1]==='identity') return true;
  if(args.includes('--offline')) return false;
  const [command,sub,action]=args;
  if(command==='init'||command==='whoami'||command==='heartbeat'||command==='mail'||command==='chat'||command==='status'||command==='status-host') return true;
  if(command==='workspace') return ['connect','delete','status'].includes(sub);
  if(command==='team') return sub==='invite';
  if(command==='id') return sub==='grant'||(sub==='team'&&action!=='list')||sub==='show';
  if(command==='doctor') return sub==='registry'&&args.includes('--online');
  return (command==='custody'&&sub==='serve')||(command==='wake'&&sub==='run');
}
export function registryEnv(settings,args) {
  const origin=registryOrigin(settings);
  return origin&&(!args||registryCommand(args))?{AWID_REGISTRY_URL:origin}:{};
}
/** POSIX shell text for an operator's retry command, never an argv or URL parser. */
export function registryShellValue(origin) {
  return `'${origin.replace(/'/g,"'\\''")}'`;
}
export function registryShellAssignment(origin) {
  return `AWID_REGISTRY_URL=${registryShellValue(origin)}`;
}
// Detection only: recognize the public default equally in ambient input and
// saved YAML. This comparison never returns a URL for admission to a child.
function publicRegistryLocator(value) {
  try {
    const url = new URL(value);
    if (url.hostname.endsWith('.')) url.hostname = url.hostname.slice(0, -1);
    return url.origin === 'https://api.awid.ai' && !url.username && !url.password && !url.search && !url.hash && ['/', '/api', '/api/'].includes(url.pathname);
  } catch { return false; }
}
export function registryMigration(settings, env = process.env, {custody} = {}) {
  if (registryOrigin(settings)) return undefined;
  if (Object.hasOwn(env, 'AWID_REGISTRY_URL') && env.AWID_REGISTRY_URL !== '' && !publicRegistryLocator(env.AWID_REGISTRY_URL)) return REGISTRY_MIGRATION;
  if (custody) {
    let text;
    try { text = readFileSync(join(custody, '.aw', 'identity.yaml'), 'utf8'); } catch { return undefined; }
    const raw = /^registry_url:[ \t]*(.*)$/m.exec(text)?.[1]?.trim();
    if (raw) {
      let locator;
      try {
        const scalar = raw.replace(/\s+#.*$/, '');
        locator = scalar.startsWith('"') ? JSON.parse(scalar) : scalar.replace(/^'|'$/g, '');
      } catch { return REGISTRY_MIGRATION; }
      if (!publicRegistryLocator(locator)) return REGISTRY_MIGRATION;
    }
  }
  return undefined;
}
