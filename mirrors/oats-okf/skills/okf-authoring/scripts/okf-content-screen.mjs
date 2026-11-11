/**
 * Bounded, deterministic content screen; library only, with no I/O or env reads.
 *
 * screenText(text, trustedLocation, { commit: false }) and screenBytes(bytes,
 * trustedLocation, options) return { location, line, rule } findings. Lines are
 * 1-based (LF, CRLF and CR); at most one finding per rule per line, in line and
 * RULE_IDS order. Location is a caller-owned diagnostic label, NOT an untrusted
 * path. No matched value, snippet, or decoder error is returned or retained.
 * Any finding means refusal to the caller; an empty array is NOT clearance.
 *
 * Both entry points reject NUL, invalid Unicode and more than 4 MiB of UTF-8.
 * screenBytes accepts Uint8Array (including Buffer), decoded with fatal UTF-8;
 * it does not guess an encoding. All input errors have one static code/message.
 *
 * Rules (not validity checks against a service):
 * - secret-pypi / secret-github: recognizable issued-token prefixes and bodies.
 * - secret-service-token: AWS access IDs, Google API keys, Slack, Stripe,
 *   OpenAI/Anthropic-style sk- keys, npm, GitLab, Hugging Face, DigitalOcean,
 *   SendGrid and JWT-shaped signed tokens. No generic entropy/identifier scan.
 * - secret-private-key: PEM/PGP private-key and PuTTY private-key headers.
 * - secret-credential-url: URI authority user:password, or token-only userinfo.
 *   A username alone is not a secret. Real credentials at documentation hosts
 *   still refuse; an example hostname cannot make its password safe.
 * - secret-assignment: explicit credential keys in assignment/header syntax,
 *   including Authorization Basic/Bearer. Bare key/id/hash/identifier are NOT
 *   credential keys; token/password/secret are deliberately conservative.
 *   Only empty assignments, explicit angle-bracket metavariables and whole
 *   variable-reference forms are nonliteral syntax. Words such as "redacted"
 *   or "dummy" are NOT value allowlists; they can be actual passwords.
 *   Assignment parsing is lexical, not a shell/JSON/YAML interpreter: ':'
 *   permits flow separators; '=' keeps commas/brackets/braces as literal data.
 * - contact-email: ordinary ASCII dot-atom addresses at dotted DNS hosts or IP
 *   literals. RFC2606/6761 example/test/invalid/localhost domains (and their
 *   subdomains) and RFC5737 documentation IPv4 literals are not contacts.
 * - contact-phone: formatted NANP numbers, international '+' forms (8–15
 *   digits), or explicitly phone-labelled numbers (7–15 digits). Bare numeric
 *   IDs are NOT phones. Dotted numbers require NANP grouping, not a generic
 *   digit count; surrounding identifier/version/IP/path characters disqualify
 *   a candidate. Phone-shaped non-phone values remain inherently ambiguous.
 *
 * commit:true exempts ONLY noreply addresses in exact attribution trailers in
 * a final trailer block separated from the commit subject/body by a blank line.
 * It does not exempt prose, arbitrary headers, malformed/continued trailers,
 * other addresses on that line, or any secret/phone finding. This is a narrow
 * subset of Git trailer syntax, not a permissive Git message parser.
 *
 * terms (oats.okf 6.0): an optional array of host-supplied terms, each matched
 * case-insensitively anywhere in a line (rule host-term, location only). It
 * only ever ADDS refusals: it is the host's own deny list, never an allow list,
 * and it is a caller argument, not a text directive or environment setting.
 *
 * Limits: not a universal secret/PII detector, a name recognizer, a contextual
 * people/team classifier, or publication authority. Does not decode arbitrary
 * encodings, obfuscation, structured documents, split/multiline credentials,
 * quoted/internationalized email addresses, or all national phone formats.
 * Human contextual review remains necessary, including names and private paths.
 * Fixed rule/placeholder/domain definitions are package policy, not caller
 * flags, text directives, environment settings, or allow/ignore lists.
 */
import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';

const MAX_BYTES = 4 * 1024 * 1024;
const INPUT_MESSAGE = 'Content screen input is invalid or exceeds the supported limit.';

export const RULE_IDS = Object.freeze([
  'secret-pypi',
  'secret-github',
  'secret-service-token',
  'secret-private-key',
  'secret-credential-url',
  'secret-assignment',
  'contact-email',
  'contact-phone',
  'host-term',
]);
const MAX_TERMS = 10000;
const MAX_TERM = 256;

function inputError() {
  const error = new Error(INPUT_MESSAGE);
  error.code = 'E_CONTENT_INPUT';
  return error;
}

