// Installs the fake `oats` (container/fake-oats.mjs) in a temporary directory, with the behaviour a
// test asks for, and reads back the calls it logged.
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(here, "..", "fixtures");
const SCRIPT = join(here, "..", "..", "container", "fake-oats.mjs");

export type Behaviour = { file?: string; stdout?: string; exit?: number; sleepMs?: number; grandchild?: boolean; stderr?: string };
export type Call = {
  pid: number;
  verb: string;
  argv: string[];
  cwd: string;
  taskFile?: { path: string; mode?: string; text?: string; error?: string };
  grandchild?: number;
};

export type FakeOats = {
  /** The directory that stands for the deployment (it holds `oats-local.yaml`). */
  deployment: string;
  /** The absolute path of the fake `oats`. */
  bin: string;
  /** A directory for the task files of a spawn. */
  tempDir: string;
  calls(): Promise<Call[]>;
  /** Replaces the behaviour of the verbs named; the others answer their fixture. */
  behave(verbs: Record<string, Behaviour>): Promise<void>;
  remove(): Promise<void>;
};

export async function installFakeOats(verbs: Record<string, Behaviour> = {}): Promise<FakeOats> {
  const root = await mkdtemp(join(tmpdir(), "bb-plugin-oats-"));
  const bin = join(root, "oats");
  const log = join(root, "calls.jsonl");
  const config = join(root, "fake-oats.json");
  await copyFile(SCRIPT, bin);
  await chmod(bin, 0o755);
  const behave = (next: Record<string, Behaviour>) => writeFile(config, JSON.stringify({ fixtures: FIXTURES, log, verbs: next }));
  await behave(verbs);
  await writeFile(join(root, "oats-local.yaml"), "# a deployment, for the tests\n");
  return {
    deployment: root,
    bin,
    tempDir: join(root, "tmp"),
    behave,
    async calls() {
      let text: string;
      try {
        text = await readFile(log, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      return text
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Call);
    },
    remove: () => rm(root, { recursive: true, force: true }),
  };
}

/** True while `pid` names a process that is not a zombie. Linux only, like the container the tests run in. */
export async function alive(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    // The state is the field after the command name, which is in parentheses and may hold spaces.
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

/** Waits until none of `pids` is alive, or fails after `timeoutMs` naming the survivors. */
export async function gone(pids: number[], timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left: number[] = [];
    for (const pid of pids) if (await alive(pid)) left.push(pid);
    if (left.length === 0) return;
    if (Date.now() > deadline) throw new Error(`still running after ${timeoutMs} ms: ${left.join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
