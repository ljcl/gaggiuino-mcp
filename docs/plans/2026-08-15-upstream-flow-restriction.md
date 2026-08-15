# Upstream flow restriction: what to build, and what not to

Research record for the diagnosis of shots #364–#367, where one cause — a
restriction upstream of the group, most often trapped air at the pump inlet —
presented as three faults that each looked separate and each had a wrong-but-
obvious explanation.

The question asked was whether any of it belongs in this server. The answer is
**guidance, not a tool**, and the interesting part is why the one genuinely
computable candidate did not survive being measured.

---

## What shipped

A `When the Water Is Not Arriving` section in `prompts.yaml`, plus a
cross-reference fix to the mass-balance bullet that #166 shipped in
`When Not to Trust the Data`.

It is in the YAML rather than in a prompt plan for the reason the
`Editing a Profile` section is: it is durable domain knowledge, and every plan
already picks it up by calling `get_dial_in_guidance` in step 1. It adds no
tool, no schema, and re-keys no permission grant.

### Why guidance was the whole answer

Every measurement the diagnosis needed, this server already serves. Resting
pressure is `get_status`'s `pressureBar`, and that endpoint is deliberately
uncached, so repeat calls a minute apart are honest live readings rather than
one reading served three times. `waterPumpedMl` against `finalWeightG` is
already in `get_shot_data`'s metrics and already rendered. Peak pressure and
time to first drip are already in `list_recent_shots`.

What was missing was never a number. It was that nothing told the model 0.7 bar
at idle means anything, that a boiler reading taken four minutes after a 61 s
shot is not evidence about the boiler, or that the cheapest test in the whole
sequence involves taking the portafilter *off*. Those are readings of numbers
that already exist, which is what this file is for.

### The correction to shipped guidance

#166's mass-balance bullet reads a large `waterPumpedMl − finalWeightG` excess
as evidence that the flow model, and the pressure reading under it, is inflated.
That is one true reading of the observation. This diagnosis is the other: a
restriction upstream of the group makes shots long, and a long shot moves real
water inefficiently, so the excess is genuine rather than modelled.

Left alone, a model reading the existing bullet lands confidently on a sensor
fault for a symptom whose cause was hydraulic — and the jug test had already
shown the volume model was trustworthy to ~11%. The bullet now points at the new
section rather than asserting the sensor reading as the only one.

---

## The candidate that was measured and not built

Upstream documents a comparison that looks purpose-built for this fault. From
the Gen 3 user manual's PZ calibration note:

> Accuracy can be improved by comparing pump flow to weight flow when pressure
> is >4 bar, flow is >1 ml/s, and both are stable (HW or BT scales must be
> active).

`pumpFlow` and `weightFlow` are both in every shot record. A
`pumpFlowVsWeightFlow` outcome metric — the model against the independent
witness, inside upstream's own validity window — would put a number on exactly
the deficit this diagnosis chased.

It is not shippable, for three reasons. The first two are fixable and the third
is not, yet.

### 1. The stated window is dominated by transients

Measured over the repo's two real captures (`londiniumShot33`, `londiniumShot32`,
reachable from `apps/server` through `packages/shot-graph`'s `./fixtures`
export), upstream's `pressure > 4 bar && pumpFlow > 1 ml/s` admits 70 of 191 and
59 of 172 samples — and those include the pressure ramp, where the puck is still
filling and `weightFlow` lags by seconds:

| Shot | Samples in window | mean | median | min | max |
| --- | --- | --- | --- | --- | --- |
| #33 | 70 / 191 | 1.08 | 0.68 | 0.60 | 7.33 |
| #32 | 59 / 172 | 1.38 | 0.69 | 0.60 | 12.40 |

A ratio spanning 0.6 to 12.4 on a healthy shot is not a fault signal. The whole
load is carried by upstream's third condition, *"and both are stable"*, which it
does not define — and this repo's rule is that a threshold is derived from real
curves rather than inherited, which is precisely what an undefined word cannot
be.

### 2. Without real scales the comparison is circular

Confirmed in firmware (`release/stm32-blackpill`, `src/gaggiuino.ino`):

```c
currentState.shotWeight = currentState.scalesPresent
  ? currentState.shotWeight
  : currentState.shotWeight + actualFlow;
```

where `actualFlow` is derived from `smoothedPumpFlow` and `pumpClicks *
getPumpFlowPerClick(smoothedPressure)` — that last being PZ. With predictive
scales the weight series *is* an integral of the pump-flow model, so comparing
the two compares the model against itself and agrees by construction. A
detector that reads healthy exactly when it has no information is worse than
none.

There is a usable gate, though: `weightFlow` is only ever assigned inside
`if (currentState.scalesPresent)`, so a shot whose `weightFlow` series is
entirely zero had no real scale. That is a self-contained test on the shot
record, which is what a past shot needs — `get_machine_settings` reports what is
configured *now*, not what was in force when the shot was pulled.

