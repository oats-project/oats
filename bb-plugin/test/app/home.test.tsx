// @vitest-environment jsdom
// A10: the OATS home (navPanel `home`, and the fixed thread tab) and its badge.
import { afterEach, expect, test } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { RenderSlotOptions } from "@get-bb/plugin-sdk/testing/app";
import type { ComponentType } from "react";
import type { ExperimentalBadge, ExperimentalThreadTabProps } from "@get-bb/plugin-sdk/app";
import { fixtureAgents } from "../helpers/fixtures";
import { handlers, loadApp, resetApp, sidebarThreads } from "../helpers/render";
import type { Contract } from "../helpers/render";
import type { Agent } from "../../model/types";

afterEach(resetApp);

const quiet = (): Agent[] =>
  fixtureAgents().map((agent) => ({ ...agent, waiting: null, running: agent.running === true ? null : agent.running }));
const calm = () => {
  const threads = sidebarThreads();
  return { ...threads, threads: threads.threads.map((thread) => ({ ...thread, hasPendingInteraction: false, isUnread: false })) };
};

/** bb lists nothing pending: the cards show the kernel's claims. */
const NO_INTERACTIONS = { threads: { interactions: { list: async () => [] as never } } };

async function homePage(options: RenderSlotOptions<Contract> = {}) {
  const app = await loadApp();
  const panel = app.navPanels.find((candidate) => candidate.id === "home")!;
  expect(panel.path).toBe("home");
  expect(panel.experimental_hideFromNavigation).toBeUndefined(); // shown in bb's navigation
  return renderSlot<{ subPath: string }, Contract>(panel, { subPath: "" }, { rpc: handlers(), sidebarThreads: sidebarThreads(), sdk: NO_INTERACTIONS, ...options });
}

const heading = (section: HTMLElement) => section.querySelector("h2")!.textContent;

test("the three counts from the fixtures: 3 need you, 2 working, 1 finished and not looked at", async () => {
  const slot = await homePage();
  const needs = await slot.findByTestId("oats-home-needs");
  expect(heading(needs)).toBe("Needs you3");
  expect(within(needs).getAllByTestId("oats-needs-card")).toHaveLength(3);
  const working = slot.getByTestId("oats-home-working");
  expect(heading(working)).toBe("Working2");
  expect(within(working).getAllByTestId("oats-working-row")).toHaveLength(2);
  const finished = slot.getByTestId("oats-home-finished");
  expect(heading(finished)).toBe("Finished, not looked at1");
  expect(within(finished).getAllByTestId("oats-finished-row").map((row) => row.textContent)).toEqual([
    "Harvest knowledgeknowledge-harvester",
  ]);
});

test("a card shows the title, the claim's question and Open; a click opens the thread", async () => {
  const slot = await homePage();
  const cards = await slot.findAllByTestId("oats-needs-card");
  const release = cards.find((card) => card.textContent!.includes("Release 0.70"))!;
  expect(within(release).getByTestId("oats-needs-question").textContent).toBe("Green light at 9f2e1c? Second reader done.");
  fireEvent.click(within(release).getByTestId("oats-needs-open"));
  fireEvent.click(within(slot.getByTestId("oats-home-working")).getAllByTestId("oats-working-row")[0]!);
  expect(slot.inspection.navigateCalls).toEqual([
    { method: "toThread", threadId: "thr_release" },
    { method: "toThread", threadId: "thr_redesign" },
  ]);
});

test('with none: "Nothing waits on you.", and each empty section says so in one line', async () => {
  const slot = await homePage({ rpc: handlers({}, quiet()), sidebarThreads: calm() });
  const needs = await slot.findByTestId("oats-home-needs");
  expect(needs.textContent).toBe("Needs you0Nothing waits on you.");
  expect(slot.getByTestId("oats-home-working").textContent).toBe("Working0No agent is working.");
  expect(slot.getByTestId("oats-home-finished").textContent).toBe("Finished, not looked at0Nothing new to look at.");
});

