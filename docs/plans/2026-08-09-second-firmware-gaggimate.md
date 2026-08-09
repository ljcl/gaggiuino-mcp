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

- **Their normalisation target is our entire data model.** `analysis.ts`,
  `normalize.ts`'s `SCALE_BY_10` set, `events.ts`'s bar-per-second thresholds,
  the shot-graph app's series registry and `get_shot_data`'s output schema are
  all built on Gaggiuino's ×10-integer, decisecond wire format. A second
  firmware does not add a client; it adds a translation layer underneath all of
  that, whose failure mode is silently wrong numbers in a tool result. That is
  the same failure this repo rejected live telemetry over, arriving by a
  different route.
- **Four unfillable status fields is a tool-contract problem, not a UX one.**
  `MachineStatusOutput` would have to make them nullable for **every** user,
  including everyone with a Gaggiuino, and the advertised schema is a
  permission-grant key (AGENTS.md, "The advertised surface is a permission-grant
  key"). Every existing installation would re-grant in exchange for a machine it
  does not own.
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