### 3. There is no capture of the fault

Both fixtures are healthy shots. A threshold separating healthy from faulty
cannot be derived from one side of the comparison, and this repo has been
here before: `docs/plans/2026-08-08-flow-based-extraction-events.md` records the
same shape of negative result for a flow-based event detector.

**What would unblock it:** a capture of a shot pulled while the fault was
present, with real scales active, alongside a known-good shot on the same
profile and beans. Shots #364–#367 were that fault, and the machine keeps a
bounded history — so if any survive, they are the missing evidence. With those,
condition 1 becomes derivable and the metric becomes a real candidate.

---

## The diagnostics this server cannot reach

Worth recording because the answer is "not over REST", not "does not exist".

`SystemStateDto` carries `thermocoupleFaulted`, `pressureSensorFaulted` and
their `*FaultReason` strings (`"Open circuit"`, `"Short to GND"`,
`"Stuck reading"`, …). `SensorStateSnapshotDto` carries `valveState` — the
three-way solenoid's commanded state, which is the thing the outlet was watched
to confirm — plus `boilerState` and the raw `pin*Level` reads behind the
Maintenance page's MCU Pins table. Both are **WebSocket**, mirrored on MQTT
(`<prefix>/system`, `<prefix>/sensors`).

None of it is on REST. The real hardware capture in
`mockMachineStatusFromHardware` is the evidence: `/api/system/status` returns ten
fields and no fault flag among them.

This would have settled the solenoid question without watching the outlet, and
would settle the sensor-fault question that #166 currently answers by inference
across several shots. It also costs this server its REST-only client, a
WebSocket lifecycle against an ESP32 the caching work exists to spare, and a
push-model transport under a request/response tool surface. Recorded as a real
option with a real price, not as a next step.

---

## Firmware constants, verified

The idle venting the notes call "beat-dropping" is real, and the name comes from
the firmware's own on-screen string. From `src/gaggiuino.h` and
`src/gaggiuino.ino` on `release/stm32-blackpill`:

| Constant | Value |
| --- | --- |
| `SYS_PRESSURE_IDLE` | `0.7f` bar |
| boiler temperature condition | `< 100.0f` °C |
| `HEALTHCHECK_EVERY` | `30000` ms |

```c
while (currentState.smoothedPressure >= pressureThreshold
       && currentState.temperature < 100.f)
```

then `openValve()`, looping until pressure falls, then `closeValve()`. The
countdown popup reads `"Dropping beats in: %i"`, and the block is compiled only
under `LEGO_VALVE_RELAY || SINGLE_BOARD`.

**Caveat, and it matters.** That branch is the Blackpill-era release. The
machine this was diagnosed on is the latest PCB and screen, whose source is not
public in that repository — `main` carries a README and nothing else. So these
are corroboration, not the constants that machine is running.

What makes them trustworthy anyway is that they were arrived at independently.
The notes recorded 0.48 bar never triggering, 0.67–0.71 bar venting on a ~40 s
cadence indefinitely, and a ~15 s sustain. A 0.7 bar threshold explains the
first two exactly — 0.67 sits under it and 0.71 over — and 30 s plus time spent
in the vent loop explains the observed 40 s cadence better than the estimated
15 s does. Two sources that disagree slightly and agree on the mechanism.

The guidance states the behaviour and the approximate threshold as *firmware
behaviour to recognise*, never as a number to tune toward.

---

## Open, needs hardware

**Is a descale recorded at 50% of the cycle rather than at completion?** The
notes say so, and if true it means `get_maintenance_status`'s
`lastDescaleTimestamp` can read "descaled" for a cycle that was stopped early —
which changes whether the log can be trusted to rule a descale out.

Not verifiable from the public source: the service log is a Gen 3 feature and
`release/stm32-blackpill` has no service-log code at all. The reference
(`rest-api.md` L472-484) documents the fields and says nothing about when they
are written.

The guidance therefore carries the actionable half only — confirm a descale ran
to completion rather than trusting the log alone — and not the unverified 50%
figure. If hardware confirms it, it belongs in `maintenance.ts`'s docblock
beside the two field notes already recorded there, and in the vendored README's
Errata.

---

## Sources

- Gen 3 user manual — PZ calibration, Brew Delta, descale and backflush
  procedure, stop-on-weight predictive stop.
  `https://gaggiuino.github.io/#/learning/user-manual-gen3.md`
- `docs/upstream/MQTT.md`, `docs/upstream/websocket.md` — the fault and valve
  telemetry. Both re-fetched 2026-08-15 and **byte-identical** to the vendored
  copies, along with `rest-api.md`; no refresh needed.
- `Zer0-bit/gaggiuino`, branch `release/stm32-blackpill` — idle vent constants,
  predictive weight derivation.
- `apps/server/src/__fixtures__/api-responses.ts` — the REST status capture.
- The diagnosis notes for shots #364–#367.
