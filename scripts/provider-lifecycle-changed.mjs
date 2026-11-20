#!/usr/bin/env node
// Whether a change touches the lifecycle of a provider home, for pull-request CI's job that runs
// EVERY schedule of the lifecycle's explorer (`npm run test:provider-lifecycle`, minutes). The
// shards run a seeded sample of the schedules on every change; all of them run when a change
// touches what they test, and nightly on main (.github/workflows/provider-lifecycle-nightly.yml).
//
// As a step of that job it compares BASE_SHA with HEAD_SHA (a pull request's base and merge
// commit, a push's before and after) and writes `run=true|false` to $GITHUB_OUTPUT. Anything it
// cannot tell (no base, a base that is not in the checkout, a git that fails) is `true`: the
// schedules run.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The files whose change runs every schedule: the lifecycle's code and what it stands on, its
 *  design page, the explorer's own fixture base, and the workflows and scripts that run it. */
export const LIFECYCLE_FILES = Object.freeze([
  // The lifecycle itself, and the kernel code its verbs go through.
  "lib/core.mjs",
  "lib/instance-lifecycle.mjs",
  "lib/retire-admission.mjs",
  "lib/hook-env.mjs",
  "lib/instance-listing.mjs",
  "bin/oats.mjs",
  // The lifecycle's own records and what writes them: the claim, the locks (the resume count's),
  // the home's events (the session boundary, the waiting claim) and the record's writer.
  "lib/claim.mjs",
  "lib/dir-lock.mjs",
  "lib/instance-events.mjs",
  "lib/write-through-private-file.mjs",
  // What a provider home may run: its module copies' digests and its capability rows, by its receipt.
  "lib/home-integrity.mjs",
  // What tells a live process from one that is gone, and ends a process group.
  "lib/worktree-hooks.mjs",
  "lib/process-group.mjs",
  "packages/record/lib/process-identity.mjs",
  // The design of record.
  "docs/design/2026-11-20-provider-home-lifecycle.md",
  // The deployment every fixture of the explorer is built on.
  "test/helpers/v2-deployment.mjs",
  // What runs the schedules, and what decides.
  "scripts/test-provider-lifecycle.mjs",
  "scripts/provider-lifecycle-changed.mjs",
  ".github/workflows/pull-request.yml",
  ".github/workflows/provider-lifecycle-nightly.yml",
]);
/** And every file of these shapes: the session and provider modules, the lifecycle's test files and
 *  their helpers. */
export const LIFECYCLE_PATTERNS = Object.freeze([
  /^lib\/session-[^/]+\.mjs$/,
  /^lib\/provider-[^/]+\.mjs$/,
  /^test\/session-provider[^/]*\.test\.mjs$/, // session-provider-*.test.mjs, and session-providers*.test.mjs
  /^test\/helpers\/session-provider-[^/]+$/,
]);

/** Whether a change to `files` (paths from the repository's root) touches the lifecycle. */
export const touchesLifecycle = (files) => files.some((file) => LIFECYCLE_FILES.includes(file) || LIFECYCLE_PATTERNS.some((pattern) => pattern.test(file)));

/** `{ run, why }` for the change from `base` to `head`. The change is listed without rename
 *  detection: a file renamed out of the list is a file of the list that was removed. */
export function decide({ base, head, changed = (range) => execFileSync("git", ["diff", "--no-renames", "--name-only", range], { encoding: "utf8" }).split("\n").filter(Boolean) }) {
  if (!base || !head || /^0+$/.test(base)) return { run: true, why: "no base to compare with" };
  let files;
  try { files = changed(`${base}...${head}`); } catch (e) { return { run: true, why: `the change could not be listed (${String(e?.message ?? e).split("\n")[0]})` }; }
  const touched = files.filter((file) => touchesLifecycle([file]));
  return touched.length ? { run: true, why: `it changes ${touched.slice(0, 3).join(", ")}${touched.length > 3 ? ` and ${touched.length - 3} more` : ""}` } : { run: false, why: `none of its ${files.length} files is the lifecycle's` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { run, why } = decide({ base: process.env.BASE_SHA, head: process.env.HEAD_SHA });
  console.log(`every schedule of the session-provider lifecycle: ${run ? "run" : "not run"} (${why})`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
}
