// bb's pending interactions, as the OATS home draws them: a question and, where the kind is one
// the plugin can answer in place, its choices. Pure: no bb or React import.
//
// Answered with `interactions.respond` (run against bb-app 0.50.1: pi's confirm and select).
// The provider's approval and question kinds are answered with `interactions.resolve`, which has
// not been run against a real provider thread: for them the card keeps Open only.

/** The fields of bb's PendingInteraction this module reads. */
export type Interaction = {
  id: string;
  status: string;
  payload: { kind: string; title?: unknown; data?: unknown; reason?: unknown; questions?: unknown };
};

export type Choice = { label: string; value: boolean | string };
export type Question = { interactionId: string; title: string | null; choices: Choice[] };

const PI_EXTENSION_UI = "provider-pi/extension-ui";

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

function piChoices(data: unknown): Choice[] {
  if (typeof data !== "object" || data === null) return [];
  const { method, options } = data as { method?: unknown; options?: unknown };
  if (method === "confirm") {
    return [
      { label: "Yes", value: true },
      { label: "No", value: false },
    ];
  }
  if (method === "select" && Array.isArray(options) && options.every((option) => typeof option === "string")) {
    return (options as string[]).map((option) => ({ label: option, value: option }));
  }
  return []; // input and editor need a text field: bb's own form, in the thread
}

/** The first interaction still waiting on the person, as a question; null when there is none. */
export function question(interactions: readonly Interaction[]): Question | null {
  const pending = interactions.find((interaction) => interaction.status === "pending");
  if (pending === undefined) return null;
  const { payload } = pending;
  let title = text(payload.title);
  if (payload.kind === PI_EXTENSION_UI && typeof payload.data === "object" && payload.data !== null) {
    const data = payload.data as { fullTitle?: unknown; message?: unknown };
    title = text(data.fullTitle) ?? title ?? text(data.message);
  } else if (payload.kind === "approval") {
    title = text(payload.reason);
  } else if (payload.kind === "user_question" && Array.isArray(payload.questions)) {
    title = text((payload.questions[0] as { prompt?: unknown } | undefined)?.prompt);
  }
  return {
    interactionId: pending.id,
    title,
    choices: payload.kind === PI_EXTENSION_UI ? piChoices(payload.data) : [],
  };
}