async function badge(options: RenderSlotOptions<Contract>): Promise<() => ExperimentalBadge | null | "unset"> {
  const app = await loadApp();
  const useBadge = app.navPanels.find((candidate) => candidate.id === "home")!.experimental_useBadge!;
  let latest: ExperimentalBadge | null | "unset" = "unset";
  let snapshots = 0;
  const rpc = options.rpc ?? handlers();
  renderSlot<object, Contract>(
    {
      component: function Badge() {
        latest = useBadge();
        return null;
      },
    },
    {},
    { sidebarThreads: sidebarThreads(), ...options, rpc: { ...rpc, snapshot: (input) => (snapshots++, rpc.snapshot(input)) } },
  );
  await waitFor(() => expect(snapshots).toBe(1));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return () => latest;
}

test("the badge hook returns the count of agents that need you, with the warning tone", async () => {
  const latest = await badge({});
  await waitFor(() => expect(latest()).toEqual({ count: 3, tone: "warning", label: "3 agents need you" }));
});

test("the badge hook returns null at 0", async () => {
  const latest = await badge({ rpc: handlers({}, quiet()), sidebarThreads: calm() });
  expect(latest()).toBeNull();
});

test("the badge hook returns null while OATS cannot be read", async () => {
  const latest = await badge({
    rpc: handlers({ snapshot: () => ({ ok: false, at: "t", code: "E_PLUGIN_OATS_MISSING", message: "oats: not found" }) }),
  });
  expect(latest()).toBeNull();
});

test("a pending interaction with no claim: bb's title is the question, and its choices answer in place", async () => {
  const agents = fixtureAgents().map((agent) => (agent.instance === "flaky-ci-developer" ? { ...agent, waiting: null } : agent));
  let pending = true;
  const slot = await homePage({
    rpc: handlers({}, agents),
    sdk: {
      threads: {
        interactions: {
          list: async () =>
            (pending
              ? [
                  {
                    id: "pint_1",
                    threadId: "thr_ci",
                    status: "pending",
                    payload: { kind: "provider-pi/extension-ui", title: "Confirm", data: { requestId: "r1", method: "confirm", fullTitle: "Force-push to fix/ci-race?" } },
                  },
                ]
              : []) as never,
          respond: async () => ((pending = false), {}) as never,
        },
      },
    },
  });
  const card = (await slot.findAllByTestId("oats-needs-card")).find((candidate) => candidate.textContent!.includes("Fix flaky CI test"))!;
  await waitFor(() => expect(within(card).getByTestId("oats-needs-question").textContent).toBe("Force-push to fix/ci-race?"));
  const choices = within(card).getAllByTestId("oats-needs-choice");
  expect(choices.map((choice) => choice.textContent)).toEqual(["Yes", "No"]);
  fireEvent.click(choices[0]!);
  await waitFor(() => expect(within(card).queryAllByTestId("oats-needs-choice")).toEqual([]));
  expect(slot.inspection.sdkCalls.filter((call) => call.method === "threads.interactions.respond")).toEqual([
    { method: "threads.interactions.respond", args: [{ threadId: "thr_ci", interactionId: "pint_1", value: true }] },
  ]);
  // only the thread bb reports a pending interaction for was asked about
  expect(slot.inspection.sdkCalls.filter((call) => call.method === "threads.interactions.list").map((call) => (call.args[0] as { threadId: string }).threadId)).toEqual(["thr_ci"]);
});

test("an approval beside the kernel's claim: the claim, what is approved, and Allow answers through resolve", async () => {
  let pending = true;
  const slot = await homePage({
    sdk: {
      threads: {
        interactions: {
          list: async () =>
            (pending
              ? [
                  {
                    id: "pint_2",
                    threadId: "thr_ci",
                    status: "pending",
                    payload: { kind: "approval", reason: "scripted", subject: { kind: "command", command: "git push --force origin fix/ci-race" }, availableDecisions: ["allow_once", "allow_for_session", "deny"] },
                  },
                ]
              : []) as never,
          resolve: async () => ((pending = false), {}) as never,
        },
      },
    },
  });
  const card = (await slot.findAllByTestId("oats-needs-card")).find((candidate) => candidate.textContent!.includes("Fix flaky CI test"))!;
  await waitFor(() => expect(within(card).getAllByTestId("oats-needs-choice").map((choice) => choice.textContent)).toEqual(["Allow", "Deny"]));
  expect(within(card).getByTestId("oats-needs-question").textContent).toBe("needs your permission to use Bash"); // the kernel's claim
  expect(within(card).getByTestId("oats-needs-detail").textContent).toBe("Run: git push --force origin fix/ci-race");
  fireEvent.click(within(card).getAllByTestId("oats-needs-choice")[0]!);
  await waitFor(() => expect(within(card).queryAllByTestId("oats-needs-choice")).toEqual([]));
  expect(slot.inspection.sdkCalls.filter((call) => call.method.startsWith("threads.interactions.res"))).toEqual([
    { method: "threads.interactions.resolve", args: [{ threadId: "thr_ci", interactionId: "pint_2", resolution: { decision: "allow_once", grantedPermissions: null } }] },
  ]);
});

