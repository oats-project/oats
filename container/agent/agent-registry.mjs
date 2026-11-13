/** The single public registry selector shared by startup and shell sessions. */
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const REGISTRY_DIRECTORY = "/tmp/agent-registry";
const refusal = () => new Error("AWID_REGISTRY_URL must be an HTTPS origin, for example https://registry.example.test");

export function registryOrigin(value) {
  if (value === undefined) return undefined;
  let url;
  try { url = new URL(value); } catch { throw refusal(); }
  if (typeof value !== "string" || value.length > 2048
    || !/^https:\/\/[^\s\\/@?#]+\/?$/.test(value) || !url
    || url.protocol !== "https:" || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash) {
    throw refusal();
  }
  return value;
}

/** Called before any child starts. Data is private, not immutable against the
 * other agents sharing this UID; never install executable shell text here. */
export function prepareRegistryInput(value, directory = REGISTRY_DIRECTORY) {
  value = registryOrigin(value);
  const file = join(directory, "registry-url");
  try {
    let stat;
    try { stat = lstatSync(directory); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!stat) {
      if (value === undefined) return;
      mkdirSync(directory, { mode: 0o700 });
      stat = lstatSync(directory);
    }
    if (!stat.isDirectory() || stat.uid !== process.getuid()) throw refusal();
    chmodSync(directory, 0o700);
    try { unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (value === undefined) return;
    const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o400);
    try { writeFileSync(fd, value); } finally { closeSync(fd); }
  } catch {
    throw new Error("AWID_REGISTRY_URL runtime data could not be prepared at /tmp/agent-registry/registry-url");
  }
}

/** Re-read for every shell: the data is not executable, and a malformed or
 * unreadable present input must never become aw's absent/default selector. */
export function readRegistryInput(directory = REGISTRY_DIRECTORY) {
  const file = join(directory, "registry-url");
  let fd;
  try {
    let stat;
    try { stat = lstatSync(directory); }
    catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
    if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) throw refusal();
    try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
    stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1
      || (stat.mode & 0o777) !== 0o400 || stat.size > 2048) throw refusal();
    const bytes = Buffer.alloc(2049);
    const length = readSync(fd, bytes, 0, bytes.length, null);
    if (length !== stat.size) throw refusal();
    return registryOrigin(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
  } catch {
    throw new Error("AWID_REGISTRY_URL runtime data is invalid or unreadable at /tmp/agent-registry/registry-url");
  } finally { if (fd !== undefined) closeSync(fd); }
}

// The fixed shell profile reports one refusal and keeps the shell open. A
// nonzero result selects its invalid, nonempty sentinel instead of aw's default.
if (process.argv[1] && process.argv[1] !== "-" && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== "--profile") throw refusal();
    process.stdout.write(readRegistryInput() ?? "");
  } catch { process.exitCode = 1; }
}
