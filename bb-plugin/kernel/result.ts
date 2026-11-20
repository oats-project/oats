// The answer of every kernel/ function: a value, or a typed error. No function of kernel/ throws
// for something `oats` did or said.

export type KernelError = { code: string; message: string };
export type Result<Value> = { ok: true; value: Value } | { ok: false; error: KernelError };

export const ok = <Value>(value: Value): Result<Value> => ({ ok: true, value });
export const err = (code: string, message: string): Result<never> => ({ ok: false, error: { code, message } });

/**
 * The plugin's own codes, for what is not the kernel's word. None starts with `E_`, so one is never
 * taken for a kernel refusal (docs/desktop-cli-api.md "kernel codes": `^E_[A-Z0-9_]+$`).
 */
export const codes = {
  /** the binary is not there, or cannot be run */
  notFound: "OATS_NOT_FOUND",
  /** it ran longer than the verb allows and was killed */
  timeout: "OATS_TIMEOUT",
  /** the call was cancelled (the caller went away, the plugin was reloaded) and it was killed */
  aborted: "OATS_ABORTED",
  /** it exited 0 and stdout is not JSON */
  notJson: "OATS_NOT_JSON",
  /** it answered JSON that is not the document the verb answers */
  badAnswer: "OATS_BAD_ANSWER",
  /** it failed with no JSON answer */
  failed: "OATS_FAILED",
  /** it printed more than the plugin reads */
  tooLarge: "OATS_OUTPUT_TOO_LARGE",
  /** the plugin refused the input before any process started */
  invalidInput: "INVALID_INPUT",
  // What the server entry says in a failed snapshot, before any `oats` could run:
  /** no bb machine is connected to this server */
  noHost: "NO_HOST",
  /** several bb machines and no `host` setting: the person chooses one */
  chooseHost: "CHOOSE_HOST",
  /** the `host` setting names no machine of this server */
  hostNotFound: "HOST_NOT_FOUND",
  /** no directory holding `oats-local.yaml` at or above a bb project's root, or at the `deployment` setting */
  noDeployment: "NO_DEPLOYMENT",
  /** the machine's host daemon did not answer */
  hostUnreachable: "HOST_UNREACHABLE",
  /** an act went through, and neither its answer nor the next status names the agent's bb thread */
  noThread: "NO_THREAD_NAMED",
} as const;

export const isKernelCode = (code: string): boolean => /^E_[A-Z0-9_]+$/.test(code);
