/* The one sentence a client says when its oats CLI is above its tested bound (oats-project/oats#1879,
   option 3): why, what is held back, and which Desktop to install. Every place that shows the notice or
   refuses a held-back operation builds its words here, so they cannot drift apart.

   The kernel cannot import this module (lib/ never imports packages/): `oats update` writes the same core
   sentence itself (lib/pi-bridge.mjs `desktopFirstLine`), and test/above-tested-wording.test.mjs holds
   the two equal for the same version.

   Pure data and strings; no node: imports, so the renderer shares it with the server. */

/** The held-back core, verbatim as decided on #1879: the Desktop to install is the installed CLI's own
 * version, since Desktop and kernel are released together from one tag. */
export function heldBackSentence(cliVersion) {
  return `Stop, Remove, schedules, triggers and every other change except Spawn, Start, Restart, colour and background are off until you install OATS Desktop ${cliVersion}.`;
}

/** The why, before the core: the tested bound ("X.Y") and the installed CLI's version. */
export function testedWhySentence(testedThrough, cliVersion) {
  return `This Desktop was tested with oats CLIs up to ${testedThrough}; the installed CLI is ${cliVersion}.`;
}

/** The notice: one line, the why then the core. */
export function aboveTestedNotice({ cliVersion, testedThrough }) {
  return `${testedWhySentence(testedThrough, cliVersion)} ${heldBackSentence(cliVersion)}`;
}

/** The GitHub Release whose assets are the Desktop of that version (docs/desktop.md, "Install"). */
export function desktopReleaseUrl(version) {
  return `https://github.com/oats-project/oats/releases/tag/v${version}`;
}
