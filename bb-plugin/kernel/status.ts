// `oats status --json`: the roster, read into the plugin's Agent rows (the interface agreed with the
// kernel side, v2). Unknown fields are ignored; a row with no `instance` fails the whole read.
import { z } from "zod";
import type { Agent } from "../model/types.js";
import { shaped } from "./envelope.js";
import { ok, type Result } from "./result.js";

export const statusArgv = (): string[] => ["status", "--json"];

const text = z.string().nullish();
const row = z.looseObject({
  instance: z.string().min(1),
  agent: text,
  home: z.string().min(1),
  parentInstance: text,
  attributedHuman: text,
  identity: z.looseObject({ alias: text, team: text, address: text }).nullish(),
  identityAddress: text,
  capabilityMeta: z.record(z.string(), z.unknown()).nullish(),
  backend: text,
  session: z
    .looseObject({ endpoint: z.looseObject({ server: text, projectId: text, threadId: text }).nullish() })
    .nullish(),
  running: z.boolean().nullish(),
  runtimeState: text,
  runtimeError: text,
  waitingOnYou: z.looseObject({ since: text, reason: text, message: text }).nullish(),
});
const roster = z.looseObject({
  root: z.string(),
  agents: z.array(z.looseObject({ name: z.string().min(1), instances: z.array(row) })),
  workspace: z.looseObject({ key: text }).nullish(),
});

const identityMeta = z.looseObject({ alias: text, team: text });

export type Status = { root: string; workspace: string | null; agents: Agent[] };

function toAgent(group: string, source: z.output<typeof row>): Agent {
  // The messaging identity: the row's own `identity`, else what a messaging capability recorded.
  let alias = source.identity?.alias ?? null;
  let team = source.identity?.team ?? null;
  if (alias === null) {
    for (const meta of Object.values(source.capabilityMeta ?? {})) {
      const parsed = identityMeta.safeParse(meta);
      if (parsed.success && parsed.data.alias) {
        alias = parsed.data.alias;
        team = parsed.data.team ?? team;
        break;
      }
    }
  }
  const endpoint = source.session?.endpoint ?? null;
  const waiting = source.waitingOnYou ?? null;
  return {
    instance: source.instance,
    soul: source.agent ?? group,
    home: source.home,
    parent: source.parentInstance ?? null,
    human: source.attributedHuman ?? null,
    alias,
    team,
    address: source.identityAddress ?? source.identity?.address ?? null,
    // A row of a kernel that names no backend is a tmux home: tmux was the only one.
    backend: source.backend ?? "tmux",
    server: endpoint?.server ?? null,
    projectId: endpoint?.projectId ?? null,
    threadId: endpoint?.threadId ?? null,
    running: source.running ?? null,
    runtimeState: source.runtimeState ?? null,
    runtimeError: source.runtimeError ?? null,
    waiting: waiting
      ? { reason: waiting.reason ?? "attention", message: waiting.message ?? null, since: waiting.since ?? null }
      : null,
  };
}

/** The roster's instances, in the kernel's order. */
export function parseStatus(document: unknown): Result<Status> {
  const parsed = shaped(roster, document, "oats status");
  if (!parsed.ok) return parsed;
  const agents: Agent[] = [];
  for (const group of parsed.value.agents) for (const source of group.instances) agents.push(toAgent(group.name, source));
  return ok({ root: parsed.value.root, workspace: parsed.value.workspace?.key ?? null, agents });
}
