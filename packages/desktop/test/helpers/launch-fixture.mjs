// Source authoring for the packaged launch fixture. There is no kernel verb to author a workspace,
// membership declaration or soul, so those test inputs belong here, outside Desktop source. The
// caller uses the real CLI's onboard and spawn verbs for deployment and instance creation.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Author and commit fixture source; all children use the smoke's bounded process-group reaper. */
export async function createLaunchFixtureSource(root, { env, runTracked, timeout }) {
  const repo = join(root, "workspace"), bin = join(root, "bin");
  const ref = pathToFileURL(repo).href;
  mkdirSync(join(repo, "souls", "smoke"), { recursive: true });
  writeFileSync(join(repo, "oats-workspace.yaml"), `schemaVersion: 2\nname: smoke\nmembers: [${JSON.stringify(ref)}]\n`);
  writeFileSync(join(repo, "oats-membership.yaml"), `schemaVersion: 2\nworkspace: ${JSON.stringify(ref)}\n`);
  writeFileSync(join(repo, "souls", "smoke", "soul.yaml"), "schemaVersion: 2\nname: smoke\ndescription: Packaged launch selection probe.\nwork: directory\nknowledge: none\nmessaging: none\ntasks: none\n");
  writeFileSync(join(repo, "souls", "smoke", "AGENTS.md"), "Inert packaged launch selection fixture.\n");
  // A raw-input stand-in needs no login or provider. Every received byte changes both its
  // receipt and pane output, so the smoke can independently prove a launch typed nothing.
  mkdirSync(bin);
  const inputReceipt = join(root, "harness-input");
  writeFileSync(join(bin, "claude"), `#!${process.execPath}
const { writeFileSync, appendFileSync } = require('node:fs');
const receipt = ${JSON.stringify(inputReceipt)};
writeFileSync(receipt, '');
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', bytes => {
  appendFileSync(receipt, bytes);
  process.stdout.write('INPUT:' + bytes.toString('hex') + '\\n');
});
process.stdout.write('OATS_SMOKE_READY\\n');
`);
  chmodSync(join(bin, "claude"), 0o755);
  const gitEnv = { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
  for (const args of [["init", "-b", "main"], ["add", "."],
    ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Smoke workspace"]]) {
    const result = await runTracked("git", args, { cwd: repo, env: gitEnv, timeout: timeout() });
    if (result.timedOut || result.code !== 0) throw new Error(`launch fixture git failed: ${String(result.stderr).slice(-4096)}`);
  }
  return { ref, bin, inputReceipt };
}