test("a question with options answers through resolve with the option's value; a refused answer is shown and the choices stay", async () => {
  let refuse = true;
  const slot = await homePage({
    sdk: {
      threads: {
        interactions: {
          list: async () =>
            [{ id: "pint_3", threadId: "thr_ci", status: "pending", payload: { kind: "user_question", questions: [{ id: "q1", prompt: "Which depth?", multiSelect: false, allowFreeText: false, options: [{ label: "Depth 6", value: "6" }, { label: "Depth 7", value: "7" }] }] } }] as never,
          resolve: async () => {
            if (refuse) throw new Error("interaction is no longer pending");
            return {} as never;
          },
        },
      },
    },
  });
  const card = (await slot.findAllByTestId("oats-needs-card")).find((candidate) => candidate.textContent!.includes("Fix flaky CI test"))!;
  await waitFor(() => expect(within(card).getAllByTestId("oats-needs-choice").map((choice) => choice.textContent)).toEqual(["Depth 6", "Depth 7"]));
  fireEvent.click(within(card).getAllByTestId("oats-needs-choice")[1]!);
  expect((await within(card).findByRole("alert")).textContent).toBe("interaction is no longer pending");
  expect(within(card).getAllByTestId("oats-needs-choice")).toHaveLength(2);
  refuse = false;
  fireEvent.click(within(card).getAllByTestId("oats-needs-choice")[1]!);
  await waitFor(() => expect(within(card).queryAllByTestId("oats-needs-choice")).toEqual([]));
  expect(slot.inspection.sdkCalls.filter((call) => call.method === "threads.interactions.resolve").at(-1)!.args).toEqual([
    { threadId: "thr_ci", interactionId: "pint_3", resolution: { kind: "user_answer", answers: { q1: { selected: ["7"] } } } },
  ]);
});

test("a kind the plugin cannot answer in place keeps Open only", async () => {
  const slot = await homePage({
    sdk: { threads: { interactions: { list: async () => [{ id: "pint_4", threadId: "thr_ci", status: "pending", payload: { kind: "plugin", title: "A plugin's form", data: {} } }] as never } } },
  });
  const card = (await slot.findAllByTestId("oats-needs-card")).find((candidate) => candidate.textContent!.includes("Fix flaky CI test"))!;
  await waitFor(() => expect(slot.inspection.sdkCalls).toHaveLength(1));
  expect(within(card).queryAllByTestId("oats-needs-choice")).toEqual([]);
  expect(within(card).queryByTestId("oats-needs-detail")).toBeNull();
  expect(within(card).getByTestId("oats-needs-open")).toBeTruthy();
  expect(within(card).getByTestId("oats-needs-question").textContent).toBe("needs your permission to use Bash");
});

test("the reply box sends through bb's own send, to the agent picked", async () => {
  const slot = await homePage({ sdk: { threads: { ...NO_INTERACTIONS.threads, send: async () => ({ ok: true }) as never } } });
  const text = await slot.findByTestId("oats-reply-text");
  const send = slot.getByTestId("oats-reply-send") as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  fireEvent.change(slot.getByTestId("oats-reply-agent"), { target: { value: "thr_mockups" } });
  fireEvent.change(text, { target: { value: "  Use the darker palette.  " } });
  fireEvent.click(send);
  await waitFor(() => expect((text as HTMLTextAreaElement).value).toBe(""));
  expect(slot.inspection.sdkCalls.filter((call) => call.method !== "threads.interactions.list")).toEqual([
    {
      method: "threads.send",
      args: [{ threadId: "thr_mockups", mode: "auto", input: [{ type: "text", text: "Use the darker palette.", mentions: [] }] }],
    },
  ]);
  expect(slot.inspection.rpcCalls.map((call) => call.method).sort()).toEqual(["snapshot", "souls"]); // reads only: never an OATS act
});

