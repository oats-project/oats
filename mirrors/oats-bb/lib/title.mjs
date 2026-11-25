// The title of a home's bb thread: the instance's name as words.
//
// One agent has one name wherever a person reads it: the OATS Desktop's sidebar, the OATS
// plugin for bb, and bb's own header and thread list, which draw the thread's title. The
// rule is OATS's `instanceDisplayName` (oats-project/oats,
// packages/client/instance-display-name.mjs), copied here: the provider imports nothing of
// OATS, and test/unit/title.test.mjs pins it with that function's own examples.

/** `name` as words: every `-` is a space, a run of them one space, the ends trimmed, and
 *  only the first character upper-cased; every other character stays as it was.
 *  `oats-expert-maintainer-lanes` → "Oats expert maintainer lanes",
 *  `tui-leader-hint-developer-2` → "Tui leader hint developer 2", `x` → "X",
 *  `already Words` → "Already Words". '' for a non-string, or a name with nothing but `-`
 *  and spaces. */
export function threadTitle(name) {
  if (typeof name !== "string") return "";
  const words = name.replace(/-+/g, " ").trim();
  if (!words) return "";
  // The first character by code point, so a name that starts outside the BMP is not split.
  const first = String.fromCodePoint(words.codePointAt(0));
  return first.toUpperCase() + words.slice(first.length);
}
