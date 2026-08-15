# Vendored upstream API reference

`rest-api.md`, `websocket.md` and `MQTT.md` in this directory are verbatim
copies of the Gaggiuino project's own API documentation:

| File | Retrieved | Source |
| --- | --- | --- |
| `rest-api.md` | **2026-08-04** | https://github.com/GAGGIUINO/gaggiuino.github.io/blob/master/docs/rest-api/rest-api.md |
| `websocket.md` | **2026-08-04** | https://github.com/GAGGIUINO/gaggiuino.github.io/blob/master/docs/rest-api/websocket.md |
| `MQTT.md` | **2026-08-09** | https://github.com/GAGGIUINO/gaggiuino.github.io/blob/master/docs/rest-api/MQTT.md |

`rest-api.md` was re-fetched on 2026-08-09 and is byte-identical to the
2026-08-04 copy, so its line citations are still current.

They are vendored rather than linked so `client.ts` can cite a stable path with
line numbers that do not move under it, the same reasoning that puts
externally-sourced Agent Skills under `.agents/skills/` with a lockfile.

## How to read them

**These documents settle *existence* questions, not *shape* questions.** They are
hand-written, and they demonstrably disagree with themselves about types — the
same field is a JSON string in one section and a boolean in another
(`lcdDarkMode` at rest-api.md L283 vs L118; `forcePredictive` and
`hwScalesEnabled` at L330-331 vs L117), and the CORS note at L532 ("All
endpoints include `Access-Control-Allow-Origin`") is contradicted twenty
lines earlier at L528. Four of the endpoints this server calls have no response
example at all.

So the loose zod schemas at `client.ts`'s upstream boundary are **policy, not
drift**, and this reference is not evidence for narrowing one. What it is good
for: which endpoints exist, which methods they take, what a field means, and
which ones this server has deliberately decided not to call.

The Errata below is the running list of places where that gap has bitten.

## Errata

Corrections to the vendored text. **Do not edit the files themselves** — their
value is that a refresh produces a reviewable diff.

### Provenance, and what it is worth

The `websocket.md` entries below are drawn from
[mxkissnr/gaggiuino-local-profiler](https://github.com/mxkissnr/gaggiuino-local-profiler),
a second, independently written implementation of these protocols that talks to
real hardware daily. Read 2026-08-08.

That is **strong evidence about behaviour and not a specification.** It is not
this repo's own hardware testing, and where the two disagree the hardware wins.
It is recorded because a second working implementation can settle things neither
the document nor a single deployment can: the document says what its author
believed, and one deployment only exercises the paths it happens to use.

That project is GPL-3.0 and this repo is not. Nothing here takes code from it —
these are facts about a *third party's* protocol, the Gaggiuino firmware's,
observed in the course of implementing against it.

### `d_resp` does not acknowledge every `c_*` command

`websocket.md` states the rule three times, without qualification:

> `c_*` actions **command** a change and get back a `d_resp` acknowledgement — L226
>
> Every `c_*` command gets a `d_resp` (`WebSocketResponseDto`) sent back to
> *only the requesting connection* — L299
>
> `c_*` commands a change and is acknowledged by `d_resp`. — L358

The profile commands answer with a **data push instead of an ack**:

| Request | Actual response |
| --- | --- |
| `c_new_prof` | `d_prof_dict` |
| `c_upd_prof` | `d_prof_dict` |
| `c_del_prof` | `d_prof_dict` |
| `g_prof_dict` | `d_prof_dict` |
| `g_prof` | `d_prof` |

The four commands observed to be answered by `d_resp` as documented are
`c_opmode`, `c_tare_pend`, `c_save_settings` and `c_save_act_prof`. The rest of
the action table's `c_*` entries (L228-255) — `c_upd_manual_prof`,
`c_upd_settings`, `c_upd_act_prof`, `c_upd_act_prof_id`, `c_reorder_prof`,
`c_upd_desc_progr` and the `c_wifi_*` family — are not exercised by that
implementation, so this erratum says nothing about them either way. **Do not read
the table above as a complete map**; read it as proof that L299's "Every" is
false.

The document already half-knows this and contradicts itself: L62 says `d_prof`
arrives "In response to `g_prof`, **and after `c_new_prof` succeeds**", which
cannot be reconciled with L299's "Every".

**Why it matters here.** Profile *update* and *delete* are WebSocket-only —
there is no REST verb for either (`rest-api.md` offers `POST /api/profile` to
create and `DELETE /api/profile-select/*` to delete, but nothing to update). So
a future issue proposing a WebSocket write path is the most likely reader of
L299, and a `sendCommand` helper that waits for `d_resp` would hang on three of
the five requests it might send.

### `c_service_test` is missing from the action table, and emits only `d_notif`

`websocket.md` L114 says the Maintenance page's Component Tests are "triggered
via `c_service_test`". Its payload *type* is specified — `ServiceTestCommandDto`
at L112-124, with the `ServiceTestPeripheralDto` enum and field notes — but the
action itself has **no row in the client→server action table** (L228-255) and no
documented response, so a reader working from that table will not find it at all.

Observed in practice: it emits `d_notif` and no `d_resp`. A client that treats it
as an ordinary `c_*` command and waits for the acknowledgement L299 promises will
wait until its own timeout.

### `d_sensor_snap` is unsolicited and continuous — corroborated

The document is internally inconsistent here, and
`docs/plans/2026-08-04-live-telemetry-websocket-mqtt.md` noted the ambiguity and
set it aside as not needing resolution for its own argument. Connection Behaviour
at L47 lists the sensor stream among the things that "only arrives once it's
asked for (`g_*` actions below) or once something changes" — and there is no
`g_sensor_*` action in the table — while L58 says `d_sensor_snap` is sent
"Continuously, while sensor data is flowing from the core" and L48 says "every
client sees every sensor tick".

**L58 and L48 are right.** The second implementation receives it pushed
continuously and unrequested. This one is a corroboration rather than a
correction — the ambiguity is resolved in favour of what the message table
already said.

### A shot's `weightFlow` and `pumpFlow` are not two independent measurements

Provenance differs from the entries above: this one is read from the **firmware
source**, `Zer0-bit/gaggiuino` branch `release/stm32-blackpill`, `src/gaggiuino.ino`
and `src/functional/predictive_weight.h`, read 2026-08-15. That branch is
Blackpill-era and the current PCB's source is not public, so treat it as strong
evidence about the model rather than as this machine's code.

Nothing in `rest-api.md` says where a shot's series come from, so a reader has no
reason not to treat `pumpFlow` and `weightFlow` as two instruments. They are not:

```c
currentState.shotWeight = currentState.scalesPresent
  ? currentState.shotWeight
  : currentState.shotWeight + actualFlow;
```

with `actualFlow` derived from `smoothedPumpFlow` and `pumpClicks *
getPumpFlowPerClick(smoothedPressure)` — the latter being PZ, the pump-zero
calibration constant `get_machine_settings` reports as `system.pumpFlowAtZero`.
So **without a real scale the weight series is an integral of the flow model**,
and comparing the two compares the model against itself.

`weightFlow` is assigned only inside `if (currentState.scalesPresent)`, which
gives a self-contained test on a shot record: an all-zero `weightFlow` series
means no real scale was active for that shot. That matters because
`get_machine_settings` reports what is configured *now*, not what was in force
when a past shot was pulled.

**Why it matters here.** The Gen 3 user manual's PZ calibration note recommends
comparing pump flow against weight flow to improve the calibration, which reads
like a ready-made health check to build a metric on. It is only meaningful with
hardware or Bluetooth scales active, and
`docs/plans/2026-08-15-upstream-flow-restriction.md` records the measurement
showing the manual's stated window is dominated by transients besides.

### `POST /api/settings/{category}` — "should" means "must"

Recorded in full at `client.ts`'s not-called list, where a tool author will
actually hit it. In short: the reference says "All fields from GET response
should be included in the request body", and read together with Notes item 4's
whole-struct atomic write (L535) the safe reading is that omitted fields are
**zeroed** rather than left alone.

**That reading is inferred from the documentation, not observed on hardware** —
unlike the `websocket.md` entries above. A second implementation reads it the
same way (its MQTT setup re-reads the whole `system` category and merges before
writing) but cites this same sentence as its reason, so it is a shared reading
rather than independent corroboration. Nothing anyone has written down says
"omitted fields are zeroed" in as many words. It is the conservative reading, and
the cost of being wrong about it is asymmetric.

Worth noting here as a documentation defect rather than a behaviour one: that
sentence appears on **five of the six** category POSTs — boiler (L147), system
(L206), display (L299), scales (L346), led (L399) — and is **missing from
`POST /api/settings/theme`** (L252-256), which carries an RGB565 format note and
the persistence note but not the all-fields sentence. Nothing suggests theme
behaves differently; it is the same atomic whole-struct write described at L535.
So the one category whose documentation does not warn you is not the one category
where it is safe.

## Refreshing

Re-download all three files, then re-run the audit in issue #102 — the point of
vendoring is that a diff here is reviewable. Every citation in `client.ts` is a
line reference into these files, so a refresh that moves lines means those
citations need re-checking, and the Errata above needs re-checking with them.

```bash
BASE=https://raw.githubusercontent.com/GAGGIUINO/gaggiuino.github.io/master/docs/rest-api
for f in rest-api.md websocket.md MQTT.md; do curl -sSfo "docs/upstream/$f" "$BASE/$f"; done
```

`docs/` is in `release-please-config.json`'s `exclude-paths`, so refreshing
these files cannot cut an empty release on its own.

**Last checked 2026-08-15**: all three re-downloaded and byte-identical to the
vendored copies, so every line citation in `client.ts` and every line number in
the Errata above is still valid. `master` and `main` both resolve.
