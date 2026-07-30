import { getClient, type ShotData } from "./client";
import { UpstreamHttpError } from "./errors";

/**
 * Walking back through shot history.
 *
 * The machine exposes one shot at a time and a pointer to the newest one, so
 * "the last five shots" is a walk: start at the latest id and count down. Two
 * things make that less trivial than it sounds.
 *
 * **Ids have gaps.** Gaggiuino keeps a bounded history and a deleted shot
 * leaves a hole, so `id - 1` is a guess, not the previous shot — and after shot
 * #1 it asks for shot #0, which never exists. Both the app's "compare previous"
 * button and any trend question have to tolerate holes rather than assume none.
 *
 * **Every probe costs an upstream request.** The walk is therefore bounded by a
 * gap budget rather than left to run until it finds what it wants: it will make
 * at most `limit + MAX_GAP_PROBES` requests and then stop, even if the machine
 * has more history further down. Running off the end of retained history is the
 * normal case, not an error, and it looks exactly like a run of 404s.
 */

/** Missing ids tolerated across one walk before it gives up. */
export const MAX_GAP_PROBES = 5;

/** Ceiling on `list_recent_shots`, so one call cannot become 50 round trips. */
export const MAX_RECENT_SHOTS = 10;

export interface ShotWalkOptions {
  /** Walk back from just below this id. Omit to start at the latest shot. */
  before?: string;
  limit: number;
}

/**
 * Shots from newest to oldest, skipping ids the machine no longer has.
 *
 * A 404 is a gap and is absorbed. Anything else — an unreachable machine, a
 * body this server cannot parse — propagates, because a partial list that
 * silently omitted the shots a broken machine could not serve would read as a
 * complete one.
 */
export async function walkShotsBack({
  before,
  limit,
}: ShotWalkOptions): Promise<ShotData[]> {
  const client = getClient();
  let startId: number;

  if (before === undefined) {
    const latest = await client.getLatestShotId();
    if (latest === "") return [];
    const parsed = Number(latest);
    // Ids are opaque to this server. Today's firmware mints ascending
    // integers, which is what makes a downward walk meaningful — if that ever
    // stops being true, the newest shot is still an honest answer, where
    // decrementing a non-number would produce NaN and fetch nothing.
    if (!Number.isInteger(parsed)) return [await client.getShotData(latest)];
    startId = parsed;
  } else {
    const parsed = Number(before);
    if (!Number.isInteger(parsed)) return [];
    startId = parsed - 1;
  }

  const shots: ShotData[] = [];
  let gaps = 0;

  for (let id = startId; id > 0; id -= 1) {
    if (shots.length >= limit || gaps >= MAX_GAP_PROBES) break;
    try {
      shots.push(await client.getShotData(String(id)));
    } catch (error) {
      if (error instanceof UpstreamHttpError && error.status === 404) {
        gaps += 1;
        continue;
      }
      throw error;
    }
  }

  return shots;
}