function parseOptions(options) {
  if (options === undefined) return { commit: false, terms: [] };
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw inputError();
  // Accept data properties only; do not evaluate caller-supplied getters.
  const properties = Object.getOwnPropertyDescriptors(options);
  if (Reflect.ownKeys(properties).some(key => key !== 'commit' && key !== 'terms')) throw inputError();
  let commit = false, terms = [];
  if (Object.hasOwn(properties, 'commit')) {
    const property = properties.commit;
    if (!Object.hasOwn(property, 'value')) throw inputError();
    if (property.value !== undefined && typeof property.value !== 'boolean') throw inputError();
    commit = property.value ?? false;
  }
  if (Object.hasOwn(properties, 'terms')) {
    const property = properties.terms;
    if (!Object.hasOwn(property, 'value')) throw inputError();
    const value = property.value;
    if (value !== undefined) {
      if (!Array.isArray(value) || value.length > MAX_TERMS) throw inputError();
      terms = Array.from(value, term => {
        if (typeof term !== 'string' || !term || term.length > MAX_TERM || /[\0\r\n]/.test(term)) throw inputError();
        return term.toLowerCase();
      });
    }
  }
  return { commit, terms };
}

const PYPi = /(?<![A-Za-z0-9_])pypi-[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/;
const GITHUB = /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})(?![A-Za-z0-9_-])/;
const SERVICE = /(?<![A-Za-z0-9_])(?:A(?:KIA|SIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|xox[baprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|sk-(?:proj-|svcacct-|ant-)?[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36,}|glpat-[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{30,}|dop_v1_[a-f0-9]{64}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})(?![A-Za-z0-9_-])/;
const PRIVATE_KEY = /-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----|-----BEGIN PGP PRIVATE KEY BLOCK-----|PuTTY-User-Key-File-[23]:/;

function placeholder(value) {
  // These are syntax, not a configurable or free-word credential allowlist.
  if (value === '' || /^<(?:redacted|placeholder|token|password|passwd|secret|api[-_]key|access[-_]token|client[-_]secret)>$/i.test(value)) return true;
  // These are references, not interpolated/evaluated by the detector.
  return /^(?:\$[A-Za-z_][A-Za-z0-9_]{0,127}|\$\{[A-Za-z_][A-Za-z0-9_]{0,127}\}|\{\{[ \t]*[A-Za-z_][A-Za-z0-9_.]{0,127}[ \t]*\}\}|process\.env\.[A-Za-z_][A-Za-z0-9_]{0,127}|os\.environ\[(?:"[A-Za-z_][A-Za-z0-9_]{0,127}"|'[A-Za-z_][A-Za-z0-9_]{0,127}')\])$/.test(value);
}

function credentialURL(line) {
  // Bound the protocol spelling; scan each authority only once. No URL parser
  // exception (which can echo its input) and no network/hostname resolution.
  const urls = /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s<>"`/?#]+/gi;
  for (const match of line.matchAll(urls)) {
    const authority = match[0].slice(match[0].indexOf('://') + 3);
    const at = authority.lastIndexOf('@');
    if (at < 1) continue;
    const userinfo = authority.slice(0, at);
    // Decode URI userinfo only (including encoded ':'), never other text.
    let decoded;
    try { decoded = decodeURIComponent(userinfo); } catch { return true; }
    const colon = decoded.indexOf(':');
    if (colon >= 0) {
      if (!placeholder(decoded.slice(colon + 1))) return true;
    } else if (PYPi.test(decoded) || GITHUB.test(decoded) || SERVICE.test(decoded)) {
      return true;
    }
  }
  return false;
}

// Finite credential vocabulary, NOT any long identifier or *_id/*_key field.
const CREDENTIAL_KEY = '(?:(?:github|gitlab|pypi|npm|slack|openai|anthropic|stripe|service)[_-])?(?:api[_-]?key|access[_-]?token|auth[_-]?token|bearer[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|password|passwd|pwd|secret|token)|aws[_-](?:secret[_-]access[_-]key|access[_-]key[_-]id|session[_-]token)|(?:db|database)[_-](?:password|passwd|pass)|pgpassword|authorization';

function assignmentValue(line, start, structured) {
  // '#' is data when attached to '=' or a value, including an empty quoted
  // segment. Only whitespace before a new word introduces a comment here.
  if (line[start] === '#' && /[ \t]/.test(line[start - 1])) return '';

  // Step over explicit reference syntax whose internal whitespace or closing
  // delimiters would otherwise split the token. This is NOT an early return:
  // any adjacent suffix still belongs to the value and must be screened.
  const reference = line.slice(start).match(/^(?:\$\{[A-Za-z_][A-Za-z0-9_]{0,127}\}|\{\{[ \t]*[A-Za-z_][A-Za-z0-9_.]{0,127}[ \t]*\}\}|os\.environ\[(?:"[A-Za-z_][A-Za-z0-9_]{0,127}"|'[A-Za-z_][A-Za-z0-9_]{0,127}')\])/);
  let end = start + (reference?.[0].length ?? 0);
  let quote = '';
  let quoteStart = -1;
  let firstQuoteEnd = -1;
  for (; end < line.length; end++) {
    const char = line[end];
    if (quote) {
      if (char === quote) {
        if (quoteStart === start) firstQuoteEnd = end;
        quote = '';
      } else if (char === '\\' && quote !== "'") {
        end++; // Do not mistake an escaped quote for the end of a segment.
      }
      continue;
    }
    if (/\s/.test(char) || (structured ? /[,}\]]/.test(char) : /[;|&]/.test(char))) break;
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      quoteStart = end;
    } else if (char === '\\') {
      end++; // An escaped boundary is literal, not the end of the value.
    }
  }
  // Strip exactly one COMPLETE enclosing quote pair, never just the first
  // segment of a concatenation. Unclosed quotes remain literal and refuse.
  if (firstQuoteEnd >= start && firstQuoteEnd === end - 1 && !quote) return line.slice(start + 1, end - 1);
  return line.slice(start, end);
}

