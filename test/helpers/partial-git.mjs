// Whether this host's git keeps a partial cache, decided by the kernel's own probe (lib/remote.mjs), and what
// a test of partial-cache mechanics does on an older git (awebai/oats#389). OATS falls back to whole trees there,
// so those mechanics cannot happen and cannot be asserted: a developer host skips them, naming why. Under CI
// they run, and fail, so a runner image that ships an older git is found loudly instead of losing the tests.
import { gitVersion, keepsPartialCache, PARTIAL_FETCH_GIT } from "../../lib/remote.mjs";

const version = await gitVersion();
/** This host's git, as the kernel reads it: "2.54.0", or null when it could not be read. */
export const GIT_VERSION_TEXT = version?.text ?? null;
/** True when the kernel keeps partial caches with this git. */
export const PARTIAL_GIT = keepsPartialCache(version);
/** The notice the kernel gives once per session (once per command, or per reader call), however many caches it
 *  starts, when this git (or `text`) cannot keep a partial cache. It names no repository. */
export const olderGitNotice = (text = GIT_VERSION_TEXT ?? "(unknown version)") =>
  `git ${text} cannot keep a partial cache (it needs ${PARTIAL_FETCH_GIT.join(".")}), so OATS fetches whole trees instead; a git of ${PARTIAL_FETCH_GIT.join(".")} or later removes this notice`;
/** The `skip` option for a test of partial-cache mechanics: false (run it) with a git that keeps a partial cache
 *  or under CI; otherwise the reason it cannot run here. */
export const skipPartialMechanics = PARTIAL_GIT || process.env.CI
  ? false
  : `git ${GIT_VERSION_TEXT ?? "(unknown version)"} cannot keep a partial cache (it needs ${PARTIAL_FETCH_GIT.join(".")}): OATS fetches whole trees here, so partial-cache mechanics cannot be tested (awebai/oats#389)`;
