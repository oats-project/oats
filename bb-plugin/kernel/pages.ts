// The four read verbs behind the pages: `oats souls`, `oats capabilities`, `oats teams` and
// `oats server list`, each read into the rows the pages draw (docs/desktop-cli-api.md).
import { z } from "zod";
import type { Capability, Machine, Soul, Team } from "../model/types.js";
import { shaped } from "./envelope.js";
import { ok, type Result } from "./result.js";

const text = z.string().nullish();

// ---- oats souls --json ----
export const soulsArgv = (): string[] => ["souls", "--json"];

const soulRow = z.looseObject({
  name: z.string().min(1),
  key: text,
  qualifiedName: text,
  origin: text,
  description: text,
  spawnable: z.boolean().nullish(),
  problem: z.looseObject({ code: text, message: text }).nullish(),
  capabilities: z.array(z.looseObject({ name: z.string() })).nullish(),
});
const soulsDocument = z.looseObject({ souls: z.array(soulRow) });

export function parseSouls(document: unknown): Result<{ souls: Soul[] }> {
  const parsed = shaped(soulsDocument, document, "oats souls");
  if (!parsed.ok) return parsed;
  return ok({
    souls: parsed.value.souls.map((row) => {
      const problem = row.problem ? [row.problem.code, row.problem.message].filter(Boolean).join(": ") : null;
      return {
        // The soul key is what `oats spawn` takes: `<package>/<soul>` for a package soul.
        name: row.key ?? row.qualifiedName ?? row.name,
        description: row.description ?? "",
        origin: row.origin ?? "",
        capabilities: (row.capabilities ?? []).map((capability) => capability.name),
        // A kernel that does not say is taken at its word for the rest: a spawn it refuses says why.
        spawnable: row.spawnable ?? problem === null,
        problem,
      };
    }),
  });
}

// ---- oats capabilities --json ----
export const capabilitiesArgv = (): string[] => ["capabilities", "--json"];

const capabilitiesDocument = z.looseObject({
  capabilities: z.array(z.looseObject({ name: z.string().min(1), origin: text, description: text })),
});

export function parseCapabilities(document: unknown): Result<{ capabilities: Omit<Capability, "souls">[] }> {
  const parsed = shaped(capabilitiesDocument, document, "oats capabilities");
  if (!parsed.ok) return parsed;
  return ok({
    capabilities: parsed.value.capabilities.map((row) => ({
      id: row.name,
      description: row.description ?? "",
      origin: row.origin ?? "",
    })),
  });
}

/** The number of souls that compose each capability, from the souls' own lists. */
export function withSoulCounts(capabilities: Omit<Capability, "souls">[], souls: Soul[]): Capability[] {
  const counts = new Map<string, number>();
  for (const soul of souls) for (const id of new Set(soul.capabilities)) counts.set(id, (counts.get(id) ?? 0) + 1);
  return capabilities.map((capability) => ({ ...capability, souls: counts.get(capability.id) ?? 0 }));
}

// ---- oats teams --json ----
export const teamsArgv = (): string[] => ["teams", "--json"];

const teamsDocument = z.looseObject({
  teams: z.array(z.looseObject({ label: z.string().min(1), team: text, default: z.boolean().nullish() })),
});

/** `team` is null for a shared team no provider id is committed for yet. */
export type KernelTeam = Omit<Team, "team"> & { team: string | null };

export function parseTeams(document: unknown): Result<{ teams: KernelTeam[] }> {
  const parsed = shaped(teamsDocument, document, "oats teams");
  if (!parsed.ok) return parsed;
  return ok({
    teams: parsed.value.teams.map((row) => ({ label: row.label, team: row.team ?? null, isDefault: row.default === true })),
  });
}

// ---- oats server list --json ----
export const serversArgv = (): string[] => ["server", "list", "--json"];

const serversDocument = z.looseObject({
  servers: z.array(
    z.looseObject({ id: z.string().min(1), sshHost: text, workspace: text, label: text, snapshots: z.number().nullish() }),
  ),
});

/** The registered servers, as the kernel last recorded them. The plugin runs no `oats server check`. */
export function parseServers(document: unknown): Result<{ machines: Machine[] }> {
  const parsed = shaped(serversDocument, document, "oats server list");
  if (!parsed.ok) return parsed;
  return ok({
    machines: parsed.value.servers.map((row) => {
      const saved = row.snapshots ?? 0;
      const note = [
        row.label && row.label !== row.id ? row.label : null,
        row.workspace ? `workspace ${row.workspace}` : null,
        `${saved} saved instance route${saved === 1 ? "" : "s"}`,
      ].filter((part): part is string => part !== null);
      return { id: row.id, route: row.sshHost ?? null, isThisMachine: false, note: note.join(" · ") };
    }),
  });
}
