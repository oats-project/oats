// The task of a spawn travels as a file, never as an argv element: a 0600 file of its own in the
// host entry's temporary directory, removed when the call ends, however it ends.
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function withTaskFile<Value>(directory: string, task: string, use: (path: string) => Promise<Value>): Promise<Value> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `task-${randomBytes(12).toString("hex")}.md`);
  // "wx": a path that exists is refused, so the file written is the file `oats` reads.
  await writeFile(path, task, { mode: 0o600, flag: "wx" });
  try {
    return await use(path);
  } finally {
    await rm(path, { force: true });
  }
}
