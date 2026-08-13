# A pressure-plausibility warning and a sensor-health tool: measured, and declined

An intermittent pressure-transducer fault on the live machine (roughly one shot
in three over ~12 shots on Zer0) produced three proposals. This note answers the
two that are server changes and records why, so the question is not re-asked
from scratch. The third — diagnosing the transducer itself — is hardware and out
of scope for this repo entirely.

1. **A plausibility warning** on `get_shot_data` / `get_latest_shot_id` when
   peak pressure lands below ~40% of the profile's maximum `targetPressure`,
   marking `pumpFlow` and `waterPumped` unreliable in the same response.
2. **A `get_sensor_health` tool**: poll pressure, temperature, and weight
   (suggested 20 samples at 500 ms), return per-sensor statistics and a
   pass/suspect verdict.

Both are declined. What shipped instead: the **"When Not to Trust the Data"**
section of `prompts.yaml`, a matching exclusion rule in
`prompts.ts`'s `ADJUSTMENT_POLICY`, and a fix to `timeToFirstDripSec`'s
tare-noise false positive in `analysis.ts`. `events.ts` and every tool schema
are unchanged, so no permission grant moves.

## What the fault looks like

Observed on the live machine, ticket data plus captures pulled 2026-08-13:

- Peak pressure on Zer0 (9-bar ceiling) is **bimodal**: #335/#336/#345/#348/
  #354/#357/#359 peak 7.0–9.2 bar; #351/#358/#361/#362 peak 2.4–2.9 bar. No
  intermediate values, and the low cluster spans 0.5 bar across days.
- On fault shot #362 the scale recorded a **normal extraction** — steady climb
  to 60.3 g in 42.7 s — while `waterPumped` reported 124 ml against a ~98 ml
  norm. Flow is modelled from pump behaviour and the pressure reading, so a
  pressure under-read inflates it; the scale is the independent witness.
- Idle readings during the fault window included 8.54 and 2.06 bar with the
  pump off, which is physically impossible.

## What the data says

Measured 2026-08-13 against live captures: #362 (fault) and #359 (good), both
Zer0, full series via `get_shot_raw_data`.

### 1. Zer0's pressure target is a ceiling, so deviation cannot separate fault from healthy

Zer0 commands **both** targets at once: `targetPumpFlow` drives the shot while
`targetPressure` steps 6 → 2.5 → 9 bar as a limit. Measured pressure is
*supposed* to sit under the ceiling whenever the puck offers little resistance:

| | #359 (good) | #362 (fault) |
| --- | --- | --- |
| `peakPressureBar` | 7.0 | 2.5 |
| `pressureDeviationBar` | **4.0** | 5.2 |

A good shot deviating 4 bar from its own commanded series is the end of any
detector built on shortfall-from-target: a threshold that catches #362 catches
#359's 9-bar phase too, where pressure spends its first half more than 4 bar
under the ceiling.

### 2. The fault shot is internally consistent, so no single-shot detector is honest

#362's pressure and flow agree with each other: ~3.4 ml/s delivered at 2.4 bar
is exactly what a coarse puck produces. Nothing inside one shot's pressure and
flow series distinguishes "sensor under-reads by 4×" from "puck offered little
resistance". What distinguishes them is **cross-evidence** — the scale's normal
extraction, the bimodal history, the impossible idle readings — and every piece
of it is something the model can already fetch (`list_recent_shots`,
`get_status`, the shot's own weight series) while the server sees one shot at a
time.

This repo has already made the mistake that proves the point.
`2026-08-08-flow-based-extraction-events.md` describes #351 — peak 2.7 bar,
120.9 ml pumped for 60.2 g — as *"a resistance failure by any reading"*. It is
now established to be the transducer. That was this server's own maintainers
reading a sensor fault as an extraction result from single-shot data; a
hardcoded threshold would do the same thing with more confidence.

### 3. The proposed 40% threshold measures the puck, not the sensor

On the observed shots the ratio works: #362 peaks at 28% of the 9-bar ceiling,
#359 at 78%. But peak-over-ceiling is a measure of *how much resistance the
puck offered relative to the profile's limit* — and a legitimate gentle shot
scores low on it by design. An allongé or turbo-style shot on a flow profile
with a high safety ceiling peaks at 3–4 bar under a 9-bar limit and lands right
at the threshold; a filter-style profile sits far under it on every brew. The
warning would fire on exactly the shots light-roast flow profiles exist to
produce, and a diagnostic that names a cause it cannot know is one the user
stops believing the first time it is wrong.

## Why not a warning field anyway

- `OutcomeMetricsSchema` is the advertised output of three tools; adding a
  warning field re-keys all three grants (the cost `tempDeviationC` /
  `pressureDeviationBar` already paid once, knowingly — this one does not clear
  that bar, because findings 1–3 say the value would be wrong).
- "Likely instrumentation rather than extraction" is a judgement, and the rule
  for everything in `events.ts` is report what was measured, never what it
  means. The interpretation layer this server already has is
  `get_dial_in_guidance`, and that is where the fault signature now lives.

## Why not `get_sensor_health`

- **It blocks for its whole sample window.** 20 samples at 500 ms is a 10 s
  tool call spent deliberately sleeping against an ESP32 that serves one
  request at a time. The client's overall deadline exists because ~34 s of
  retries already outlived most hosts' patience; building a tool whose success
  path holds a handler open for 10 s is the same failure on purpose — and the
  natural cadence for an idle check (a few reads spread over a minute) does not
  fit inside any tool call's lifetime.
- **Its refusal conditions need state the API does not expose.** "Refuse if a
  shot ended within ~60 s" requires a wall-clock shot-end time; the machine
  stores shots by id with no timestamp this server can read.
- **The verdict thresholds are opinions.** 1.0 bar idle, ±5 g, 2 °C are one
  machine's numbers, inherited rather than measured — the same objection that
  moved the collapse threshold off the upstream 1.5-bar constant. And
  pass/suspect is a diagnosis, which is the guidance's job, not a tool's.
- **The model can already run the poll.** `/api/system/status` is deliberately
  uncached — every `get_status` call is a live reading — so "call `get_status`
  two or three times over a minute; several bar at idle is physically
  impossible" is a complete implementation of the detector, at the model's own
  pacing, with the brew-switch and recent-shot context the conversation already
  has. That instruction is now in the guidance.

## What would change it

1. **A measured single-shot separator.** Labelled captures — fault shots *and*
   legitimately gentle low-pressure shots on the same firmware — showing a
   margin like the collapse detector's (threshold ~3× the healthy floor,
   consistent across profiles). The captures pulled for this note are the
   start of that corpus, not the end.
2. **Raw ADC counts becoming reachable** (the ticket's own open question). A
   fixed count ceiling is instrumentation by definition, needs no inference
   from hydraulics, and would reopen a *measured* event honestly — "pressure
   sat at the sensor's ceiling" is an observation, not a judgement.
3. **A firmware-side sampling endpoint.** The right place for a 20-sample poll
   is on the device, where one request can return N samples without N round
   trips. If upstream ever ships one, a thin read tool over it has none of the
   objections above.
