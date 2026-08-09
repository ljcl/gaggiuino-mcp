# A second firmware (GaggiMate): why it stays out of the client layer

"Does this work with GaggiMate?" is a question this repo will be asked, and
until now the answer was an omission rather than a decision. `client.ts` keeps a
well-maintained list of the endpoints it deliberately does not call, each with a
reason; there has been no equivalent for the machine it deliberately does not
support.

This note is that entry. Same shape as
`2026-08-04-live-telemetry-websocket-mqtt.md`: what was assessed, what it would
cost, the decision, the cheaper alternative, and the triggers that would reopen
it.

## Why now

[mxkissnr/gaggiuino-local-profiler](https://github.com/mxkissnr/gaggiuino-local-profiler)
supports both firmwares behind an adapter abstraction, read 2026-08-08. That
makes the cost of doing it **measurable rather than hypothetical**, which is the
only reason this is worth writing down today rather than when somebody asks.

Provenance and standing, as in `docs/upstream/README.md`'s errata: this is
evidence from reading a second implementation's source, not from running either
firmware here. It is strong evidence about what an adapter layer costs and it is
not a specification. That project is GPL-3.0 and this repo is not; nothing here
takes code from it.

## What their adapter layer actually costs

From `lib/machines/`:

- The contract is **10 async methods plus a synchronous `capabilities()`**, the
  latter a 7-key object gating three route families behind `501`s. The
  abstraction does not hide the difference between the machines — it surfaces it
  as "this one cannot do that".
- **The genuinely shared REST-client code is 8 lines, and it is copy-pasted
  rather than shared.** That is the number that decides this. The abstraction
  does not amortise a transport, because there is no common transport to
  amortise.
- The two firmwares barely overlap. Gaggiuino is JSON REST for reads and binary
  protobuf WebSocket for writes. GaggiMate is **two binary REST endpoints** plus
  JSON WebSocket for everything else: history arrives as `index.bin` (32-byte
  header, 128-byte records, three different divisors) and `.slog` files
  (bitmask-selected fields, per-field scale, two header versions), from paths
  whose ids must be zero-padded to six digits.
- The canonical shot shape they normalise to is **Gaggiuino's own** — ×10
  integers, deciseconds — so GaggiMate data is mapped lossily into a competitor's
  units, and their `getStatus` returns ten fields of which **four cannot be
  filled** for GaggiMate. Two are deliberately faked.
- Profiles are not comparable at all: a fully modelled protobuf DTO on one side,
  an opaque JSON blob on the other.
- Their own live telemetry is Gaggiuino-only in practice; the GaggiMate
  persistent client is written but unwired.

## Why the answer is no here

Those costs land differently on this server, and mostly harder.

- **Their normalisation target is our decoding layer.** `normalize.ts`'s
  `SCALE_BY_10` set, the `normalizeValue` calls threaded through `analysis.ts`
  and `events.ts`, a hardcoded `shotData.duration / 10`, and the shot-graph app's
  own `normalize.ts` (`SCALE = 10`, plus the raw-units first-drip threshold in
  `extractAnnotations`) all assume Gaggiuino's ×10-integer, decisecond wire
  format. A second firmware does not add a client; it adds a translation layer
  underneath all of that, whose failure mode is silently wrong numbers in a tool
  result. That is the failure the live-telemetry note's protobuf rejection turns
  on ("Version skew fails quiet, and this repo fails loud"), reached by a
  different route — not the reason live telemetry as a whole was declined, which
  was fit rather than cost.

  Worth being precise about what is *not* coupled, because it is where a seam
  would go if one were ever built: `get_shot_data`'s output schema is unit-clean
  (`finalWeightG`, `peakPressureBar`, `totalDurationSec`) and so is the chart's
  series registry, which carries display metadata and never a scale factor.
  `events.ts`'s thresholds are real-unit numbers too — they are calibrated to
  this machine's ~0.15 s **sample cadence**, not to the encoding. The scaling
  lives in exactly two `normalize` modules, and the schemas above them are the
  boundary a translation layer would have to hit exactly.
- **Unfillable status fields would be a tool-contract problem.** How much of one
  is unknown until somebody names them: `MachineStatusOutput` already has five of
  its nine fields `.nullable()` — `profileName`, `targetTemperatureC`,
  `upTimeSec`, `waterLevelPercent`, `weightG` — and those are the plausible
  candidates for a firmware that cannot fill them. The four that are not nullable
  are `brewActive`, `pressureBar`, `steamActive` and `temperatureC`, which any
  espresso firmware can answer. So the honest statement is: the cost is zero if
  the gaps fall inside the already-nullable five, and a re-key of every
  installation's permission grant if they do not, because the advertised schema
  is a permission-grant key (AGENTS.md, "The advertised surface is a
  permission-grant key"). Nobody has established which, and that is itself a
  reason not to start.
- **There is a cheaper answer that costs nothing.** `GAGGIUINO_URL` is
  per-process and the deployment is a single container, so someone with two
  machines runs two containers and adds two connectors. That is a better fit
  than a machine-selector argument on every tool — which would re-key every
  grant for a parameter almost nobody sets.
- **Nobody has asked.** The repo has one user and one machine.

## Explicitly not proposed: building the seam speculatively

The tempting middle path is to introduce the adapter interface now, with one
implementation, so the second is cheap later. That is a guess about the second
implementation, and the evidence against it is upstream's own experience: 8
lines genuinely shared, machine ids leaking past the abstraction into shared
routes, and the default machine bypassing the abstraction entirely.

An abstraction with one implementation is a guess. This one does not pay for
itself until the second machine is real.

## What would reopen it

Concrete and observable, so the "no" is falsifiable rather than permanent.

1. **Someone with a GaggiMate actually wants it.** The difference between a
   hypothetical user and a real one, and on a repo with one user it is the whole
   question.
2. **GaggiMate grows a JSON REST history surface**, removing the binary
   `index.bin` / `.slog` parsing. That is the bulk of the work and the part most
   likely to break on a firmware revision.
3. **The two firmwares converge on a shot representation**, so normalisation
   stops being a lossy translation into the other's units — which is what makes
   the failure mode silent today.

Absent all three, the answer stays no, and the reason stays the same: there is
no shared transport to abstract, so the seam buys nothing until it has two real
sides.
