// Fixed adapter composition for the leased terminal broker. All effects can be
// replaced by memory recorders; no renderer-selected program/environment.
import { isAbsolute } from 'node:path';
import { admitTerminalTarget } from './terminal-target.mjs';
import { openTerm, viewerTables } from './tmux-target.mjs';
import { localTmuxIo, tmuxSocketArgs } from './local-tmux-io.mjs';
import { remoteTerminalEnvironment } from './remote-target.mjs';
import { prepareRemoteTerm } from '../client/session-attach.mjs';
import { copyTerminalAttachments, prepareTerminalAttachments } from './terminal-attachments.mjs';
import { runTerminalCommand } from '../client/terminal-exec.mjs';
import { cliEnvironment } from '../client/cli-environment.mjs';

const changed = code => Object.assign(new Error('Terminal context changed'), { code });
const cliKey = cli => JSON.stringify([cli.bin, cli.version, [...(cli.remote || [])].sort(), [...(cli.features || [])].sort()]);
/** The server's accepted CLI, read through main's backend client (`fetch`: backendFetch, which takes a
 * path and reaches only main's own server), bounded to 1 MiB. */
export async function readTerminalCli({ fetch: fetcher, signal, current }) {
  if (!current() || signal?.aborted) throw changed('E_TERM_CONTEXT_CHANGED');
  const timeout = AbortSignal.timeout(5000);
  const response = await fetcher('/api/cli', { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!current() || signal?.aborted || !response.ok || !response.body?.getReader) throw changed('E_TERM_CONTEXT_CHANGED');
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (!current() || signal?.aborted) throw changed('E_TERM_CONTEXT_CHANGED');
      if (done) break;
      if (!(value instanceof Uint8Array) || (bytes += value.byteLength) > 1024 * 1024) throw new Error('CLI metadata exceeds budget');
      chunks.push(value);
    }
  } catch (error) { try { await reader.cancel(); } catch { /* already closed */ } throw error; }
  finally { reader.releaseLock(); }
  const cli = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)));
  if (cli?.ok !== true || typeof cli.bin !== 'string' || !isAbsolute(cli.bin) || cli.bin.length > 4096 || /[\x00-\x1f\x7f]/.test(cli.bin)
    || (cli.remote !== undefined && (!Array.isArray(cli.remote) || cli.remote.some(v => typeof v !== 'string')))
    || (cli.features !== undefined && (!Array.isArray(cli.features) || cli.features.some(v => typeof v !== 'string')))) throw new Error('CLI metadata unavailable');
  return cli;
}

export function createTerminalIo({ context, attachmentDirectory, spawnPty, execFileSync, sweep = () => {},
  fetch: fetcher, run: runCommand = runTerminalCommand, env = process.env, fs,
}) {
  const readCli = control => readTerminalCli({ fetch: fetcher, ...control });
  // Every program started here (tmux, `oats session …`) gets the user's environment, computed
  // from `env` when it starts (cli-environment.mjs). Last in the options: it is the one used.
  const run = (binary, args, options) => runCommand(binary, args, { ...options, env: cliEnvironment(env) });
  return {
    admit: admitTerminalTarget, copyAttachments: copyTerminalAttachments,
    async prepare(spec, control) {
      const cli = await readCli(control);
      // No kernel status line where the CLI can leave it out: the Desktop teaches the scroll keys
      // itself, in its shortcuts window (#1502), and the row is the agent's.
      const prepared = await prepareRemoteTerm(cli, spec.remote, { run, ...control, statusLine: false });
      const fresh = await readCli(control);
      if (cliKey(cli) !== cliKey(fresh) || !control.current()) throw changed('E_TERM_CONTEXT_CHANGED');
      return prepared;
    },
    create(spec, prepared, { current }) {
      const check = () => { if (!current()) throw changed('E_TERM_CONTEXT_CHANGED'); };
      check();
      if (spec.remote) return {
        pty: spawnPty(prepared.binary, prepared.args, { name: 'xterm-256color', cols: Math.max(20, spec.cols), rows: Math.max(5, spec.rows), cwd: env.HOME, env: remoteTerminalEnvironment(env) }),
        killViewer: () => {}, // CLI/SSH child owns its remote viewer, not a durable source
      };
      sweep(spec.socket); check();
      const local = localTmuxIo(spec.socket, { execFileSync, spawnPty, env });
      return openTerm(spec, {
        ...local,
        // Nonblocking cleanup lets the broker honor its2s pending receipt. The
        // same saved socket/exact owned viewer is used; no stronger signal.
        async cleanupViewer(viewer) {
          const prefix = tmuxSocketArgs(spec.socket), options = { encoding: 'utf8', timeout: 4000, maxBuffer: 1024 * 1024 };
          try { await run('tmux', [...prefix, 'kill-session', '-t', `=${viewer}`], options); }
          catch (error) {
            const result = await run('tmux', [...prefix, 'list-sessions', '-F', '#{session_name}'], options);
            if (result.stdout.split('\n').includes(viewer)) throw error;
          }
          // Then its own key tables (#1502); one left behind is the orphan sweep's.
          for (const table of viewerTables(viewer)) {
            try { await run('tmux', [...prefix, 'unbind-key', '-a', '-q', '-T', table], options); } catch { /* swept later */ }
          }
        },
        preflight: target => { check(); return local.preflight(target); },
        tmux: args => { if (args[0] !== 'kill-session') check(); return local.tmux(args); },
        tmuxOut: args => { if (args[0] !== 'list-sessions') check(); return local.tmuxOut(args); },
        spawnPty: (...args) => { check(); return local.spawnPty(...args); },
      });
    },
    async attachments(items, spec, control) {
      const epoch = spec.remote ? context() : undefined;
      const current = () => control.current() && (!spec.remote || (epoch !== null && epoch === context()));
      const check = () => { if (!current() || control.signal?.aborted) throw changed('E_TERM_ATTACHMENT_INTERRUPTED'); };
      check();
      const cli = spec.remote ? await readCli({ ...control, current }) : undefined;
      check();
      return prepareTerminalAttachments(items, { directory: attachmentDirectory(), remote: spec.remote, cli, fs,
        signal: control.signal, current,
        run: async (binary, args, options) => {
          const fresh = await readCli({ ...control, current }); check();
          if (cliKey(cli) !== cliKey(fresh)) throw changed('E_TERM_ATTACHMENT_INTERRUPTED');
          return run(binary, args, options);
        },
      });
    },
  };
}
