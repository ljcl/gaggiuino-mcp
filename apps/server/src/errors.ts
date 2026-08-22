/**
 * How this server describes an expected failure to whoever asked.
 *
 * Most of it is the failure classes raised at the upstream (Gaggiuino machine)
 * boundary: the tool dispatcher turns each of these into an `isError` tool
 * result whose text tells the model what to do next, rather than letting an
 * opaque message escape to the host. Anything not in this file is treated as a
 * programmer error and surfaces as a generic failure.
 *
 * `formatFieldIssues` is the other kind — a caller sent bad arguments rather
 * than the machine misbehaving — and lives here because it answers the same
 * question: what does the text say.
 */

import { type z } from "zod";

/**
 * Render a zod validation failure as an indented list of `field: problem`
 * lines.
 *
 * Shared by the two surfaces that validate caller-supplied arguments — the tool
 * dispatcher and the prompt renderer — which want the same list of offending
 * fields under different prose, since the advice for a model calling a tool
 * ("check the input schema") is not the advice for a user invoking a prompt.
 */
export function formatFieldIssues(error: z.ZodError): string {
  return error.issues
    .map(
      (issue) =>
        `  - ${issue.path.join(".") || "(arguments)"}: ${issue.message}`,
    )
    .join("\n");
}

/** The machine could not be reached at all: DNS, connection refused, timeout. */
export class UpstreamUnreachableError extends Error {
  constructor(
    readonly attempts: number,
    readonly reason: string,
  ) {
    super(`Failed to connect after ${attempts} attempts: ${reason}`);
    this.name = "UpstreamUnreachableError";
  }
}

/** The machine answered, but with a non-2xx status. */
export class UpstreamHttpError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly path: string,
    /**
     * The machine's own explanation, when it sent one.
     *
     * `POST /api/profile` answers a rejected profile with a plain-text reason
     * (`docs/upstream/rest-api.md` L96: 422 for bad or incomplete JSON, 500 if
     * it could not be persisted), and that reason is the only thing telling a
     * caller which field to fix. Never interpreted here — `describeUpstreamError`
     * deliberately ignores it, because its generic text is embedded verbatim
     * into `list_profiles` output and asserted on. The one tool that can act on
     * it reads it directly.
     */
    readonly detail?: string,
  ) {
    super(`HTTP ${status}: ${statusText}`);
    this.name = "UpstreamHttpError";
  }
}

/** The machine answered 2xx with a body that does not match its documented shape. */
export class MalformedUpstreamError extends Error {
  constructor(
    readonly path: string,
    readonly detail: string,
  ) {
    super(`Malformed response from ${path}: ${detail}`);
    this.name = "MalformedUpstreamError";
  }
}

/** Pull the shot id back out of a `/api/shots/<id>` path, if that is what it is. */
function shotIdFromPath(path: string): string | undefined {
  const match = path.match(/^\/api\/shots\/([^/]+)$/);
  const id = match?.[1];
  return id === "latest" ? undefined : id;
}

/**
 * Pull the profile id back out of a `/api/profile-select/<id>` path so the 404
 * text addresses the missing id instead of reading as a firmware problem.
 */
function profileIdFromPath(path: string): string | undefined {
  const match = path.match(/^\/api\/profile-select\/([^/]+)$/);
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}

/**
 * Render an upstream failure as text a model can act on, or return `null` when
 * the error is not one of ours (in which case the caller should not pretend to
 * understand it).
 */
export function describeUpstreamError(
  error: unknown,
  machineUrl: string,
): string | null {
  if (error instanceof UpstreamUnreachableError) {
    return `Could not reach the Gaggiuino machine at ${machineUrl}. The machine may be powered off, asleep, or unreachable on the network. Ask the user to check that it is turned on and connected.`;
  }

  if (error instanceof UpstreamHttpError) {
    const shotId = shotIdFromPath(error.path);
    if (error.status === 404 && shotId !== undefined) {
      return `No shot with id '${shotId}' exists on the machine. Gaggiuino keeps only a limited shot history, so older ids expire. Call get_latest_shot_id to get the id of the most recent shot, then retry.`;
    }
    const selectedProfileId = profileIdFromPath(error.path);
    if (error.status === 404 && selectedProfileId !== undefined) {
      return `The machine has no profile with id '${selectedProfileId}', so nothing was changed. Call list_profiles to see the ids it actually holds — the id select_profile needs is the machineProfileId field, not the documentation id.`;
    }
    if (error.status === 404) {
      return `The Gaggiuino machine has no endpoint at ${error.path} (HTTP 404). This usually means the machine is running a firmware version that does not expose it.`;
    }
    return `The Gaggiuino machine returned HTTP ${error.status} (${error.statusText}) for ${error.path}. This is a fault on the machine side, not a bad request. Ask the user to check the machine, then retry.`;
  }

  if (error instanceof MalformedUpstreamError) {
    return `The Gaggiuino machine returned a response for ${error.path} that this server could not understand: ${error.detail}. The machine may be mid-reboot, or running firmware this server does not support. Retrying may help; if it does not, this is a bug worth reporting.`;
  }

  return null;
}
