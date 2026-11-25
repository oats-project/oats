// Finds the pi SDK (@earendil-works/pi-coding-agent) the real-pi tests run in.
// pi is not a dependency of this repository: a real-pi case runs where a pi on
// PATH resolves to an SDK of the 0.85 line or later, and skips, saying why,
// where none does. Under npm the first pi on PATH is node_modules/.bin's, the
// root's development dependency, which can be older; the search goes on past
// it.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const MINIMUM = [0, 85];

/** The pi SDK behind one `pi` binary, or why it does not qualify. */
function sdkOf(bin) {
  for (let d = dirname(realpathSync(bin)); d !== dirname(d); d = dirname(d)) {
    const manifest = join(d, "package.json");
    if (!existsSync(manifest)) continue;
    const { name, version } = JSON.parse(readFileSync(manifest, "utf8"));
    if (name !== PI_PACKAGE) continue;
    const [major, minor] = version.split(".").map(Number);
    if (major < MINIMUM[0] || (major === MINIMUM[0] && minor < MINIMUM[1])) return { reason: `${bin} is ${PI_PACKAGE} ${version}, older than ${MINIMUM.join(".")}` };
    const piAi = [join(d, "node_modules", "@earendil-works", "pi-ai"), join(dirname(d), "pi-ai")].find((p) => existsSync(join(p, "dist", "index.js")));
    if (!piAi) return { reason: `${bin} is ${PI_PACKAGE} ${version} with no resolvable @earendil-works/pi-ai` };
    return { root: d, version, piAiEntry: join(piAi, "dist", "index.js") };
  }
  return { reason: `${bin} is not part of ${PI_PACKAGE}` };
}
/** The first qualifying pi SDK on PATH, or why there is none. */
function findPi() {
  const bins = [...new Set((process.env.PATH || "").split(delimiter).filter(Boolean).map((d) => join(d, "pi")).filter((p) => existsSync(p)))];
  if (!bins.length) return { reason: "no pi on PATH" };
  const reasons = [];
  for (const bin of bins) {
    const sdk = sdkOf(bin);
    if (sdk.root) return sdk;
    reasons.push(sdk.reason);
  }
  return { reason: reasons.join("; ") };
}

/** The SDK found: `{ root, version, piAiEntry }`, or `{ reason }` where there is none. */
export const PI = findPi();
/** A test's `skip`: false where a real pi runs, else why none does. */
export const skip = PI.root ? false : `pi SDK not found: ${PI.reason}`;
if (PI.root) console.log(`# real pi: ${PI_PACKAGE} ${PI.version} at ${PI.root}`);
