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
the action table's `c_*` entries — `c_upd_manual_prof`, `c_upd_settings`,
`c_upd_act_prof`, `c_upd_act_prof_id`, `c_reorder_prof`, `c_upd_desc_progr` and
the `c_wifi_*` family — are not exercised by that implementation, so this
erratum says nothing about them either way. **Do not read the table above as a
complete map**; read it as proof that L299's "Every" is false.

The document already half-knows this and contradicts itself: L62 says `d_prof`
arrives "In response to `g_prof`, **and after `c_new_prof` succeeds**", which
cannot be reconciled with L299's "Every".

**Why it matters here.** Profile *update* and *delete* are WebSocket-only —
there is no REST verb for either (`rest-api.md` offers `POST /api/profile` to
create and `DELETE /api/profile-select/*` to delete, but nothing to update). So
a future issue proposing a WebSocket write path is the most likely reader of
L299, and a `sendCommand` helper that waits for `d_resp` would hang on three of
the five requests it might send.

### `c_service_test` is named but never specified, and emits only `d_notif`

`websocket.md` L114 says the Maintenance page's Component Tests are "triggered
via `c_service_test`" — and `c_service_test` appears **nowhere else in the
document**. It has no row in the action table (L228-254), no payload type, and
no documented response.

Observed in practice: it emits `d_notif` and no `d_resp` at all. A client that
treats it as an ordinary `c_*` command and waits for the acknowledgement L299
promises will wait until its own timeout.

### `d_sensor_snap` is unsolicited and continuous — corroborated

The document is internally inconsistent here, and
`docs/plans/2026-08-04-live-telemetry-websocket-mqtt.md` noted the ambiguity and
declined to resolve it without hardware: Connection Behaviour says everything
past the on-connect burst "only arrives once it's asked for", while L58 says
`d_sensor_snap` is sent "Continuously, while sensor data is flowing from the
core" and L48 says "every client sees every sensor tick".

**L58 and L48 are right.** The second implementation receives it pushed
continuously and unrequested. This one is a corroboration rather than a
correction — the ambiguity is resolved in favour of what the message table
already said.

### `POST /api/settings/{category}` — "should" means "must"

Recorded in full at `client.ts`'s not-called list, where a tool author will
actually hit it. In short: the reference does say "All fields from GET response
should be included in the request body", and that advisory phrasing understates
it — omitted fields are **zeroed**, not left alone.

Worth noting here because it is a documentation defect rather than a behaviour
one: that sentence appears on **five of the six** category POSTs — boiler
(L147), system (L206), display (L299), scales (L346), led (L399) — and is
**missing from `POST /api/settings/theme`** (L252-256), which carries only the
persistence note. Nothing suggests theme behaves differently; it is the same
atomic whole-struct write described at L535. So the one category whose
documentation does not warn you is not the one category where it is safe.

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
