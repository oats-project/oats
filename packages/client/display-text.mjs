/** The one display filter for free text the kernel or a host supplies and Desktop shows: a detail, or a
 * label inside one of Desktop's sentences. The result is lossy and for display only: it is never evidence
 * of identity and never authority for an action, and it is not fit for a name that identifies something.
 * Pure: no DOM, no IO, never throws. A contract module: the server imports it too, so it imports nothing.
 * Mirrored by oats-bb plugin/app/ui/text.ts: re-record its test/fixtures/desktop/display-text.json when this changes. */

/** Not text a one-line note may hold, an exact set (the maintainer's decision for the kernel's
 * validWaitingMessage): control characters (Cc: C0, DEL, C1), the line and paragraph separators, the bidi
 * embeddings and overrides (U+202A–202E) and isolates (U+2066–2069), the zero-width space, the word
 * joiner, the BOM and the tag characters (U+E0000–E007F). Every other format character is text: ZWJ
 * (emoji sequences), ZWNJ (Persian, Urdu), LRM, RLM and ALM (Hebrew, Arabic), the soft hyphen. */
export const NOT_NOTE_TEXT = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069\u200B\u2060\uFEFF\u{E0000}-\u{E007F}]/u;
const EVERY_NOT_NOTE_TEXT = new RegExp(NOT_NOTE_TEXT.source, 'gu');

/** Text withheld whole: secrets, credentialed URLs, C0 controls other than tab and line feed, DEL.
 * Its time grows with the length of the text, which is tested as given and may be long (#976). So the URL
 * alternative finds `://` first and looks behind it for the scheme: written scheme first, it read a run of
 * letters to its end from each letter of the run, and its time grew with the square of the run. The
 * look-behind reads only scheme characters and `://` holds none, so each `://` reads its own run once;
 * what follows stops at the next `/`, and every `://` holds one. Asked only whether it matches: this form
 * and the scheme-first one match the same texts, not the same part of them. */
export const UNSAFE = /[\x00-\x08\x0b-\x1f\x7f]|:\/\/(?<=[a-z][a-z0-9+.-]*:\/\/)[^\s/]*@|(?:token|authorization|password|secret|api[_ -]?key)\s*[:=]\s*\S+|(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}/i;
/** What stands in for a withheld text. The name is kept on purpose until the terminal client's own change renames it. */
export const DETAIL_WITHHELD = '[withheld]';
export const MAX_DISPLAY_LINE = 2048;

/** One line: tab, line feed and the line and paragraph separators each become a space, runs of spaces
 * collapse (also a run the text already had: acceptable for free text, not for an identifier) and the
 * ends are trimmed. Every character of NOT_NOTE_TEXT still present becomes U+FFFD:
 * replaced, never dropped, so the reader sees something was withheld. Two different texts can become the
 * same line: the result is for display only, never for comparing, selecting or addressing anything.
 * Bounded to MAX_DISPLAY_LINE UTF-16 units, without splitting a surrogate pair or ending on a space. */
function oneLine(text) {
  const line = text.replace(/[\t\n\u2028\u2029]/g, ' ').replace(/ {2,}/g, ' ').replace(/^ | $/g, '').replace(EVERY_NOT_NOTE_TEXT, '\uFFFD');
  if (line.length <= MAX_DISPLAY_LINE) return line;
  const last = line.charCodeAt(MAX_DISPLAY_LINE - 1);
  return line.slice(0, last >= 0xD800 && last <= 0xDBFF ? MAX_DISPLAY_LINE - 1 : MAX_DISPLAY_LINE).replace(/ $/, '');
}

/** Kernel or host text as one display line, DETAIL_WITHHELD when it is UNSAFE, or null when there is
 * nothing to show (not a string, empty, or only line breaks and spaces). UNSAFE is tested on the text as
 * given, before any folding, replacement or truncation: what is withheld is withheld whole. The line is
 * what is shown, so it is held to UNSAFE as well; filtering twice therefore equals filtering once. */
export function displayLine(text) {
  if (typeof text !== 'string' || !text) return null;
  if (UNSAFE.test(text)) return DETAIL_WITHHELD;
  const line = oneLine(text);
  return !line ? null : UNSAFE.test(line) ? DETAIL_WITHHELD : line;
}

/** Already a display line: what a relayed text must be before it is shown again. */
export const cleanLine = v => typeof v === 'string' && displayLine(v) === v;
