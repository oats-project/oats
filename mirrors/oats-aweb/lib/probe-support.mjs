// Both the CLI primitive and server freshness behavior need published, qualified
// contracts. This gate has no environment/flag bypass and never uses a canary send.
import {accessSync, realpathSync, statSync, constants} from 'node:fs';
import {join, delimiter} from 'node:path';
import {request as httpsRequest} from 'node:https';
import {refuse, parseProbeJson, canonicalArgument} from './probe-runtime.mjs';
import {readWorkspaceService} from './probe-service.mjs';
import {AW_MIN, AWEB_CLOUD_ORIGINS, parseVersion, versionAtLeast} from './aw-floor.mjs';
import { plainServiceUrl } from './plain-service.mjs';

// Maintainer declaration: oats-aweb#57, issuecomment-6077900224. The origins and
// server floor are probe only; the CLI floor is the provider's single aw floor.
export const PROBE_RELEASE_SUPPORT = Object.freeze({origins: AWEB_CLOUD_ORIGINS, cliFloor: AW_MIN, serverFloor: '1.27.12'});

/** Exact selected service only. URL.origin strips /api without switching host;
 * credentials, query strings and fragments are never accepted as an authority. */
export function probeMetadataUrl(awebUrl) {
  if (!plainServiceUrl(awebUrl)) return null;
  let url;
  try { url = new URL(awebUrl); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['/', '/api', '/api/'].includes(url.pathname)) return null;
  return `${url.origin}/meta`;
}
/** Pure admission projection; the I/O adapter below supplies bounded metadata
 * from this exact URL and a version observation of the selected executable. */
export function projectProbeSupport({awebUrl, cliVersion, metadata, observedUrl, policy = PROBE_RELEASE_SUPPORT}) {
  const metadataUrl = probeMetadataUrl(awebUrl);
  const origin = metadataUrl ? new URL(metadataUrl).origin : null;
  const supported = !!(metadataUrl && policy && Array.isArray(policy.origins) && policy.origins.includes(origin) && observedUrl === metadataUrl && versionAtLeast(cliVersion, policy.cliFloor) && versionAtLeast(metadata?.build?.aweb_version, policy.serverFloor));
  return {supported, origin, metadataUrl, reason: supported ? null : `fresh-conversation support unknown/unsupported on ${origin ?? 'unknown origin'}`};
}
// aw 1.36.33 (877bbee9), cmd/aw/mail.go:436, reuses a thread by default;
// it needs --new-conversation. Commit 91ea73fee07f39e44f1be8c8d06fee8496b94719
// first shipped in aw 1.36.53, removed that flag, and made recipient+subject
// start a new thread. Detect the
// published help contract, never infer freshness from accepting a legacy send.
// Delete this legacy branch when AW_MIN contains that commit.
export function freshMailSendFlag(help) {
  const text = String(help);
  const required = ['to', 'subject', 'body-file'];
  if (!text.includes('\n  aw mail send [flags]') || required.some(flag => !new RegExp('^\\s+--' + flag + ' string\\s', 'm').test(text))) refuse('probe-cli-fresh-send-unsupported');
  if (/^\s+--new-conversation\s{2,}/m.test(text)) return true;
  if (/send starts a new thread\s+titled by --subject/.test(text)) return false;
  refuse('probe-cli-fresh-send-unsupported');
}

