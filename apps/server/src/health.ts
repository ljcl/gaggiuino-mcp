import {
  getUpstreamHealth,
  getUpstreamVersions,
  MACHINE_URL,
  type MachineVersions,
  type UpstreamHealth,
} from "./client";
import { SERVER_VERSION } from "./version";

/**
 * The `/health` payload.
 *
 * `/health` used to return the literal string "ok", which could not distinguish
 * "the process is alive" from "the process can reach the machine" — the two
 * questions an operator actually has.
 *
 * It still answers 200 whenever the process is alive, *including* when the
 * machine is unreachable, and that is deliberate: the espresso machine is
 * switched off most of the day, and the container's HEALTHCHECK reads the
 * status code. Tying the two together would restart a perfectly healthy
 * container every time the user finished their coffee. Upstream state is a
 * field, not a status code.
 *
 * `machine.versions` answers the first question an API-shape bug report raises:
 * which firmware is this. It is **observed**, never probed — remembered when
 * something reads the machine's settings, and `null` until then. Fetching it
 * inside `buildHealth` was rejected on measurement: the client's 20s overall
 * timeout would sit inside a probe whose Docker `HEALTHCHECK --timeout=10s`
 * fires first, so three consecutive failures would restart a container whose
 * only problem is that the espresso machine is switched off — and at 30s
 * intervals that is 2,880 requests a day to an ESP32 that answers one at a
 * time, to read a field that changes when the user flashes firmware.
 *
 * **`buildHealth` is synchronous, and `/health` makes zero upstream requests.**
 */

export interface ReportedVersions {
  coreVersion: string | null;
  frontVersion: string | null;
  staticVersion: string | null;
}

export interface HealthPayload {
  machine: UpstreamHealth & {
    url: string;
    versions: ReportedVersions | null;
  };
  status: "ok";
  uptimeSec: number;
  version: string;
}

export interface HealthOptions {
  machineUrl?: string;
  upstream?: () => UpstreamHealth;
  uptimeSec?: () => number;
  versions?: () => MachineVersions | undefined;
}

export function buildHealth(options: HealthOptions = {}): HealthPayload {
  const {
    machineUrl = MACHINE_URL,
    upstream = getUpstreamHealth,
    uptimeSec = () => process.uptime(),
    versions = getUpstreamVersions,
  } = options;

  const observed = versions();
  return {
    machine: {
      ...upstream(),
      url: machineUrl,
      // Projected to the three documented fields rather than spread.
      // `MachineVersions` is a loose schema — correctly, at the client boundary
      // — but `/health` is served unauthenticated for the container's benefit,
      // so a key a future firmware adds under `versions` would become public
      // here without anyone deciding it should be. Nothing sensitive is
      // documented there today; this is what keeps that true by default.
      versions:
        observed === undefined
          ? null
          : {
              coreVersion: observed.coreVersion ?? null,
              frontVersion: observed.frontVersion ?? null,
              staticVersion: observed.staticVersion ?? null,
            },
    },
    status: "ok",
    uptimeSec: Math.round(uptimeSec()),
    version: SERVER_VERSION,
  };
}