test("a failed send says why and keeps the text", async () => {
  const slot = await homePage({
    sdk: {
      threads: {
        ...NO_INTERACTIONS.threads,
        send: async () => {
          throw new Error("thread is archived");
        },
      },
    },
  });
  const text = (await slot.findByTestId("oats-reply-text")) as HTMLTextAreaElement;
  fireEvent.change(text, { target: { value: "hello" } });
  fireEvent.click(slot.getByTestId("oats-reply-send"));
  expect((await slot.findByRole("alert")).textContent).toBe("thread is archived");
  expect(text.value).toBe("hello");
});

test("with a failed snapshot the page shows the error's first line and Retry", async () => {
  const slot = await homePage({
    rpc: handlers({ snapshot: () => ({ ok: false, at: "t", code: "E_PLUGIN_OATS_MISSING", message: "oats: not found on the host's PATH\nmore" }) }),
  });
  expect((await slot.findByRole("alert")).textContent).toBe("oats: not found on the host's PATHRetry");
  expect(slot.queryByTestId("oats-home-needs")).toBeNull();
});

test("the fixed thread tab shows the same three sections, with Workspace counts linking to the four pages and no reply box", async () => {
  const app = await loadApp();
  expect(app.tabs).toHaveLength(1);
  const tab = app.tabs[0]!;
  expect([tab.id, tab.context.kind, tab.availability]).toEqual(["home", "thread", "fixed"]);
  const slot = renderSlot<ExperimentalThreadTabProps, Contract>(
    tab as { component: ComponentType<ExperimentalThreadTabProps> },
    { threadId: "thr_ci", environment: null },
    { rpc: handlers(), sidebarThreads: sidebarThreads(), sdk: NO_INTERACTIONS },
  );
  expect(heading(await slot.findByTestId("oats-home-needs"))).toBe("Needs you3");
  expect(slot.queryByTestId("oats-reply")).toBeNull();
  await waitFor(() => expect(slot.getByTestId("oats-workspace-souls").textContent).toBe("Souls2"));
  expect(slot.getByTestId("oats-workspace-capabilities").textContent).toBe("Capabilities1");
  expect(slot.getByTestId("oats-workspace-teams").textContent).toBe("Teams1");
  expect(slot.getByTestId("oats-workspace-machines").textContent).toBe("Machines1");
  fireEvent.click(slot.getByTestId("oats-workspace-teams"));
  expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "teams" }]);
});

test("a hidden tab does not read the four pages", async () => {
  const app = await loadApp();
  const slot = renderSlot<ExperimentalThreadTabProps, Contract>(
    app.tabs[0]! as { component: ComponentType<ExperimentalThreadTabProps> },
    { threadId: "thr_ci", environment: null },
    { rpc: handlers(), sidebarThreads: sidebarThreads(), sdk: NO_INTERACTIONS, tabVisible: false },
  );
  await slot.findByTestId("oats-home-needs");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(slot.inspection.rpcCalls.map((call) => call.method).sort()).toEqual(["snapshot", "souls"]); // souls: for the names only
});

test("when bb cannot list a thread's interactions, the card keeps the claim and Open", async () => {
  const slot = await homePage({ sdk: {} }); // the client throws at the call
  const cards = await slot.findAllByTestId("oats-needs-card");
  expect(cards).toHaveLength(3);
  const card = cards.find((candidate) => candidate.textContent!.includes("Fix flaky CI test"))!;
  expect(within(card).getByTestId("oats-needs-question").textContent).toBe("needs your permission to use Bash");
  expect(within(card).getByTestId("oats-needs-open")).toBeTruthy();
});
