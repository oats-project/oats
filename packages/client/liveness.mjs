/** Terminal-target liveness for kernel-reported rows. This is unchanged,
 * v2-agnostic terminal observation: it consults tmux for the exact recorded
 * target, never deployment files. A library only: the program that runs it out
 * of the serving process is liveness-main.mjs (see packages/desktop/server/oats-web.mjs), so a slow
 * terminal server cannot stall request handling. */
import { createTmuxStatusReader, DEFAULT_TMUX_SESSION } from './tmux-status.mjs';
import { unsupportedSession, unsupportedSessionOrigin, sessionProvider } from './instance-presentation.mjs';

export { DEFAULT_TMUX_SESSION };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** rows: [{ instance, running?, tmux?, sessionTarget?, backend?, runtimeState?, runtimeError? }] in, one liveness
 * per row out. A Herdr-recorded row is never probed: it is unsupported, with the kernel's reason.
 *
 * A row on a session provider (instance-presentation.mjs `sessionProvider`: its `backend` is a provider's
 * name, "bb" say) is never probed either: it has no tmux target, so the reader would call it stopped. Its
 * `running`, `runtimeState` and `runtimeError` stay the kernel's, as for a `running: null` row, and the
 * answer carries no `tmux`. A row with no `backend`, or with "tmux", is read as before.
 *
 * The probe refines a row only when the kernel answered `running` true or false. A row it answered
 * `running: null` is not probed: its `running`, `runtimeState` and `runtimeError` stay the kernel's,
 * and the answer carries no `tmux`, so the merged row keeps the kernel's own. The kernel answers
 * unknown for a server it could not read, for a missing socket file while a process works in the
 * home, and for a record that cannot be read. Only its `runtimeError` text tells them apart, which
 * no client reads; for the last two a probe would say "stopped" and be wrong. The cost: a kernel
 * read that failed once shows the row as unknown until the next roster read. A row without a
 * `running` key (no kernel sends one) is probed. */
export function observeLiveness(rows, { tmuxReader = createTmuxStatusReader(), session = DEFAULT_TMUX_SESSION } = {}) {
  if (!Array.isArray(rows) || rows.length > 10000) throw new Error('Invalid liveness request');
  return rows.map(row => {
    if (!record(row) || typeof row.instance !== 'string') return { running: null, runtimeState: 'unreachable', runtimeError: 'Invalid terminal target' };
    const unsupported = unsupportedSession(row);
    if (unsupported) return { running: null, runtimeState: 'unsupported', runtimeError: unsupported.slice(0, 300), tmux: null };
    // After the unsupported check: an older kernel's Herdr row is `unreachable` with a sessionTarget, and reads unsupported.
    if (sessionProvider(row)) {
      const running = typeof row.running === 'boolean' ? row.running : null;
      return { running, ...(row.runtimeState !== undefined || running === null ? { runtimeState: row.runtimeState ?? 'unreachable' } : {}),
        ...(row.runtimeError ? { runtimeError: String(row.runtimeError).slice(0, 300) } : {}) };
    }
    if (row.running === null) return { running: null, runtimeState: row.runtimeState ?? 'unreachable', ...(row.runtimeError ? { runtimeError: String(row.runtimeError).slice(0, 300) } : {}) };
    const tmux = record(row.tmux) ? row.tmux : undefined;
    const { tmux: observed, running, runtimeState, runtimeError } = tmuxReader({ instance: row.instance, tmux }, session);
    return { tmux: observed, running, runtimeState, ...(runtimeError ? { runtimeError: String(runtimeError).slice(0, 300) } : {}) };
  });
}

/** Who makes the `runtimeError` of a row's answer, when the answer has one: "kernel", "terminal-probe",
 * or null for the stand-in of an older kernel's Herdr row. By the order `observeLiveness` takes, which is
 * a function of the row alone: an invalid row and a probed one are the terminal check's, a Herdr row's
 * text is the kernel's or the stand-in, and a row on a session provider and one the kernel answered
 * `running: null` keep the kernel's.
 * The collector's answer crosses a process as JSON, so the speaker is not put on that wire: the reader of
 * the answers asks here, of the row it sent (deployment-panel.mjs `livenessAnswers`). Not on the stable surface. */
export function livenessOrigin(row) {
  if (!record(row) || typeof row.instance !== 'string') return 'terminal-probe';
  if (unsupportedSession(row)) return unsupportedSessionOrigin(row);
  if (sessionProvider(row) || row.running === null) return 'kernel';
  return 'terminal-probe';
}
