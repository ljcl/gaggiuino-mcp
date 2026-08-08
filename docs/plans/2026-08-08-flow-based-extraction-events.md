# Flow-based extraction events: measured, and declined

Deliverable of #151, which existed because #133 proposed **two** detectors for
`phases[].events` and PR #150 shipped one. The second was described as:

> **Flow divergence** — pump flow sustained while `weightFlow` does not follow:
> water going somewhere other than the cup.

This note answers one question: **is there a flow-based event worth reporting
that `get_shot_data` does not already carry?** The answer is no, and the reason
is not cost — it is that the signal is either already reported under a different
name or is indistinguishable from a normal shot.

`events.ts` is unchanged by this note.

## The crux: the pump hides the thing we would be looking for

This decides it before any of the measurements below are needed.

In a pressure-targeted phase the machine holds a target by varying flow. When
the puck's resistance falls, the pump pushes **more** flow to keep the pressure
where the profile asked. So:

- while the pump can compensate, resistance falls and **pressure does not move** —
  and flow rising is also exactly what a normal shot does as the puck saturates;
- once the pump cannot compensate, **pressure leaves its target** — which is
  precisely what #150's collapse detector reports and #152's
  `pressureDeviationBar` measures.

A resistance failure severe enough to matter therefore *already* surfaces, as a
pressure observation. A flow detector would add a second name for the same
event, plus a window of mild failures that are — by construction — the ones the
machine successfully absorbed.

## What the data says

Measured 2026-08-08 against `londiniumShot33`/`32`, the captures committed in
`packages/shot-graph/src/__fixtures__/chart-data.ts`, with corroborating
readings from live Zer0 shots #347 and #355.

### 1. The premise is contradicted three times over

`pumpFlow` minus `weightFlow` does not have a consistent sign, so "pump pushes,
scale does not follow" is not a defect signature — it is a description of one
phase of every shot.

| phase | `pumpFlow` avg | `weightFlow` avg | |
| --- | --- | --- | --- |
| fill (shot33) | 4.68 | 1.84 | pump leads by 2.84 — **this is preinfusion** |
| soak (shot33) | **0.00** | 0.41 | weight climbs **2.1 g with the pump off** |
| extraction (shot33) | 1.72 | 2.25 | **scale leads by 0.54** — sign reversed |
| fill (shot32) | 4.84 | 2.12 | pump leads by 2.72 |
| soak (shot32) | **0.00** | 0.46 | weight climbs 2.4 g, pump off |
| extraction (shot32) | 1.77 | 2.21 | scale leads by 0.45 |

The soak row is the one that kills the framing outright: the pump is stopped
and coffee is still flowing, because the puck is a buffer that fills during
preinfusion and discharges afterwards. Live Zer0 shots show the same reversal in
extraction — #347 runs 2.3 ml/s pump against 3.9 g/s scale, #355 3.4 against 5.0.

### 2. The cumulative repair needs the dose

Comparing cumulative `waterPumped` against cumulative `shotWeight` fixes the
buffering problem arithmetically. It needs a baseline for how much the puck
should retain, and that is a function of the dry dose: shot33 retains 26.0 ml
(63.6 pumped, 37.6 g out), shot32 retains 21.4 ml (59.5 → 38.1 g).

The machine does not know the dose and this server stores nothing. Same wall the
extraction-yield factor hit in #141, and the reason it is recorded there too.

### 3. The differential formulation has no room for a threshold

#151 named this as the most promising avenue: look at the *shape* of the
`pressure`-to-`flow` relationship rather than its level, so no absolute baseline
is needed. Resistance `R = pressure / pumpFlow`, measured over the extraction
phase only, on two **good** shots pulled back to back on the same profile and
grind:

| | shot33 | shot32 |
| --- | --- | --- |
| `R` steepest fall, ≥0.5 s window | **−42 %/s** | **−43 %/s** |
| `R` steepest rise | +276 %/s | +162 %/s |
| `R` start → end of extraction | 2.50 → 2.90 | 4.20 → 3.21 |

Two things here are fatal, and the second more than the first.

**The noise floor is enormous.** A channel is a resistance drop, and a good shot
already produces −42 %/s drops. Setting a threshold with the ~3× separation the
pressure-collapse detector got would mean requiring resistance to more than
halve inside half a second — at which point the pump has certainly lost the
target and #150 has already fired.

**The direction is not even stable between two good shots.** Resistance *rose*
across shot33's extraction and *fell* across shot32's. Whatever a defect would
do to this quantity, these two disagree about what "normal" does.

For comparison, this is what a usable separation looked like when the
pressure-collapse threshold was set: floor 0.86 bar/s, threshold 2.5 bar/s,
consistent across three captures on two profiles.

## The evidence this note does not have

**No captured shot with a known extraction defect was available.** Shot #351 on
the live machine is the obvious candidate — it peaked at 2.7 bar and pumped
120.9 ml for 60.2 g, which is a resistance failure by any reading — and the
connector returned `502 Bad gateway` on both attempts to fetch it.

Stating plainly what that does and does not change:

- It **cannot rescue** finding 1 or 2. The sign reversal and the missing dose
  baseline are properties of every shot, not of good ones.
- It **could** in principle contradict finding 3, if a real defect turned out to
  sit far outside the ±42 %/s envelope.
- It does **not** touch the crux, which is an argument about what the pump does,
  not about any particular shot.

So the decision would survive #351 showing an extreme resistance drop — that is
the case the pressure detector already covers. It is recorded here anyway
because a note that hides its gaps is worth less than one that names them.

## Decision

**No flow-based event.** `events.ts` keeps one detector.

## What would change it

Concrete, not sentiment:

1. **A capture with a known, labelled defect that pressure did not reveal** — a
   shot the taster calls channelled where `pressureDeviationBar` is unremarkable
   and the collapse detector is silent. That is the existence proof this note
   could not obtain, and it would reopen finding 3 directly.
2. **The dose becoming available to the server.** #135 deliberately routes it to
   the model through guidance rather than into a tool schema; if that ever
   changes, the cumulative water-in versus weight-out balance becomes computable
   and finding 2 dissolves.
3. **A flow-targeted profile becoming the common case.** The crux assumes
   pressure targeting, where the pump masks resistance changes. Under a *flow*
   target the pump holds flow and pressure moves instead — which is still a
   pressure observation, but the reasoning above would need re-running rather
   than assumed.

## Rejected along the way

- **Instantaneous `pumpFlow` vs `weightFlow` threshold.** Fires on every
  preinfusion, and has the sign backwards during extraction.
- **Reporting "flow rose while pressure held" as an event.** That is a
  description of normal extraction — `pumpFlow` climbs 1.6 → 2.2 ml/s across
  shot33's extraction with nothing wrong.
- **A `P/Q` resistance number on `OutcomeMetricsSchema`.** Same objection #144
  records for the puck-resistance metric: it is undefined at zero flow,
  dominated by whichever samples sit near it, and varies with the profile rather
  than the puck. The numbers above are why — `R` spans 0.06 to 11.4 within a
  single shot.
