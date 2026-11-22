/** An instance name as words, for display only: the label of an instance row in the Desktop's and the TUI's sidebar
 * (the product owner, 0.68.1: "like normal words with a space between them, with the first word with initial capital
 * letter"). Every `-` is a space, a run of them one space, the ends trimmed, and only the first character upper-cased;
 * every other character stays as it was.
 * `oats-expert-maintainer-lanes` → "Oats expert maintainer lanes", `tui-leader-hint-developer-2` →
 * "Tui leader hint developer 2", `x` → "X", `already Words` → "Already Words".
 * The real name stays wherever it identifies the instance (a title, the hover card, a copy, a search, the accessible
 * name, a tab, the CLI): this is the visible label alone. DOM-free and import-free, with no module state.
 * The same rule, copied as threadTitle by the bb session provider: oats-project/oats-bb
 * oats-package/capabilities/oats-bb/lib/title.mjs (a bb thread's title; its test/unit/title.test.mjs pins this
 * function's examples). Change both together. */

/** `name` as words; '' for a non-string or a name with nothing but `-` and spaces. */
export function instanceDisplayName(name) {
  if (typeof name !== 'string') return '';
  const words = name.replace(/-+/g, ' ').trim();
  if (!words) return '';
  // The first character by code point, so a name that starts outside the BMP is not split.
  const first = String.fromCodePoint(words.codePointAt(0));
  return first.toUpperCase() + words.slice(first.length);
}
