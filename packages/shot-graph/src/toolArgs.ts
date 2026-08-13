/**
 * The tool arguments this app can render, narrowed from the host's raw input.
 *
 * The narrowing must accept every shape the server's advertised schema invites,
 * because the host relays `view_shot_graph`'s call arguments to the app
 * **untransformed**. The server's `ShotIdSchema` accepts `string | number` —
 * its own docblock says models routinely send ids as numbers — and normalizes
 * with `.transform(String)`, but that transform runs in the tool dispatcher,
 * not in the host. An earlier version of this parser checked
 * `typeof shot_id !== "string"`, written against the transformed type rather
 * than the wire type: a model that called the tool with `shot_id: 363` got a
 * perfect text summary from the server while the app rejected the same
 * arguments and sat on "Waiting for shot data…" forever, with no error and no
 * retry (observed on Claude iOS, 2026-08-13).
 */
export interface ToolArgs {
  shot_id: string;
  compare_shot_id?: string;
}

/**
 * One id, in either wire shape. Mirrors `ShotIdSchema`: a non-empty string
 * passes through, a finite number becomes its decimal string, anything else is
 * not an id.
 */
function asShotId(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value !== "") return value;
  return null;
}

/**
 * Narrow the host's tool arguments. Returning `null` keeps the app in its
 * "waiting for shot data" state rather than mounting a chart with no shot —
 * which is the honest state only while the host has genuinely not sent
 * arguments yet, hence the coercion above.
 */
export function parseToolArgs(
  args: Record<string, unknown> | undefined,
): ToolArgs | null {
  const shotId = asShotId(args?.shot_id);
  if (shotId === null) return null;
  const compareId = asShotId(args?.compare_shot_id);
  return {
    compare_shot_id: compareId ?? undefined,
    shot_id: shotId,
  };
}
