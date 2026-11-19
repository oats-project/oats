#!/usr/bin/env node
/** The operator's route to a team container's bb server. Runs on the
 * operator's machine and is never copied into an image.
 *
 *   node relay.mjs --ssh <alias> --listen <port> [--port 38886]
 *
 * Listens on 127.0.0.1:<port> only. Each incoming connection gets one SSH
 * command channel to the container, whose command pipes its stdio to bb on the
 * container's loopback: no port forwarding, so sshd's configuration stays as
 * it is. Whoever reaches the listening port drives that team's bb. */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** sshd admits ten sessions on one connection (MaxSessions); keep one spare. */
export const MUX_CHANNELS = 9;
const USAGE = "usage: node relay.mjs --ssh <alias> --listen <port> [--port 38886]";

const portOf = (text, name) => {
  if (!/^[1-9]\d{0,4}$/.test(text ?? "") || Number(text) > 65535) throw new Error(`${name} must be a port from 1 to 65535`);
  return Number(text);
};

/** `--listen` takes a port, or 127.0.0.1:<port>. No other address is accepted. */
export function parseArgs(argv) {
  const options = { port: "38886" };
  for (let i = 0; i < argv.length; i += 2) {
    const name = { "--ssh": "ssh", "--listen": "listen", "--port": "port" }[argv[i]];
    if (!name || argv[i + 1] === undefined) throw new Error(USAGE);
    options[name] = argv[i + 1];
  }
  if (!options.ssh || !options.listen) throw new Error(USAGE);
  // An alias that starts with a dash would be read by ssh as an option.
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.@-]*$/.test(options.ssh)) throw new Error("--ssh must be a host alias from your SSH configuration");
  const listen = options.listen.match(/^(?:(.*):)?([^:]*)$/);
  if (listen[1] !== undefined && listen[1] !== "127.0.0.1") {
    throw new Error("--listen accepts a port on 127.0.0.1 only: this port drives the team's bb, so reach it from elsewhere through your own tailnet, never by listening wider");
  }
  return { ssh: options.ssh, listen: portOf(listen[2], "--listen"), port: portOf(options.port, "--port") };
}

/** Starts the relay. `env` is the environment its ssh children get. */
export function startRelay({ ssh, listen, port = 38886, env = process.env, say = (line) => process.stderr.write(`bb-relay: ${line}\n`), masterRetryMs = 1_000, masterRetryMaxMs = 30_000, stopMs = 3_000, lingerMs = 30_000 }) {
  // A private directory keeps the control socket away from other users and from
  // any ControlPath of the operator's own configuration.
  const dir = mkdtempSync(join(tmpdir(), "bb-relay-")), control = join(dir, "m");
  const remote = `node -e 'const s=require("node:net").connect(${port},"127.0.0.1");process.stdin.pipe(s);s.pipe(process.stdout);s.on("error",()=>process.exit(1));'`;
  const common = ["-o", "BatchMode=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];
  const channels = new Set(), sockets = new Set();
  let master, masterTimer, retryMs = masterRetryMs, multiplexed = 0, stopping = false;

  const startMaster = () => {
    masterTimer = undefined;
    if (stopping) return;
    const started = Date.now();
    const child = spawn("ssh", ["-M", "-N", "-S", control, "-o", "ControlPersist=no", ...common, ssh], { env, stdio: ["ignore", "ignore", "inherit"] });
    master = child;
    const ended = (why) => {
      if (master !== child) return;
      master = undefined;
      rmSync(control, { force: true }); // a dead master's socket would only delay the next channel
      if (stopping) return;
      if (Date.now() - started >= 60_000) retryMs = masterRetryMs;
      say(`the SSH master connection ended (${why}); new connections go direct until it is back`);
      masterTimer = setTimeout(startMaster, retryMs);
      retryMs = Math.min(retryMs * 2, masterRetryMaxMs);
    };
    child.once("error", (error) => ended(error.code || "could not start"));
    child.once("exit", (code, signal) => ended(signal || code));
  };

  const server = createServer({ allowHalfOpen: true }, (socket) => {
    // The socket file appears once the master has authenticated.
    const mux = !!master && multiplexed < MUX_CHANNELS && existsSync(control);
    const child = spawn("ssh", ["-T", "-o", "ControlMaster=no", ...(mux ? ["-S", control] : ["-o", "ControlPath=none"]), ...common, ssh, remote], { env, stdio: ["pipe", "pipe", "inherit"] });
    if (mux) multiplexed += 1;
    channels.add(child);
    sockets.add(socket);
    let open = true;
    const ended = () => {
      if (!open) return false;
      open = false;
      if (mux) multiplexed -= 1;
      channels.delete(child);
      return true;
    };
    socket.pipe(child.stdin);
    child.stdout.pipe(socket); // ends the socket after the channel's last byte
    child.stdin.on("error", () => {}); // the channel ended first
    socket.on("error", () => child.kill());
    socket.on("close", () => { sockets.delete(socket); child.kill(); });
    child.once("error", (error) => {
      if (ended()) { say(`ssh could not start (${error.code || "error"})`); socket.destroy(); }
    });
    // The channel may end before a slow client has read its answer: never
    // destroy the socket here. Discard what the client still sends, and give
    // up on a client that neither reads nor closes.
    child.once("exit", () => {
      if (!ended()) return;
      socket.unpipe(child.stdin);
      socket.resume();
      socket.setTimeout(lingerMs, () => socket.destroy());
    });
  });

  const listening = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listen, "127.0.0.1", () => {
      say(`listening on 127.0.0.1:${server.address().port} for bb at ${ssh} (127.0.0.1:${port} in the container)`);
      resolve();
    });
  });
  listening.catch(() => {});
  startMaster();

  /** Closes the listener, every channel and the master; resolves when they are gone. */
  const stop = () => {
    if (stopping) return stopping;
    stopping = new Promise((resolve) => {
      const children = [...channels, ...(master ? [master] : [])];
      const escalation = setTimeout(() => { for (const child of children) child.kill("SIGKILL"); }, stopMs);
      let left = children.length;
      const done = () => { clearTimeout(escalation); rmSync(dir, { recursive: true, force: true }); resolve(); };
      clearTimeout(masterTimer);
      server.close();
      for (const socket of sockets) socket.destroy();
      if (!left) { done(); return; }
      for (const child of children) {
        let counted = false;
        const gone = () => { if (!counted) { counted = true; if (!(left -= 1)) done(); } };
        if (child.exitCode !== null || child.signalCode !== null) { gone(); continue; }
        child.once("exit", gone);
        child.once("error", gone);
        child.kill("SIGTERM");
      }
    });
    return stopping;
  };
  return { server, listening, stop };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let relay;
  try {
    relay = startRelay(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`bb-relay: ${error.message}\n`);
    process.exit(2);
  }
  const end = (code) => relay.stop().then(() => process.exit(code));
  relay.listening.catch((error) => {
    process.stderr.write(`bb-relay: cannot listen on 127.0.0.1 (${error.code || error.message})\n`);
    end(1);
  });
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => end(0));
}
