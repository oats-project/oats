/** Test seams for the lifecycle of a provider home (docs/design/2026-11-20-provider-home-lifecycle.md,
 *  "The holder died" and "A provider's command outlives the kernel that ran it"). No effect unless
 *  OATS_TEST_PROVIDER_DIE_AT is set; reserved launch environment (lib/reserved-launch-env.mjs):
 *  never a launch's to set.
 *
 *  OATS_TEST_PROVIDER_DIE_AT names one point, and the kernel dies there, by SIGKILL, as a killed
 *  command does:
 *    - a point between two writes (`mark:receipt-written`, `stop:stoppedAt-written`, …: lib/core.mjs);
 *    - `call:<verb>:before` and `call:<verb>:after`: right before and right after a provider's
 *      command (lib/session-providers.mjs callSessionProvider);
 *    - `call:<verb>:during`: while the provider's command runs. The kernel cannot kill itself
 *      inside a synchronous wait, so the leader of the command's process group does it, before it
 *      runs the provider (lib/provider-call-child.mjs, OATS_TEST_PROVIDER_KILL_KERNEL). */
export function dieAt(point) {
  if (process.env.OATS_TEST_PROVIDER_DIE_AT !== point) return;
  process.kill(process.pid, "SIGKILL");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000); // the signal is on its way
}
/** Whether this kernel is to die while the provider's `verb` command runs. */
export const diesDuring = (verb) => process.env.OATS_TEST_PROVIDER_DIE_AT === `call:${verb}:during`;
