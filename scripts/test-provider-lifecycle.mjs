#!/usr/bin/env node
// `npm run test:provider-lifecycle`: every schedule of the session-provider lifecycle's explorer
// (test/session-provider-explorer.test.mjs), where `npm test` runs a seeded sample of them.
// Pull-request CI runs this on every push, as a job of its own: the full enumeration takes minutes,
// and a sample is what would let the next ordering through.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const explorer = fileURLToPath(new URL("../test/session-provider-explorer.test.mjs", import.meta.url));
const run = spawnSync(process.execPath, ["--test", explorer], { stdio: "inherit", env: { ...process.env, OATS_EXPLORER_COUNT: "all" } });
process.exit(run.status ?? 1);
