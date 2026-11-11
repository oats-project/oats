#!/usr/bin/env node
// oats.okf 6.0: the knowledge harvester is removed. This stub keeps its name
// answering until 7.0 (a bare unknown-soul error is not enough): the required
// spawn hook always refuses, before any home is kept, naming the fix and what
// to delete from a deployment's configuration. It reads nothing and writes
// nothing; it answers no meta, so a refused spawn leaves no external state.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REMOVED_SPAWN = 'E_REMOVED: oats.okf 6.0 removed the knowledge harvester. The instance proposes its knowledge itself: run `oats okf propose --plan` from its home (or `oats okf propose --home <retirement recovery> --soul <soul>` from the deployment for a retired source). Delete any souls.launch key for oats.okf/knowledge-harvester and any --provider oats.okf harvest=... spawn flag; add the trigger template oats.okf:proposal-review beside oats.okf:harvest-review, and remove the old one once no 5.x harvester can open an okf-harvest PR. See the 6.0 release note.';
export const REMOVED_COMMAND = 'was removed in oats.okf 5.0, and the harvester itself in 6.0: there are no harvest runs to complete or report. The instance proposes its knowledge itself with `oats okf propose`';
const HELP = `oats.okf-harvest is a removed-capability stub (oats.okf 6.0, until 7.0).
Its spawn hook refuses every harvester spawn with E_REMOVED and the fix:
  run \`oats okf propose --plan\` from the instance home.
oats okf-harvest complete | harvest-status   E_REMOVED
`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), event = process.env.OATS_EVENT || args[0];
  if (event === 'spawn') {
    process.stdout.write(JSON.stringify({ warning: `oats-okf-harvest ${REMOVED_SPAWN}` }) + '\n');
    process.exitCode = 1;
  } else if (!event || args.includes('--help') || args.includes('-h')) process.stdout.write(HELP);
  else {
    const error = ['complete', 'harvest-status'].includes(event)
      ? { code: 'E_REMOVED', message: `oats okf-harvest ${event} ${REMOVED_COMMAND}` }
      : { code: 'E_USAGE', message: `unknown command ${event}; see --help` };
    if (args.includes('--json')) process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: false, error }) + '\n');
    else process.stderr.write(`oats okf-harvest ${event}: ${error.code}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
