/** Launch references stay references in recipes. Values live only on the execution host. */
import { closeSync, constants, fstatSync, openSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { shellWord } from "./shell-word.mjs";

export const referenceSource = (ref) => ref.fromFile !== undefined ? `file:${ref.fromFile}` : ref.fromEnv;
export function referenceValue(ref, env) {
  if (ref.fromFile === undefined) return env[ref.fromEnv];
  let fd;
  try {
    // Nonblocking open and fstat also refuse a FIFO swapped in after preflight.
    fd = openSync(ref.fromFile, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return undefined;
    const text = readFileSync(fd, "utf8");
    return text.includes("\0") ? undefined : text.replace(/\r?\n$/, "");
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function fileReferenceRemedy(names, harness = "<harness>") {
  return names.some((name) => name.startsWith("file:")) ? `; restore the readable credential file with oats harness token set ${harness} --server <id>, or ask the operator to provision it on this host` : "";
}

/** Private, one-use reference handoff. Never put values in tmux argv or its command string. */
export const LAUNCH_ENV_HANDOFF = /^\.oats-launch-env-[A-Za-z0-9-]+\.sh$/;
export function launchEnvHandoff(home, startId, refs) {
  if (!refs.length) return { wrap: (command) => command, remove: () => {} };
  if (!/^[A-Za-z0-9-]+$/.test(startId)) throw new Error("invalid launch environment start id");
  const file = join(home, `.oats-launch-env-${startId}.sh`);
  const content = refs.map((ref) => {
    if (!/^OATS_LAUNCH_REF_[A-Za-z_][A-Za-z0-9_]*$/.test(ref.name) || ref.value.includes("\0")) throw new Error("invalid launch environment reference");
    return `export ${ref.name}=${shellWord(ref.value)}\n`;
  }).join("");
  writeFileSync(file, content, { mode: 0o600, flag: "wx" });
  const launcher = fileURLToPath(new URL("./launch-env-exec.sh", import.meta.url));
  return {
    wrap: (command) => `/bin/sh ${shellWord(launcher)} ${shellWord(file)} /bin/sh -c ${shellWord(command)}`,
    remove: () => rmSync(file, { force: true }),
  };
}
