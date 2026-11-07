// Cancellation is a request, not process-exit evidence. In particular Node's
// AbortError can precede child close. Hold the caller's reservation until BOTH
// execFile's bounded result and the owned child's close have arrived. A failed
// command keeps its bounded stdout on the rejection: the CLI prints its JSON
// refusal and exits nonzero.
import { withoutControlToken } from "./control-environment.mjs";
import { execFile } from 'node:child_process';
export function runTerminalCommand(binary, args, options, exec = execFile) {
  return new Promise((resolve, reject) => {
    let result, closed = false;
    const settle = () => {
      if (!closed || !result) return;
      if (result.error) reject(Object.assign(result.error, { stdout: result.stdout })); else resolve({ stdout: result.stdout, stderr: result.stderr });
    };
    try {
      const child = exec(binary, args, { ...options, env: withoutControlToken(options?.env), shell: false }, (error, stdout, stderr) => {
        result = { error, stdout, stderr }; settle();
      });
      child.once('close', () => { closed = true; settle(); });
    } catch (error) { reject(error); } // spawn did not return an owned child
  });
}
