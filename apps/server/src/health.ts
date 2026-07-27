import { getUpstreamHealth, MACHINE_URL, type UpstreamHealth } from "./client";
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
 */

export interface HealthPayload {
  machine: UpstreamHealth & { url: string };
  status: "ok";
  uptimeSec: number;
  version: string;
}

export interface HealthOptions {
  machineUrl?: string;
  upstream?: () => UpstreamHealth;
  uptimeSec?: () => number;
}

export function buildHealth(options: HealthOptions = {}): HealthPayload {
  const {
    machineUrl = MACHINE_URL,
    upstream = getUpstreamHealth,
    uptimeSec = () => process.uptime(),
  } = options;

  return {
    machine: { ...upstream(), url: machineUrl },
    status: "ok",
    uptimeSec: Math.round(uptimeSec()),
    version: SERVER_VERSION,
  };
}
