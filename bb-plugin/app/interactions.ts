// bb's pending interactions, as the OATS home draws them: a question and, where the kind is one
// the plugin can answer in place, its choices. Pure: no bb or React import.
//
// Each choice carries the call that answers it: `interactions.respond` with a value (pi's confirm
// and select), or `interactions.resolve` with a resolution (the provider's approval and question
// kinds, Claude Code's among them). Both were run from the page against bb-app 0.50.1.

/** The fields of bb's PendingInteraction this module reads. */
export type Interaction = {
  id: string;
  status: string;
  payload: {
    kind: string;
    title?: unknown;
    data?: unknown;
    reason?: unknown;
    questions?: unknown;
    subject?: unknown;
    availableDecisions?: unknown;
  };
};

export type Answer =
  | { via: "respond"; value: boolean | string }
  | {
      via: "resolve";
      resolution:
        | { decision: "allow_once"; grantedPermissions: null }
        | { decision: "deny" }
        | { kind: "user_answer"; answers: Record<string, { selected: string[] }> };
    };
export type Choice = { label: string; answer: Answer };
export type Question = { interactionId: string; title: string | null; choices: Choice[] };

const PI_EXTENSION_UI = "provider-pi/extension-ui";

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

function piChoices(data: unknown): Choice[] {
  if (typeof data !== "object" || data === null) return [];
  const { method, options } = data as { method?: unknown; options?: unknown };
  if (method === "confirm") {
    return [
      { label: "Yes", answer: { via: "respond", value: true } },
      { label: "No", answer: { via: "respond", value: false } },
    ];
  }
  if (method === "select" && Array.isArray(options) && options.every((option) => typeof option === "string")) {
    return (options as string[]).map((option) => ({ label: option, answer: { via: "respond", value: option } }));
  }
  return []; // input and editor need a text field: bb's own form, in the thread
}

/** What an approval is about, in one line: the command, else the provider's reason. */
function approvalTitle(payload: Interaction["payload"]): string | null {
  const subject = payload.subject as { kind?: unknown; command?: unknown; toolName?: unknown; tool?: unknown } | undefined;
  const command = text(subject?.command);
  if (subject?.kind === "command" && command !== null) return `Run: ${command}`;
  const tool = text(subject?.toolName) ?? text(subject?.tool);
  return text(payload.reason) ?? (tool === null ? null : `Use ${tool}`);
}

/** Allow (this once) and Deny, where the provider offers them. A wider grant is bb's own form. */
function approvalChoices(payload: Interaction["payload"]): Choice[] {
  const offered = Array.isArray(payload.availableDecisions) ? payload.availableDecisions : [];
  const choices: Choice[] = [];
  if (offered.includes("allow_once")) {
    choices.push({ label: "Allow", answer: { via: "resolve", resolution: { decision: "allow_once", grantedPermissions: null } } });
  }
  if (offered.includes("deny")) choices.push({ label: "Deny", answer: { via: "resolve", resolution: { decision: "deny" } } });
  return choices;
}

type AskedQuestion = { id?: unknown; prompt?: unknown; multiSelect?: unknown; options?: unknown };

/** One button per option, for a single question with one answer; anything richer is bb's own form. */
function questionChoices(questions: readonly AskedQuestion[]): Choice[] {
  const [only] = questions;
  if (questions.length !== 1 || only === undefined || only.multiSelect === true) return [];
  const id = text(only.id);
  if (id === null || !Array.isArray(only.options)) return [];
  const choices: Choice[] = [];
  for (const option of only.options as { label?: unknown; value?: unknown }[]) {
    const value = text(option?.value);
    if (value === null) return [];
    choices.push({
      label: text(option.label) ?? value,
      answer: { via: "resolve", resolution: { kind: "user_answer", answers: { [id]: { selected: [value] } } } },
    });
  }
  return choices;
}

/** The first interaction still waiting on the person, as a question; null when there is none. */
export function question(interactions: readonly Interaction[]): Question | null {
  const pending = interactions.find((interaction) => interaction.status === "pending");
  if (pending === undefined) return null;
  const { payload } = pending;
  let title = text(payload.title);
  let choices: Choice[] = [];
  if (payload.kind === PI_EXTENSION_UI && typeof payload.data === "object" && payload.data !== null) {
    const data = payload.data as { fullTitle?: unknown; message?: unknown };
    title = text(data.fullTitle) ?? title ?? text(data.message);
    choices = piChoices(payload.data);
  } else if (payload.kind === "approval") {
    title = approvalTitle(payload) ?? title;
    choices = approvalChoices(payload);
  } else if (payload.kind === "user_question" && Array.isArray(payload.questions)) {
    const questions = payload.questions as AskedQuestion[];
    title = text(questions[0]?.prompt) ?? title;
    choices = questionChoices(questions);
  }
  return { interactionId: pending.id, title, choices };
}
