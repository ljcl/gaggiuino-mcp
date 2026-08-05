/**
 * The vocabulary and units of a Gaggiuino profile, in one place.
 *
 * Two surfaces read a profile's definition and they travel in opposite
 * directions: `GET /api/profile/{id}` is bytes the *machine* sent, and
 * `POST /api/profile` is bytes a *language model* wrote heading for persistence
 * on the user's machine. They therefore get opposite strictness — loose at the
 * boundary so a firmware revision cannot take the server down, strict on the
 * way in because the reference says *"other missing/malformed fields are filled
 * with zero-value defaults"* (`docs/upstream/rest-api.md` L81) and a stripped
 * key is a phase that targets zero.
 *
 * What they share is this file: the enum vocabularies and the unit contract.
 *
 * ## The unit contract
 *
 * **Nothing in a profile is scaled by 10.** That is the trap, because the shot
 * *time-series* is (`SCALE_BY_10` in `analysis.ts`: pressure 91 means 9.1 bar,
 * temperature 910 means 91.0°C). A profile is not. A model that has just read a
 * shot and copies `910` into `waterTemperature` writes a profile asking for
 * 910°C, and the machine accepts it.
 *
 * - `time`, everywhere it appears — **milliseconds**. `40000` is a 40-second
 *   shot; `5000` is a five-second ramp.
 * - `waterTemperature` — real degrees Celsius. `93` is 93°C.
 * - `weight`, `coffeeIn`, `coffeeOut` — grams.
 * - flow (`flowAbove`, `flowBelow`, and a FLOW phase's `target.end`) — ml/s.
 * - pressure (`pressureAbove`, `pressureBelow`, and a PRESSURE phase's
 *   `target.end`) — bar.
 * - `restriction` — **no documented unit.** `websocket.md` L198 gives
 *   `float restriction = 3` and says only (L221) that both shipped UIs always
 *   send `0`. Do not invent one; leave it at 0 unless copying a profile that
 *   sets it.
 * - `waterPumped` / `waterPumpedInPhase` — undocumented, millilitres by
 *   inference from the flow units. Hedge it anywhere it is described.
 *
 * `id` is deliberately absent from the machine's export — *"`id` is
 * intentionally omitted so the profile can be re-imported without collisions; a
 * fresh id is assigned on upload"* (L73, L82).
 */

/** `PhaseTypeDto`, `docs/upstream/websocket.md` L185. */
export const PHASE_TYPES = ["FLOW", "PRESSURE", "MANUAL"] as const;

/** `TransitionCurveDto`, `docs/upstream/websocket.md` L186. */
export const TRANSITION_CURVES = [
  "EASE_IN_OUT",
  "EASE_IN",
  "EASE_OUT",
  "LINEAR",
  "INSTANT",
] as const;

/**
 * `PhaseStopConditionsDto`, `docs/upstream/websocket.md` L192-196. All seven are
 * numeric, unlike the global stop conditions, two of which are boolean.
 */
export const PHASE_STOP_CONDITION_KEYS = [
  "time",
  "pressureAbove",
  "pressureBelow",
  "flowAbove",
  "flowBelow",
  "weight",
  "waterPumpedInPhase",
] as const;

/** `GlobalStopConditionsDto`, `docs/upstream/websocket.md` L202-205. */
export const GLOBAL_STOP_CONDITION_KEYS = [
  "time",
  "weight",
  "waterPumped",
  "switchToManualPressureCtrl",
  // Upstream's own misspelling. Ground truth, not a typo to fix here.
  "switchToManuaFlowCtrl",
] as const;
