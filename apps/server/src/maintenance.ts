import { z } from "zod";

/**
 * The machine's own service log, read as a list rather than as four fields.
 *
 * `/api/maintenance` reports **pairs** — `lastDescaleTimestamp` with
 * `shotsSinceDescale`, `lastBackflushTimestamp` with `shotsSinceBackflush`
 * (`docs/upstream/rest-api.md` L472-479). A service log is exactly the kind of
 * thing a firmware grows a third pair into, so this module models the shape of
 * one service record and derives the list from whatever keys arrived, instead
 * of naming the two that exist today.
 *
 * That is what lets `get_maintenance_status` carry an output schema at all
 * without repeating the mistake `get_machine_settings` avoids by being
 * text-only: the schema describes a record, not an enumeration, so a build that
 * starts logging water-filter changes is carried through rather than dropped.
 *
 * Two of the reference's field notes are load-bearing here rather than
 * decorative:
 *
 * - *"`*Timestamp` fields are epoch seconds; `0` means never recorded."* (L482)
 *   Rendering 0 as 1 January 1970 would be a confident lie about a machine that
 *   has simply never been descaled.
 * - *"`shotsSince*` counters only count shots meeting the 5s minimum-recording
 *   threshold."* (L484) So the count is not "shots pulled", and advice that
 *   treats it as one is wrong by however many flushes the user has done.
 */

export interface ServiceHistory {
  /** ISO-8601 UTC instant, or null — see the two null cases in the schema. */
  lastAt: string | null;
  /** The machine's own epoch seconds; null when it reported 0 (never). */
  lastEpochSec: number | null;
  /** The machine's own naming: "descale", "backflush", … */
  service: string;
  shotsSince: number | null;
}

export interface MaintenanceReading {
  /** Keys this module could not pair into a service, verbatim. */
  extras: Record<string, unknown>;
  services: ServiceHistory[];
}

const SERVICE_TIMESTAMP_KEY = /^last(.+)Timestamp$/;

/**
 * Epoch seconds below this are an unset clock, not a date.
 *
 * The machine stamps these from its own clock, which is only right once the
 * network has set it. Reporting "56 years ago" from a boot-epoch value is the
 * same class of lie as rendering 0 as 1970 — it just looks more plausible.
 * 2020-01-01T00:00:00Z, comfortably before any firmware that tracks a service
 * log.
 */
const PLAUSIBLE_EPOCH_FLOOR_SEC = 1_577_836_800;

/**
 * And a ceiling, because `new Date(ms).toISOString()` *throws* past ±8.64e15 ms
 * rather than returning something odd. Without this a machine reporting a
 * nonsense epoch takes the whole tool call down with an uncaught `RangeError` —
 * an expected upstream oddity surfacing as a crash, which is exactly what the
 * boundary rules here exist to stop. Year 9999, comfortably past any real clock.
 */
const PLAUSIBLE_EPOCH_CEILING_SEC = 253_402_300_800;

/**
 * Mirrors `NumericSchema` in `client.ts` rather than importing it. This firmware
 * sends numbers as decimal strings on some endpoints, and the boundary schema
 * for `/api/maintenance` deliberately types nothing, so the tolerance has to
 * live at the point of interpretation.
 */
const CountSchema = z
  .union([z.number(), z.string()])
  .transform(Number)
  .refine(Number.isFinite);