function credentialAssignment(line) {
  const assignments = new RegExp(`(?<![A-Za-z0-9_-])["']?(${CREDENTIAL_KEY})["']?[ \\t]*([:=])[ \\t]*`, 'gi');
  for (const match of line.matchAll(assignments)) {
    const start = match.index + match[0].length;
    const structured = match[2] === ':';
    let value = assignmentValue(line, start, structured);
    if (match[1].toLowerCase() === 'authorization') {
      // "... authorization: <prose>" is not an HTTP header. Colon syntax
      // needs a line-start/quoted/flow-map key, or an explicit HTTP scheme.
      // Equals assignments and recognizable token rules remain independent.
      const prefix = line.slice(0, match.index);
      if (structured && prefix.trim() && !/^["']/.test(match[0]) &&
          !/[{,][ \t]*$/.test(prefix) && !/^(?:basic|bearer)(?:[ \t]|$)/i.test(value)) continue;
      // A scheme name by itself is not a credential. For unquoted headers,
      // parse the value after the scheme rather than mistaking "Bearer" for it.
      if (/^(?:basic|bearer)$/i.test(value)) {
        value = /^["'`]/.test(line[start]) ? '' :
          assignmentValue(line, start + value.length + (line.slice(start + value.length).match(/^[ \t]*/)?.[0].length ?? 0), structured);
      } else {
        value = value.replace(/^(?:basic|bearer)[ \t]+/i, '');
      }
    }
    if (!placeholder(value)) return true;
  }
  return false;
}

const EXAMPLE_DOMAINS = Object.freeze([
  'example.com', 'example.net', 'example.org', 'example', 'test', 'invalid', 'localhost',
]);

function exampleDomain(host) {
  const domain = host.toLowerCase().replace(/\.$/, '');
  return EXAMPLE_DOMAINS.some(example => domain === example || domain.endsWith(`.${example}`));
}

function documentationIP(host) {
  // Bracketed mail domain literals only; a secret at these endpoints still
  // refuses under the independent credential rules.
  return /^\[(?:192\.0\.2|198\.51\.100|203\.0\.113)\.(?:0|[1-9]\d?|1\d\d|2[0-4]\d|25[0-5])\]$/.test(host);
}

function noreply(address) {
  const [local, domain] = address.toLowerCase().split('@');
  return /^(?:noreply|no-reply)$/.test(local) ||
    /^(?:users\.noreply\.github\.com|users\.noreply\.gitlab\.com)$/.test(domain);
}

const ATTRIBUTION_TRAILERS = new Set([
  'co-authored-by', 'signed-off-by', 'reviewed-by', 'tested-by', 'acked-by',
  'reported-by', 'suggested-by',
]);

function trailerExemptions(lines, commit) {
  const exemptions = new Map();
  if (!commit) return exemptions;
  let end = lines.length;
  while (end && !lines[end - 1].trim()) end--;
  let start = end;
  while (start && lines[start - 1].trim()) start--;
  if (start === 0 || !lines.slice(0, start).some(line => line.trim())) return exemptions;
  for (let i = start; i < end; i++) {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*:[ \t]+\S.*$/.test(lines[i])) return exemptions;
  }
  for (let i = start; i < end; i++) {
    const colon = lines[i].indexOf(':');
    if (!ATTRIBUTION_TRAILERS.has(lines[i].slice(0, colon).toLowerCase())) continue;
    // Parse delimiters instead of overlapping whitespace/name regex repeats;
    // an unclosed trailer with a multi-MiB name must not cause backtracking.
    const value = lines[i].slice(colon + 1).trim();
    const open = value.indexOf('<');
    if (open <= 0 || !value.endsWith('>') || !/[ \t]/.test(value[open - 1])) continue;
    const name = value.slice(0, open).trim();
    const address = value.slice(open + 1, -1);
    if (!name || name.includes('>') || /[<>\s]/.test(address)) continue;
    if (noreply(address)) exemptions.set(i, address);
  }
  return exemptions;
}

function contactEmail(line, exemptAddress) {
  const emails = /(?<![A-Za-z0-9.!#$%&'*+/=?^_`{|}~-])([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64})@([A-Za-z0-9][A-Za-z0-9.-]{0,252}|\[(?:IPv6:)?[A-Fa-f0-9:.]{1,64}\])(?![A-Za-z0-9_.-])/g;
  for (const match of line.matchAll(emails)) {
    const address = match[0];
    const host = match[2].replace(/\.$/, '');
    if (!host.startsWith('[')) {
      if (!host.includes('.') && host.toLowerCase() !== 'localhost') continue;
      const labels = host.split('.');
      // A DNS top-level label is alphabetic (or IDNA), not a version/IP suffix.
      if (!/^(?:[A-Za-z]{2,63}|xn--[A-Za-z0-9-]{1,59})$/.test(labels.at(-1))) continue;
      if (!labels.every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) continue;
    }
    if (exampleDomain(host) || documentationIP(host) || address === exemptAddress) continue;
    return true;
  }
  return false;
}

const NANP = /(?<![A-Za-z0-9_./+\-])(?:\+?1[ .-])?(?:\([2-9]\d{2}\)[ .-]?[2-9]\d{2}[ .-]\d{4}|[2-9]\d{2}([ .-])[2-9]\d{2}\1\d{4})(?![A-Za-z0-9_./\-])/;

function phoneCandidate(candidate) {
  const digits = candidate.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return false;
  // Calendar/timestamp shapes and IP/version-like dotted groups aren't generic
  // phones. Dotted NANP is handled separately by its exact 3/3/4 grouping.
  if (/^\+?\d{4}-\d{2}-\d{2}(?:$|[ T])/.test(candidate) || candidate.includes('.')) return false;
  return true;
}

function contactPhone(line) {
  if (NANP.test(line)) return true;
  const international = /(?<![A-Za-z0-9_./+\-])\+[1-9]\d{0,2}(?:[ ()-]{0,3}\d){5,14}(?![A-Za-z0-9_./+\-]|[ ()-]*\d)/g;
  for (const match of line.matchAll(international)) {
    if (match[0].replace(/\D/g, '').length >= 8 && phoneCandidate(match[0])) return true;
  }
  const labelled = /\b(?:phone|telephone|tel|mobile|fax|sms|whatsapp)[ \t]*[:=][ \t]*(\+?\d[\d ()+.-]{0,62}\d|\([2-9]\d{2}\)[\d ()+.-]{3,59}\d)(?![A-Za-z0-9_./+\-]|[ ()-]*\d)/gi;
  for (const match of line.matchAll(labelled)) {
    if (phoneCandidate(match[1])) return true;
  }
  return false;
}

/** Screen a Unicode string; location must already be a safe diagnostic label. */
export function screenText(text, location, options = {}) {
  if (typeof text !== 'string' || typeof location !== 'string' || text.length > MAX_BYTES ||
      Buffer.byteLength(text, 'utf8') > MAX_BYTES || text.includes('\0') ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)) throw inputError();
  let commit, terms;
  try { ({ commit, terms } = parseOptions(options)); } catch { throw inputError(); }
  const lines = text.split(/\r\n|\r|\n/);
  const exemptions = trailerExemptions(lines, commit);
  const findings = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line) continue;
    const matches = [
      PYPi.test(line), GITHUB.test(line), SERVICE.test(line), PRIVATE_KEY.test(line),
      credentialURL(line), credentialAssignment(line),
      contactEmail(line, exemptions.get(index)), contactPhone(line),
      terms.length > 0 && (lower => terms.some(term => lower.includes(term)))(line.toLowerCase()),
    ];
    for (let rule = 0; rule < RULE_IDS.length; rule++) {
      if (matches[rule]) findings.push({ location, line: index + 1, rule: RULE_IDS[rule] });
    }
  }
  return findings;
}

/** Screen raw UTF-8 bytes; invalid, NUL-containing or oversized input refuses. */
export function screenBytes(bytes, location, options = {}) {
  let text;
  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_BYTES) throw inputError();
    // Preserve a BOM as text so the two entry points have identical semantics.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw inputError();
  }
  return screenText(text, location, options);
}
