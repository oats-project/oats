/** Launch references stay references in recipes. Values live only on the execution host. */
import { closeSync, constants, fstatSync, openSync, readSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";
import { isAbsolute, join } from "node:path";
import { shellWord } from "./shell-word.mjs";

/** The same reference grammar validates declarations and recorded launch recipes. */
export function isLaunchEnvReference(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1
    && ((typeof value.fromEnv === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.fromEnv))
      || (typeof value.fromFile === "string" && isAbsolute(value.fromFile) && !value.fromFile.includes("\0")));
}

export const referenceSource = (ref) => ref.fromFile !== undefined ? `file:${ref.fromFile}` : ref.fromEnv;
const FILE_MAX_BYTES = 64 * 1024;
/** Resolve a reference without ever putting its bytes in a diagnostic. */
export function readLaunchReference(ref, env) {
  if (ref.fromFile === undefined) return { value: env[ref.fromEnv] };
  let fd;
  const tooLarge = { problem: "is larger than 64 KiB; fromFile holds a credential value, not a file's contents" };
  try {
    fd = openSync(ref.fromFile, constants.O_RDONLY | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile()) return { problem: "is not a regular file" };
    if (before.size > FILE_MAX_BYTES) return tooLarge;
    // One extra byte detects growth during this bounded read, without ever reading a log whole.
    const bytes = Buffer.alloc(FILE_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > FILE_MAX_BYTES || fstatSync(fd).size > FILE_MAX_BYTES) return tooLarge;
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)); }
    catch { return { problem: "is not UTF-8" }; }
    return text.includes("\0") ? { problem: "contains NUL" } : { value: text.replace(/\r?\n$/, "") };
  } catch (error) { return { problem: error.code === "ENOENT" ? "is missing" : "cannot be read" }; }
  finally { if (fd !== undefined) closeSync(fd); }
}
export const referenceValue = (ref, env) => readLaunchReference(ref, env).value;
export function fileReferenceProblems(names) {
  return names.filter((name) => name.startsWith("file:")).map((name) => {
    const path = name.slice(5), { problem } = readLaunchReference({ fromFile: path }, {});
    return `file reference ${path} ${problem || "is unavailable"}`;
  });
}
export function fileReferenceRemedy(names, harness = "<harness>") {
  return names.some((name) => name.startsWith("file:")) ? `; restore the readable credential file with oats harness token set ${harness} --server <id>, or ask the operator to provision it on this host` : "";
}

/** Private, one-use reference handoff. Never put values in tmux argv or its command string. */
export const LAUNCH_ENV_HANDOFF = /^\.oats-launch-env-[A-Za-z0-9-]+\.sh$/;
export function launchEnvHandoff(home, startId, refs) {
  if (!/^[A-Za-z0-9-]+$/.test(startId)) throw new Error("invalid launch environment start id");
  const current = `.oats-launch-env-${startId}.sh`;
  // Starts are serialized by the home's lifecycle claim. A previous pane may have died
  // before consuming its handoff; remove that plaintext before this start dispatches.
  for (const name of readdirSync(home)) if (LAUNCH_ENV_HANDOFF.test(name) && name !== current) rmSync(join(home, name), { force: true });
  if (!refs.length) return { wrap: (command) => command, remove: () => {} };
  const file = join(home, current);
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
