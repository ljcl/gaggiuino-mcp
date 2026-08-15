# Upstream flow restriction: what to build, and what not to

Research record for the diagnosis of shots #364–#367, where one cause upstream
of the group presented as three faults that each looked separate and each had a
wrong-but-obvious explanation.

The question asked was whether any of it belongs in this server. The answer is
**guidance, not a tool**.

Two things happened on the way. The one genuinely computable candidate did not
survive being measured — and then the shots themselves were still on the
machine, and they revised the diagnosis that prompted the work. The mechanism is
a circuit that drains and has to be refilled, not a pump that cannot deliver;
the free-flow test that appeared to prove a flow deficit was misread; and the
detector worth having turned out to need no new metric at all. Those sections
are last and are the ones to read.

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
That is one true reading of the observation. The other is that the water is
real and went into filling an empty circuit rather than into the cup — and the
captures below show the excess reaching 127 ml on a single shot that way.

Left alone, a model reading the existing bullet lands confidently on a sensor
fault for a symptom that is hydraulic. The bullet now points at the new section,
which separates the two by reading the excess against peak pressure rather than
asserting either cause.

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
the deficit this diagnosis appeared to show.

It is not shippable, for three reasons — and by the time the third was resolved
there was no deficit left for it to measure.

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

**Resolved — the machine still had them.** See the section below.

---

## What the machine's own shots then showed

Shots #358–#367 were still in history and were pulled through this server's own
tools. `get_machine_settings` reports `hwScalesEnabled: true` and
`forcePredictive: false`, so blocker 2 above does not apply to any of them:
`weightFlow` is a real measurement throughout.

They **do not support the diagnosis they came from**, and the correction is the
most valuable thing in this document.

### The free-flow test did not show a flow deficit

Shot #365 *is* the jug test — 15.6 s, no portafilter, pressure never above
1.0 bar as expected with nothing to restrict it. The original reading was that
delivery ran at 2.09 ml/s against a 4.9 ml/s command, i.e. 43% of it, and that
this was the fault.

`targetPumpFlow` in that record ramps **0.3 → 5.0 ml/s**. 4.9 is where the ramp
*ends*, not what it asked for on average. Integrated, the profile commanded
50.1 ml over the run and 32.6 g reached the jug — 65%. In steady state over the
last three seconds:

| | ml/s |
| --- | --- |
| commanded | 4.92 |
| `pumpFlow` (model) | 4.73 |
| `weightFlow` (scale) | 4.45 |

That is 90% of command on the machine's own scale, and ~97% once the scale's
own 11% under-read is applied. **There is no sustained flow deficit.** The
apparent one is an artefact of comparing a whole-run average against a ramp's
final value.

Two further corrections fall out of the same record:

- The "~11% under, so the volume model is trustworthy" note compared the
  **machine's drip-tray scale** (29.1 g) against the external scale (32.6 g).
  That is a scale calibration figure and says nothing about the volume model.
- The volume model, `waterPumped`, read **46.7 ml against 32.6 g delivered —
  43% high**. That is not an error: it counts water *pumped*, and 15.6 ml of it
  went into filling the circuit before output started at t≈9.5 s. Reading it as
  a delivery figure is what makes a correct counter look broken.

### The real signature is a fill, not a deficit

Shot #364 is the dead shot: 61.2 s, pressure never above 1.7 bar against targets
of 6 → 2.5 → 9 bar, `shotWeight` flat at zero for **44.8 s**, then output at a
steady 3.6–3.8 ml/s against a 3.5 ml/s command for the remaining 16.4 s.
`pumpFlow` tracked `targetPumpFlow` the whole time.

So the pump delivered command, and ~131 ml went in before anything reached the
cup. Water entering an empty circuit meets no restriction, which is why pressure
could not build. The mechanism is **drain-back and refill**, not a pump that
cannot keep up — and it matches the notes' own "worst from cold, clears with a
flush, returns overnight" better than a flow deficit does.

### The detector that does work, and needs no new metric

Excess volume (`waterPumpedMl − finalWeightG`) against `peakPressureBar`, across
the eight puck shots in that run:

| peak bar | 1.7 | 2.4 | 2.5 | 2.9 | 7.0 | 7.9 | 10.2 | 11.4 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| excess ml | 127 | 83 | 64 | 60 | 37 | 25 | 22 | 15 |

Monotonic, no inversions, Pearson r = −0.87, and the two clusters do not touch:
under 3 bar carries 60–127 ml, above 7 bar carries 15–37 ml, with nothing
between 2.9 and 7.0 bar.

**Both fields are already in `OutcomeMetricsSchema`**, so `list_recent_shots`
already returns everything needed. This shipped as guidance telling the model to
read the two together — no new metric, no schema change, **no permission grant
re-keyed**, which is a better outcome than the flow-ratio metric would have been
even had it worked.

A `fillVolumeMl` metric — volume pumped before output begins — is the more
direct statement of the same thing and remains a candidate. It needs a healthy
baseline across more than one profile and a rule for shots with no real scale,
neither of which one run of one profile settles.

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
- Shots #358–#367, pulled off the machine through this server on 2026-08-15,
  plus `get_machine_settings` confirming hardware scales active.
- The diagnosis notes for shots #364–#367 — whose central conclusion these
  captures revise.
