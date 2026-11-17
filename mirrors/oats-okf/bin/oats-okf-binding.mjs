#!/usr/bin/env node
import { runBindingWire, ignoredCapturedVariables } from '../lib/binding-wire.mjs';

// awebai/oats-aweb#242 part 2: a captured-binding variable is ignored, with one
// stderr line each, naming it (never its value); stdout stays the wire answer.
for(const line of ignoredCapturedVariables()) process.stderr.write(`${line}\n`);
const args=process.argv.slice(2);
if(args.includes('--help') || args.includes('-h')) {
  process.stdout.write('oats okf provider binding phase (manifest-owned JSON stdin/stdout)\n');
} else {
  const phase=args[0];
  if(args.length!==1) {
    await runBindingWire(phase,[],process.stdout);
  } else {
    await runBindingWire(phase);
  }
}
