import { colorForIdentity, soulColor } from '../../client/soul-colors.mjs';

// Theme branches own all colors, including AA foreground/background pairs.
// No data is ever interpolated into styles, SVG, HTML, or resource URLs.
export const identityCSS = `
.identity-mark { display:inline-grid; place-items:center; flex:none; width:36px; height:36px; border-radius:9px; font-size:15px; font-weight:650; letter-spacing:-.02em; }
.runtime-badge { display:inline-grid; place-items:center; flex:none; width:18px; height:18px; border-radius:5px; font-size:9.5px; font-weight:700; }
.runtime-badge > .runtime-mark { display:block; width:100%; height:100%; overflow:visible; }
.runtime-badge[data-runtime="pi"] > .runtime-mark { width:66%; height:66%; }
.runtime-badge[data-runtime="claude"] > .runtime-mark { width:72%; height:72%; }
`;

// The harness marks: static geometry only, painted with currentColor so the
// theme's --runtime-<key>-fg (and the roster's idle override) colours them.
// Pi's is the official pi.dev press-kit badge, unmodified (MIT), and Claude's is
// Anthropic's Claude spark, unmodified; Codex's is OATS's own original drawing,
// not that product's logo. Sources, licence and terms: harness-marks/README.md.
const SVG_NS = 'http://www.w3.org/2000/svg';
const runtimeMarks = new Map([
  // Claude's spark: Anthropic's official mark, its path verbatim (harness-marks/README.md).
  ['claude', { name: 'Claude', viewBox: '0 0 24 24', paint: 'fill',
    paths: ['m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z'] }],
  // pi.dev "Badge SVG" (https://pi.dev/favicon.svg), its three paths verbatim.
  ['pi', { name: 'Pi', viewBox: '0 0 560 560', paint: 'fill',
    paths: ['M420 280H280V140H0V0H420V280Z', 'M560 560H420V280H560V560Z', 'M140 560H0V140H140V280H280V420H140V560Z'] }],
  // A prompt: a chevron and an underscore, round-capped strokes.
  ['codex', { name: 'Codex', viewBox: '0 0 24 24', paint: 'stroke',
    paths: ['M6.5 8L10.5 12L6.5 16', 'M12.5 16H17.5'] }],
]);
function runtimeMark(doc, { viewBox, paint, paths }) {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'runtime-mark'); svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  if (paint === 'fill') svg.setAttribute('fill', 'currentColor');
  else for (const [name, value] of [['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '2.25'],
    ['stroke-linecap', 'round'], ['stroke-linejoin', 'round']]) svg.setAttribute(name, value);
  for (const d of paths) { const path = doc.createElementNS(SVG_NS, 'path'); path.setAttribute('d', d); svg.append(path); }
  return svg;
}
/** A roster row's harness mark (slice 3d, Joan's decision 2026-11-22 on Juan's request, superseding slice 1's removal):
 * the known harness's own mark, monochrome. It paints currentColor by default; on a roster row, shell.css
 * `.ctx-row-detail > .ctx-harness[fill|stroke="currentColor"]` repaints it in --tree-link, as a graphic, lighter than
 * the line's text. Decorative (aria-hidden: the row's title says "harness · model"); null for a harness this Desktop
 * doesn't know, so an unknown one shows nothing. */
export function createHarnessMark(doc, value) {
  const known = runtimeMarks.get(typeof value === 'string' ? value.trim().toLowerCase() : '');
  if (!known) return null;
  const svg = runtimeMark(doc, known);
  svg.setAttribute('class', 'runtime-mark ctx-harness');
  return svg;
}
/** A reported harness's display name (Claude, Pi, Codex), else the value verbatim. */
export function harnessName(value) {
  const reported = typeof value === 'string' ? value.trim() : '';
  return runtimeMarks.get(reported.toLowerCase())?.name || reported;
}
const words = text => text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
/** The two-letter mark, one grammar app-wide: drop a package qualifier (after the
 * last `/` or `--`) and, from three words, a leading namespace word; then the
 * initials of two words, or a single word's first two characters, uppercased.
 * Code points, not UTF-16 units; no letters or digits after the qualifier is `?`. */
export function markText(value) {
  if (typeof value !== 'string') return '?';
  const slash = value.lastIndexOf('/'), dashes = value.lastIndexOf('--');
  const cut = Math.max(slash < 0 ? 0 : slash + 1, dashes < 0 ? 0 : dashes + 2);
  let parts = words(value.slice(cut));
  if (parts.length >= 3) parts = parts.slice(1);
  const chars = parts.length >= 2 ? [[...parts[0]][0], [...parts[1]][0]] : parts.length ? [...parts[0]].slice(0, 2) : [];
  const upper = [...chars.join('').toLocaleUpperCase('en')];
  // Upper case can grow ("ß" is "SS"): a mark is two glyphs at most, so then each character keeps its first.
  return (upper.length <= 2 ? upper : chars.map(c => [...c.toLocaleUpperCase('en')][0])).join('') || '?';
}
function identityMark(doc, name, color, kind) {
  const el = doc.createElement('span');
  el.className = `identity-mark ${kind}`;
  el.dataset.avatarColor = color;
  el.setAttribute('aria-hidden', 'true'); // the adjacent name is authoritative
  el.textContent = markText(name);
  return el;
}
export function createSoulMark(doc, soul) {
  return identityMark(doc, soul?.name, soulColor(soul), 'soul-avatar');
}

/** Decorative capability identity ONLY: never used-by souls or memberships.
 * Root/host are the reported inspection scope, id is the reported capability. */
export function createCapabilityMark(doc, capability, { root, host } = {}) {
  return identityMark(doc, capability?.id, colorForIdentity({ root, name: capability?.id, host }), 'capability-avatar');
}

/** The badge describes the REPORTED runtime, not installed providers,
 * executable health, credentials, or authentication. A known harness draws its
 * mark (decorative inside the labelled img); anything else is a "?" text. */
export function createRuntimeBadge(doc, value) {
  const reported = typeof value === 'string' ? value.trim() : '';
  const key = reported.toLowerCase(), known = runtimeMarks.get(key);
  const el = doc.createElement('span'); el.className = 'runtime-badge';
  if (known) el.dataset.runtime = key; // closed set, even for hostile metadata
  const label = `Harness: ${known?.name || reported || 'Not reported'}`;
  el.setAttribute('role', 'img'); el.setAttribute('aria-label', label); el.title = label;
  if (known) el.append(runtimeMark(doc, known)); else el.textContent = '?';
  return el;
}