export function resolveProbeAw(pathValue) {
  // Resolve once, then run version and every identity/mail command via this path.
  for (const dir of String(pathValue ?? '').split(delimiter)) {
    if (!canonicalArgument(dir)) continue;
    try {
      const file = realpathSync(join(dir, 'aw'));
      accessSync(file, constants.X_OK);
      if (canonicalArgument(file) && statSync(file).isFile()) return file;
    } catch { /* next explicit PATH entry */ }
  }
  refuse('probe-cli-unavailable');
}
export function probeAwVersion(bytes) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
  // versionReport() emits text, even with --json. Only the anchored
  // version line grants admission; malformed lines refuse. A pre-release is a version like any other:
  // the floor decides it (aw-floor.mjs).
  const match = /^aw ([0-9][0-9A-Za-z.+-]*)\r?\n(?:  (?:commit:|built:) [^\r\n]*\r?\n)*$/.exec(text);
  return match && parseVersion(match[1]) ? match[1] : null;
}
export function observeProbeMetadata(url, budget, request = httpsRequest) {
  const timeout = budget.cap(5000);
  return new Promise((resolve, reject) => {
    let req, response, timer, settled = false, size = 0; const chunks = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); budget.signal?.removeEventListener('abort', cancel);
      if (error) { response?.destroy(); req?.destroy(); reject(error); }
      else resolve(value);
    };
    const fail = () => finish(new Error('metadata unavailable'));
    const cancel = () => fail();
    try {
      // node:https sends no ambient auth/proxy headers and follows no redirects.
      req = request(url, {method: 'GET', agent: false, rejectUnauthorized: true, headers: {accept: 'application/json'}}, res => {
        response = res;
        if (res.statusCode !== 200) { fail(); return; }
        res.on('error', fail); res.on('aborted', fail);
        res.on('data', data => {
          size += data.length;
          if (size > 65536) fail(); else chunks.push(data);
        });
        res.on('end', () => {
          try { budget.check(); finish(null, parseProbeJson(Buffer.concat(chunks))); } catch (e) { finish(e); }
        });
      });
      req.on('error', fail);
      timer = setTimeout(fail, timeout);
      budget.signal?.addEventListener('abort', cancel, {once: true});
      if (budget.signal?.aborted) cancel(); else req.end();
    } catch (e) { finish(e); }
  });
}
export async function qualifyProbeSupport({execute, target, budget, path, observe = observeProbeMetadata, resolveAw = resolveProbeAw}) {
  budget.check();
  const root = readWorkspaceService(target.rootHome), receiver = readWorkspaceService(target.identityHome);
  if (root.awebUrl !== receiver.awebUrl) refuse('selected-service-mismatch');
  const metadataUrl = probeMetadataUrl(root.awebUrl);
  const origin = metadataUrl ? new URL(metadataUrl).origin : null;
  // Never put credentials or arbitrary config text in the refusal projection.
  const reason = `fresh-conversation support unknown/unsupported on ${origin ?? 'unknown origin'}`;
  if (!metadataUrl || !PROBE_RELEASE_SUPPORT.origins.includes(origin)) refuse(reason);
  const awBinary = resolveAw(path);
  const binaryStamp = () => { const s = statSync(awBinary); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; };
  const stamp = binaryStamp();
  const revalidate = () => {
    budget.check();
    if (readWorkspaceService(target.rootHome).digest !== root.digest || readWorkspaceService(target.identityHome).digest !== receiver.digest) refuse('selected-service-config-changed');
    if (binaryStamp() !== stamp) refuse('probe-cli-changed');
  };
  let awVersion;
  try { awVersion = probeAwVersion(await execute(awBinary, ['version'], 3000)); }
  catch { budget.check(); refuse('probe-cli-version-unavailable'); }
  if (!versionAtLeast(awVersion, PROBE_RELEASE_SUPPORT.cliFloor)) refuse('probe-cli-version-unsupported');
  revalidate();
  let metadata;
  try { metadata = await observe(metadataUrl, budget); }
  catch { budget.check(); refuse(reason); }
  budget.check(); revalidate();
  if (!projectProbeSupport({awebUrl: root.awebUrl, cliVersion: awVersion, metadata, observedUrl: metadataUrl}).supported) refuse(reason);
  let help;
  try { help = await execute(awBinary, ['mail', 'send', '--help'], 3000); }
  catch { budget.check(); refuse('probe-cli-fresh-send-unavailable'); }
  budget.check(); revalidate();
  const newConversationFlag = freshMailSendFlag(help);
  return {cli: true, server: true, awBinary, awVersion, newConversationFlag, revalidate};
}
