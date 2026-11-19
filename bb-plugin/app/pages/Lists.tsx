// Capabilities, Teams and Machines: what `oats capabilities`, `oats teams` and `oats server list`
// answer for this deployment. Lists only: nothing here acts, and the Machines page runs no check.
import type { ReactNode } from "react";
import { clean, count } from "../format";
import { failureLine, useOats } from "../oats";
import { useRead } from "../store";
import type { Read } from "../store";
import { Chip, ErrorLine, Heading, Note, Page } from "../ui";

/** A page that is one read: its loading line, its error with Retry, then its rows. */
function ReadPage<T>({
  testId,
  read,
  children,
}: {
  testId: string;
  read: Read<T> & { retry(): void };
  children: (data: T) => ReactNode;
}) {
  return (
    <Page testId={testId}>
      {read.status === "error" ? <ErrorLine onRetry={read.retry}>{clean(read.error)}</ErrorLine> : null}
      {read.data === undefined ? (read.status === "loading" ? <Note>Reading OATS…</Note> : null) : children(read.data)}
    </Page>
  );
}

const ROW = "flex flex-col gap-1 border-b border-border py-2 last:border-b-0";

export function CapabilitiesPage() {
  const read = useRead("capabilities");
  return (
    <ReadPage testId="oats-capabilities-page" read={read}>
      {({ capabilities }) => (
        <>
          <Heading n={capabilities.length}>Capabilities</Heading>
          {capabilities.length === 0 ? <Note>This deployment has no capabilities.</Note> : null}
          <ul className="flex flex-col">
            {capabilities.map((capability) => (
              <li key={capability.id} data-testid="oats-capability-row" className={ROW}>
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <span className="min-w-0 break-words font-semibold">{clean(capability.id)}</span>
                  <span className="text-xs text-muted-foreground">{`used by ${count(capability.souls, "soul")}`}</span>
                </div>
                {capability.description === "" ? null : <p className="whitespace-pre-wrap break-words">{clean(capability.description)}</p>}
                <p className="break-words text-xs text-muted-foreground">{`from ${clean(capability.origin)}`}</p>
              </li>
            ))}
          </ul>
        </>
      )}
    </ReadPage>
  );
}

export function TeamsPage() {
  const read = useRead("teams");
  const oats = useOats();
  return (
    <ReadPage testId="oats-teams-page" read={read}>
      {({ teams }) => (
        <>
          <Heading n={teams.length}>Teams</Heading>
          {teams.length === 0 ? <Note>This deployment defines no teams.</Note> : null}
          <ul className="flex flex-col">
            {teams.map((team) => (
              <li key={team.label} data-testid="oats-team-row" className={ROW}>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="min-w-0 break-words font-semibold">{clean(team.label)}</span>
                  {team.isDefault ? <Chip>default</Chip> : null}
                  {team.team !== null && oats.phase === "ready" ? (
                    <span className="text-xs text-muted-foreground">
                      {count(oats.agents.filter((agent) => agent.team === team.team).length, "agent")}
                    </span>
                  ) : null}
                </div>
                {/* A shared team with no provider id yet: nothing can be counted under it. */}
                <p className="break-all text-xs text-muted-foreground">{team.team === null ? "not mapped" : clean(team.team)}</p>
              </li>
            ))}
          </ul>
        </>
      )}
    </ReadPage>
  );
}

export function MachinesPage() {
  const read = useRead("machines");
  const oats = useOats();
  return (
    <ReadPage testId="oats-machines-page" read={read}>
      {({ machines }) => (
        <>
          <section data-testid="oats-this-machine" className="flex flex-col gap-1">
            <Heading>This machine</Heading>
            {oats.phase === "ready" ? (
              <>
                <p className="break-words font-semibold">{clean(oats.deployment.machine)}</p>
                <p className="text-xs text-muted-foreground">
                  {`${count(oats.agents.filter((agent) => agent.backend === "bb").length, "agent")} in bb · ${count(
                    oats.agents.filter((agent) => agent.backend !== "bb").length,
                    "agent",
                  )} elsewhere`}
                </p>
                <p className="break-all text-xs text-muted-foreground">{clean(oats.deployment.root)}</p>
              </>
            ) : oats.phase === "loading" ? (
              <Note>Reading OATS…</Note>
            ) : (
              <ErrorLine onRetry={oats.retry}>{clean(failureLine(oats))}</ErrorLine>
            )}
          </section>
          <section className="flex flex-col gap-1">
            <Heading n={machines.length}>Servers OATS knows</Heading>
            {machines.length === 0 ? <Note>OATS has no other server recorded.</Note> : null}
            <ul className="flex flex-col">
              {machines.map((machine) => (
                <li key={machine.id} data-testid="oats-machine-row" className={ROW}>
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="min-w-0 break-words font-semibold">{clean(machine.id)}</span>
                    {machine.isThisMachine ? <Chip>this machine</Chip> : null}
                  </div>
                  {machine.route === null ? null : <p className="break-all text-xs text-muted-foreground">{clean(machine.route)}</p>}
                  {machine.note === null ? null : <p className="whitespace-pre-wrap break-words text-xs">{clean(machine.note)}</p>}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </ReadPage>
  );
}
