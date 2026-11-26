import { randomBytes } from "node:crypto";
import {
  CLIENT_CAPABILITIES_META_KEY,
  createRequestStateCodec,
  type InputRequiredResult,
  inputRequired,
  inputResponse,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";

/**
 * A question a tool puts to the user in the middle of a call, through form
 * elicitation (2026-07-28, multi-round-trip).
 *
 * The flow is stateless. Round 1 answers `tools/call` with an
 * `InputRequiredResult` carrying the form and a signed `requestState`. The
 * client shows the form, then sends the **same** `tools/call` again with the
 * user's answer in `inputResponses` and the state echoed back. The handler
 * runs from the top on round 2, so every precondition is checked again —
 * nothing round 1 saw is evidence on round 2.
 *
 * **What the form is, and what it is not.** It needs a host that cooperates:
 * a client holding a write token can invent an answer as easily as it can
 * leave the capability out and take the path with no form. So the form stops
 * the *model* — it moves the last confirmation from text the model types to
 * text the user types — and the scope gate is still what stops a stranger.
 * The signed state does a narrower job: it proves this server asked this
 * question, about this profile, in this process, within the TTL. An answer
 * with no state, a forged state, or a state minted for another profile never
 * reaches the action.
 *
 * **The key is random per process**, on purpose. One process serves every
 * round of a flow here, so no key has to be shared or configured, and
 * nothing depends on `MCP_OAUTH_SECRET` (#279 may remove it). A restart drops
 * every pending form: its state then fails verification, and the SDK answers
 * `-32602` before any handler runs. For a confirmation of an irreversible
 * action, expiring is the correct failure.
 */

/** What a pending confirmation carries between the two rounds. */
const PendingConfirmationSchema = z.object({
  profileId: z.string(),
  tool: z.string(),
});

export type PendingConfirmation = z.infer<typeof PendingConfirmationSchema>;

/** How long a form may stay unanswered: ten minutes, the SDK's default. */
export const CONFIRMATION_TTL_SECONDS = 600;

const codec = createRequestStateCodec<PendingConfirmation>({
  key: randomBytes(32),
  ttlSeconds: CONFIRMATION_TTL_SECONDS,
  // Domain separation by method, so state minted for a `tools/call` cannot be
  // spent on any other method. The tool and the profile are in the payload,
  // and the handler compares both against the call it is serving.
  bind: (ctx) => ctx.mcpReq.method,
});

/**
 * `ServerOptions.requestState.verify`. Runs before any handler on every round
 * that echoes a state, and a throw becomes the SDK's frozen `-32602`
 * ("Invalid or expired requestState"), so a handler only ever reads a state
 * this process signed.
 */
export const verifyRequestState = codec.verify;

/** The form field a typed-name confirmation asks for. */
const TYPED_NAME_FIELD = "name";

/** One question that asks the user to type a name. */
export interface TypedNameQuestion {
  /** Key of the request in `inputRequests`, and of the answer in `inputResponses`. */
  key: string;
  /** What the form says; the host shows it to the user verbatim. */
  message: string;
  /** The name the user must type, shown in the field's description. */
  name: string;
  /** What round 2 has to match before it may act. */
  pending: PendingConfirmation;
}

/** What the user did with a typed-name form. */
export type TypedNameAnswer =
  | { kind: "typed"; value: string }
  | { kind: "declined" }
  | { kind: "cancelled" }
  | { kind: "missing" };

/** What a tool handler can do with the user, for this one request. */
export interface ToolInteraction {
  /** Ask the user to type a name; returns the round-1 answer to send. */
  askTypedName(question: TypedNameQuestion): Promise<InputRequiredResult>;
  /** Whether this request's client declared form-mode elicitation. */
  formElicitation: boolean;
  /** The verified state of an earlier round, or `undefined` on round 1. */
  pending: PendingConfirmation | undefined;
  /** Read the user's answer to a typed-name form sent on round 1. */
  typedName(key: string): TypedNameAnswer;
}

/**
 * The interaction for a call that cannot ask anything: a direct
 * `handleToolCall` from a test or the fake machine, and every client that did
 * not declare form elicitation. Asking throws, because a handler that asks
 * without checking `formElicitation` first is a bug.
 */
export const NO_INTERACTION: ToolInteraction = {
  askTypedName: () =>
    Promise.reject(new Error("this call cannot ask the user anything")),
  formElicitation: false,
  pending: undefined,
  typedName: () => ({ kind: "missing" }),
};

/**
 * Whether a request envelope declares form-mode elicitation.
 *
 * Bare `elicitation: {}` means form only. An object naming modes declares
 * exactly those, so `{ url: {} }` alone is not a form client. The server must
 * not send a mode the client did not declare.
 */
export function declaresFormElicitation(envelope: unknown): boolean {
  if (typeof envelope !== "object" || envelope === null) return false;
  const capabilities = (envelope as Record<string, unknown>)[
    CLIENT_CAPABILITIES_META_KEY
  ];
  if (typeof capabilities !== "object" || capabilities === null) return false;
  const elicitation = (capabilities as Record<string, unknown>).elicitation;
  if (typeof elicitation !== "object" || elicitation === null) return false;
  const modes = elicitation as Record<string, unknown>;
  if (!("form" in modes) && !("url" in modes)) return true;
  return typeof modes.form === "object" && modes.form !== null;
}

/** The interaction for one `tools/call`, read off its handler context. */
export function interactionFor(ctx: ServerContext): ToolInteraction {
  const state = PendingConfirmationSchema.safeParse(
    ctx.mcpReq.requestState<unknown>(),
  );
  const responses = ctx.mcpReq.inputResponses;
  return {
    askTypedName: async (question) =>
      inputRequired({
        inputRequests: {
          [question.key]: inputRequired.elicit({
            message: question.message,
            requestedSchema: {
              properties: {
                [TYPED_NAME_FIELD]: {
                  description: `Type ${question.name} exactly to confirm.`,
                  title: "Profile name",
                  type: "string",
                },
              },
              required: [TYPED_NAME_FIELD],
              type: "object",
            },
          }),
        },
        requestState: await codec.mint(question.pending, ctx),
      }),
    formElicitation: declaresFormElicitation(ctx.mcpReq.envelope),
    pending: state.success ? state.data : undefined,
    typedName: (key) => readTypedName(responses, key),
  };
}

/**
 * The user's answer to a typed-name form.
 *
 * Surrounding whitespace is trimmed, because a person typing a name adds it
 * and nobody names a profile with it. Case is kept: `zer0` does not confirm
 * `Zer0`, the same rule as `confirm_name`. An accepted answer with no string
 * in the field reads as missing, not as an empty name.
 */
export function readTypedName(
  responses: Record<string, unknown> | undefined,
  key: string,
): TypedNameAnswer {
  const response = inputResponse(responses, key);
  if (response.kind !== "elicit") return { kind: "missing" };
  if (response.action === "decline") return { kind: "declined" };
  if (response.action === "cancel") return { kind: "cancelled" };
  const value = response.content?.[TYPED_NAME_FIELD];
  if (typeof value !== "string") return { kind: "missing" };
  return { kind: "typed", value: value.trim() };
}
