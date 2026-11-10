// The record store holds agents' conversations, so what it creates is for its
// owner alone: files 0600, directories 0700. A mode applies when the file or
// directory is created; one that exists keeps the permissions it has.
import { closeSync, mkdirSync, openSync } from "node:fs";

export const PRIVATE_FILE = 0o600;
export const PRIVATE_DIR = 0o700;

/** Create `path` and its missing ancestors, each private. */
export function makePrivateDir(path) {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIR });
}

/** Create `path` as an empty private file when it is absent, for an opener
 *  that takes no mode (SQLite, whose journal files take the database's). */
export function ensurePrivateFile(path) {
  closeSync(openSync(path, "a", PRIVATE_FILE));
}