function finiteNumber(value: unknown): number | null {
  const parsed = CountSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const DAY_MS = 86_400_000;

function describeElapsed(epochSec: number, nowMs: number): string {
  const deltaMs = nowMs - epochSec * 1000;
  if (deltaMs < 0) {
    return "dated in the future — the machine's clock may not be set";
  }
  const days = Math.floor(deltaMs / DAY_MS);
  if (days === 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 60) return `${days} days ago`;
  return `about ${Math.round(days / 30)} months ago`;
}

/**
 * Pair the machine's flat record into services.
 *
 * A timestamp key whose value is not a number is deliberately *not* treated as
 * a service: it and its counter fall through to `extras` instead. That is what
 * keeps every null unambiguous — `lastEpochSec === null` then means exactly one
 * thing, that the machine reported 0 and has never recorded this service.
 */
export function extractServiceHistory(
  raw: Record<string, unknown>,
): MaintenanceReading {
  const services: ServiceHistory[] = [];
  const consumed = new Set<string>();

  for (const [key, value] of Object.entries(raw)) {
    const match = key.match(SERVICE_TIMESTAMP_KEY);
    if (!match?.[1]) continue;
    const epochSec = finiteNumber(value);
    if (epochSec === null) continue;

    const name = match[1];
    const counterKey = `shotsSince${name}`;
    const shotsSince = finiteNumber(raw[counterKey]);
    consumed.add(key);
    // Only claim the counter if it was actually readable. Consuming it either
    // way would let `shotsSince: null` mean two different things, and the text
    // then says "not reported by this firmware" about a counter the firmware
    // did report — in a value this server could not parse and has now hidden.
    if (shotsSince !== null) consumed.add(counterKey);

    const lastEpochSec = epochSec === 0 ? null : epochSec;
    const datable =
      lastEpochSec !== null &&
      lastEpochSec >= PLAUSIBLE_EPOCH_FLOOR_SEC &&
      lastEpochSec <= PLAUSIBLE_EPOCH_CEILING_SEC;
    services.push({
      lastAt: datable ? new Date(lastEpochSec * 1000).toISOString() : null,
      lastEpochSec,
      service: name.charAt(0).toLowerCase() + name.slice(1),
      shotsSince,
    });
  }

  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!consumed.has(key)) extras[key] = value;
  }

  return { extras, services };
}

/**
 * The caveats at the end are the point of the text, not filler.
 *
 * Two numbers that look like a complete service record are not one: the machine
 * only notices a descale it ran itself, and only counts shots it recorded. A
 * user who backflushes by hand every Sunday has a "shots since backflush" that
 * climbs forever, and advice that reads it literally tells them to clean a
 * machine they just cleaned.
 */
export function formatMaintenance(
  reading: MaintenanceReading,
  nowMs: number,
): string {
  const lines = ["# Machine service history", ""];

  if (reading.services.length === 0) {
    lines.push(
      "The machine's service log is empty — it reported no descale or backflush records at all.",
      "",
    );
  }

  for (const entry of reading.services) {
    const label =
      entry.service.charAt(0).toUpperCase() + entry.service.slice(1);
    lines.push(`## ${label}`, "");
    if (entry.lastEpochSec === null) {
      lines.push(
        "- Last recorded: never — this machine has not recorded one. That does not mean it has never been serviced, only that the machine did not do it.",
      );
    } else if (entry.lastAt === null) {
      lines.push(
        `- Last recorded: the machine reported epoch ${entry.lastEpochSec}, which is too early to be a real date — its clock was probably not set at the time.`,
      );
    } else {
      lines.push(
        `- Last recorded: ${entry.lastAt} (${describeElapsed(entry.lastEpochSec, nowMs)})`,
      );
    }
    lines.push(
      `- Shots since: ${entry.shotsSince ?? "not reported by this firmware"}`,
      "",
    );
  }

  if (Object.keys(reading.extras).length > 0) {
    lines.push("## Other fields this firmware reported", "");
    for (const [key, value] of Object.entries(reading.extras)) {
      const rendered =
        value !== null && typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
      lines.push(`- ${key}: ${rendered}`);
    }
    lines.push("");
  }

  lines.push(
    "## How the machine counts",
    "",
    "- A descale is recorded at 50% of the descale cycle, and a backflush once pressure holds above 10 bar in flush mode for more than two seconds. A service done by hand is not in these numbers.",
    "- The shot counters only count shots that ran 5 seconds or longer, so flushes and aborted pulls are not included.",
    "- Timestamps are UTC, as the machine recorded them.",
  );

  return lines.join("\n");
}
