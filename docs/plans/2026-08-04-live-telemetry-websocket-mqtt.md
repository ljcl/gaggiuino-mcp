# Live shot telemetry: WebSocket, MQTT, or neither

First deliverable of #103. The upstream project published a full WebSocket
protocol reference (`ws://<device>/ws`, protobuf-framed, server-push sensor and
shot-in-progress telemetry) and, in the same release, MQTT publishing of
overlapping data. There are now two live transports where there were none, and
this server uses neither.

This note answers one question: **is live telemetry worth its costs, and if so
over which transport?** It is a decision document, not a survey. Code is out of
scope; the outcome is a decision plus a short list of REST-only work that came
out of reading the two documents side by side.

> **Amended 2026-08-09 (#139).** Two of this note's supporting cost arguments
> were written from documents rather than from a working implementation, and
> both were wrong on the facts: the protobuf-binding cost is overstated, and the
> MQTT assessment was made without `MQTT.md`, which is now vendored. Both are
> corrected in place, marked as amendments where they sit.
>
> **The decision itself is unchanged, and this is not a re-run of it.** Its
> crux is structural — MCP is request/response, and a tool call has no channel
> to push a later frame — and nothing in either correction touches that. The
> corrections matter because the next person to revisit this should not start
> from premises already known to be false.

## What the release actually added

From `websocket.md`, the endpoint carries three things the REST surface cannot:

- `d_shot_snap` (`ShotSnapshotDto`) — one message per sample **during** a shot.
  REST only exposes a shot after it has been written to history.
- `d_sensor_snap` (`SensorStateSnapshotDto`) — continuous sensor readings as
  real floats, including `pumpFlow`/`weightFlow` and the relay/valve/pin states
  that `/api/system/status` does not report.
- `d_sys_state` (`SystemStateDto`) — `thermocoupleFaulted`,
  `pressureSensorFaulted` and their `*FaultReason` strings, `operationMode`,
  `scalesPresent`, `coreType`.

Everything else on the endpoint has a REST equivalent this server either
already uses or has an open issue for. The table at the end of this note works
through all of it.

## The crux: where could a live connection even live?

This is the part that decides the question, and it decides it before any of the
cost arguments below are needed.

**MCP is request/response. A tool call has no channel to push a later frame.**
Whatever holds the socket, the data still has to reach the model through a tool
result, and a tool result is returned once.

### Candidate 1 — the server process

The server is the *right network location*. It is the only component in this
system guaranteed to be on the same LAN as the machine; that is precisely why
the deployment story is "run it next to the machine and expose `/mcp` through a
tunnel". If anything holds a WebSocket, it should be this.

But it has nowhere to deliver the frames. Three shapes were considered:

1. **A tool that blocks until the shot ends.** A shot runs 25–45 s. This
   server's own `overallTimeoutMs` is 20 s, and it is 20 s because three
   attempts plus backoff came to ~34 s and hosts abandoned the call before the
   model ever saw a message. A tool that deliberately blocks for 40 s is the
   same failure, on purpose.
2. **A tool that returns the latest frame from a background-maintained cache.**
   This is a live reading served from a store, which is the one thing
   `client.ts` refuses to do (`/api/system/status` is deliberately uncached
   because every value it reports is instantaneous). It would also make
   `machine.state` dishonest: a held socket that has gone stale would keep
   asserting reachability, which is the same class of bug as a cache hit
   calling `recordUpstream("ok")`. And the payload it returns is, field for
   field, close to what `get_status` already returns from one HTTP GET.
3. **`notifications/progress` during a long call.** The only server→client push
   MCP offers today is scoped to an in-flight request and is display material,
   not model context. It still requires (1) to exist underneath it.

So: the server can hold the connection and cannot use it.

### Candidate 2 — the MCP App iframe (shot-graph)

The app is the only component here with a render loop, so this is the obvious
place to want the socket. It does not work, for a reason outside this repo's
control:

- **Mixed content.** The host page is HTTPS. The machine speaks `ws://` and
  serves no TLS — `websocket.md` documents exactly one endpoint,
  `ws://<device-ip>/ws`. Browsers block an insecure WebSocket from a secure
  context. This fails before any CSP or sandbox question is reached, and
  nothing in this repo can fix it.
- **The browser is not on the LAN.** The server is; the host's browser might be
  a phone on cellular. The tunnel exists because of exactly this asymmetry. An
  app-held socket inverts the one topology assumption the deployment is built
  on.
- **`gaggiuino.local` is mDNS**, which mobile browsers frequently will not
  resolve even when they are on the right network.
- **It would bypass the server entirely.** An app talking straight to the
  machine gives up the OAuth gate, the retry/deadline discipline, the zod
  validation boundary, and the rule that the server writes the actionable
  diagnostic — all four in one move — and puts the machine's LAN address in the
  host's browser.
- Even if all of that were solved, live frames only reach the *model* through
  `updateModelContext`. `useModelContextSync` debounces and de-duplicates for a
  reason; a per-sample context write is a context-window firehose.

### Candidate 3 — neither: the app polls a server tool

The shape actually available today is the app calling a server tool on an
interval. That is polling with extra steps, and the polls land during the shot
— the exact window in which the ESP32 is busiest, and the window in which a
503 while it writes to flash is most likely. `/api/system/status` also lacks
`pumpFlow` and `weightFlow`, so the polled curve would be strictly worse than
the graph the machine's own screen is already drawing two feet from the user.

**Conclusion of the crux: there is no location where a live connection both
works and delivers value.** The bottleneck is not the transport. It is that
this protocol has no channel for a frame that arrives after the answer.

## What a WebSocket would cost, if the crux were solved

Recorded so a future revisit does not have to re-derive it.

### The connection budget, quantified

`websocket.md`: **max 3 concurrent connections**; a 4th upgrade gets `429`. The
document names the bundled web interface and the embedded touchscreen UI as the
primary consumers, and #103 correctly adds an HA/MQTT bridge as a third
competitor.

A standing connection from this server claims **33% of a hard cap of three**,
permanently. Against that, the window in which live data is even meaningful is
the shot itself: four shots a day at ~35 s is **140 s out of 86,400 — 0.16% of
the day**. Holding a third of the machine's connection budget 100% of the time
to be present for 0.2% of it is not a trade this repo makes anywhere else.

The failure mode is what settles it. When the cap is reached the *user's own web
UI* is what fails to connect, with a `429` and no explanation, and they will
blame the machine rather than the MCP server sitting quietly in the background.

### A held connection is not passive

`websocket.md` is unambiguous on `d_log_record`: *"It's a firehose with no
filtering or subscribe/unsubscribe — once connected, every client gets every
line."* So merely being connected makes the ESP32 serialize and transmit every
firmware log line to a listener that reads none of them.

The document is internally inconsistent about the sensor stream — Connection
Behaviour says everything past the on-connect burst *"only arrives once it's
asked for"*, while the message table says `d_sensor_snap` is sent
*"Continuously, while sensor data is flowing"* and the broadcast note says
*"every client sees every sensor tick"*. That ambiguity does not need resolving:
the log firehose alone makes a standing connection a continuous load on the one
device the entire caching design exists to spare.

Connect-on-demand is not free either. On connect the server pushes five
messages on a staggered schedule over 1.25 s (`d_act_prof`, `d_settings`,
`d_prof_dict`, `d_shot_hist_index`, `d_service_log`), wanted or not. A
one-shot "connect, ask `g_sys_state`, close" therefore costs five unsolicited
payloads and a ≥1.25 s window, against ~50 ms for an HTTP GET.

### Protobuf bindings: a build dependency on another repo

*"To talk to this API you need protobuf bindings generated from this project's
own `.proto` files — there's no separate schema/IDL package to install."* The
sources are three globs (`lib/Common/**`, `frontend-controls/common/**`,
`frontend-controls/webserver/**`) inside the firmware repository.

Three options, all bad in this repo's terms:

- **Codegen at build time from a firmware checkout.** The Docker build is a
  `turbo prune --docker` of a workspace that currently needs no toolchain
  beyond Bun; this adds a `protoc` (or `@protobuf-ts/plugin`) stage, network
  access to a second repository during the image build, and a pinned SHA that
  nothing watches. Dependabot watches npm and the `oven/bun` base tags; it
  cannot watch a submodule's `.proto` for a semantic change, and there is no
  analogue of the Bun-version-skew guard for it.
- **Vendor the generated TypeScript.** A copy of another project's schema, in
  this repo, with no version signal and no mechanism that notices when it stops
  matching the firmware.
- **Hand-decode the two or three messages we need.** Cheapest in dependencies
  and honest about scope, but it hardcodes field numbers, which is the same
  skew exposure with less tooling.

> **Amendment, 2026-08-09 (#139): there is a fourth option, and it makes this
> section's cost estimate too high.** The decision is unchanged — see the crux,
> which none of this touches — but the reasoning below was written from two
> documents rather than from a working client, and a working client uses a path
> not listed above.
>
> `gaggiuino-local-profiler/lib/gaggiuino-proto.js` in
> [mxkissnr/gaggiuino-local-profiler](https://github.com/mxkissnr/gaggiuino-local-profiler)
> is ~250 lines of **hand-written runtime descriptors** handed to a protobuf
> runtime: no codegen step, no firmware checkout, no submodule, no generated
> artifact in the tree, and nothing for Docker or Turborepo to build. The subset
> this server would need is smaller still.
>
> That deletes the first bullet's objections outright — there is no `protoc`
> stage, no network access to a second repository during the image build, and no
> unwatched pinned SHA. It does **not** delete the third bullet's objection:
> descriptors written by hand pin field numbers exactly as hand-decoding does,
> so "Version skew fails quiet" below stands unamended and is now the *whole* of
> the binding cost rather than one item among several.
>
> The practical consequence is to trigger #1, which called a published schema
> package "the single biggest lever, and it is upstream's to pull". Most of what
> it was gating turns out not to be there. It is narrowed accordingly.

For the server itself the runtime dependency size is irrelevant (no bundling).
For the app it is not: `app.html` is 1,047,652 B raw / 279,233 B gzip against
budgets set ~10% over, and the resource body is re-sent on **every render**. A
decoder in the app spends most of that headroom. It was not measured, because
the app path is already dead on mixed content — measure it only if that changes.

### Version skew fails quiet, and this repo fails loud

`websocket.md`, Notes item 7: *"Unrecognised/malformed frames: logged and
silently dropped before the handler runs — no error frame is returned."* Plus
protobuf's own semantics: a decoder skips fields it does not know.

Put concretely: if a firmware release renumbered `SensorStateSnapshotDto.pressure`
away from field 6, our decoder reads the field-6 default and this server reports
**"Pressure: 0 bar"** as a fact. Nothing errors, nothing logs, and the model
gives dial-in advice on a fabricated reading.

That is the exact inverse of the rule `client.ts` is built on. The loose zod
schemas at the client boundary exist so a firmware revision cannot take the
server down *while still* failing loudly — with the offending path named — when
a body is truncated or a required field is missing. Binary framing offers no
equivalent: there is no "the offending path" in a stream of field numbers. The
tolerance strategy does not transfer, and the failure it is replaced by is
silent wrong data rather than a visible error.

## MQTT as the alternative

Assessed from the machine's `system` settings block (`mqttEnabled`, `mqttHost`,
`mqttPort`, `mqttUsername`, `mqttPassword`, `mqttTopicPrefix`) and the
cross-references in `websocket.md` to notification and retained maintenance
topics. `MQTT.md` itself was not part of the material reviewed for this note;
nothing below depends on its details.

> **Amendment, 2026-08-09 (#139): `MQTT.md` has since been vendored** at
> `docs/upstream/MQTT.md` (retrieved 2026-08-09), so the caveat above no longer
> has to stand. Reading it changes nothing in this section's conclusion and
> confirms the two things it was hedging:
>
> - **Retained topics, settled.** Notes item 4 (L324) names them exactly:
>   `sensors`, `system`, `profile/active`, `maintenance` and `status` are
>   retained. The cross-referenced "retained maintenance topic" this section
>   assumed from `websocket.md` is real. `<prefix>/shot` is **not** among them
>   and is published one message per sample during a shot (L127-129) — so the
>   live shot, the one thing the crux rules out, is one of the two topics a late
>   subscriber cannot recover from the broker (`<prefix>/notification`, L186, is
>   the other).
> - **`<prefix>/status` carries the literal strings `online` / `offline`** as a
>   retained availability topic whose `offline` payload is registered as the
>   connection's LWT (L49-60), not JSON.
>
> One genuinely new fact, and it outlives this note: **MQTT's `shot` topic and
> the WebSocket's `ShotSnapshotDto` are two different data models, not two
> encodings of one.** The trap is that they look identical. Nine of the shot
> topic's ten field names are byte-for-byte the DTO's — `pressure`, `pumpFlow`,
> `weightFlow`, `temperature`, `shotWeight`, `waterPumped`, `targetTemperature`,
> `targetPumpFlow`, `targetPressure` — and the same nine are in this server's own
> `ShotDatapointsSchema`. Only the time field differs, `timeInShot` becoming
> `timeInShotMs`, which is the one honest signal that anything changed.
>
> The values are not the same. MQTT publishes real floats — `"pressure": 9.1`,
> `"temperature": 93.4` (L133-144) — where the REST and protobuf surfaces this
> server is built on send `91` and `934` in deciseconds and ×10 integers. Eight
> of the nine shared names are in `normalize.ts`'s `SCALE_BY_10`, so a hand-written
> MQTT path that reused `normalizeValue` would turn 9.1 bar into 0.91 with nothing
> to catch it. Near-total name overlap carrying a different scale is exactly what
> invites "we already parse this shape", and it is wrong before it starts.
>
> Scoped to the shot topic deliberately: `<prefix>/sensors` and
> `SensorStateSnapshotDto` really do agree on both names and value convention
> (`websocket.md` L78 notes the sensor DTO uses real numbers, unlike the shot
> format), which is precisely why the shot topic's divergence is easy to miss.
>
> Also worth recording against the "Mid-shot control tools" rejection below:
> MQTT has its own command surface (`cmd/profile/select`, `cmd/opmode`,
> `cmd/tare`, `cmd/manual`, L200-248), including manual pressure/flow setpoints.
> That does not revive the idea — the objection was a model's reaction time
> against a 30-second shot, not the absence of a transport — but the rejection
> should not be read as "there is no way to do it".

MQTT has one genuine advantage and it is worth stating plainly: **it does not
consume a WebSocket slot and adds no load to the ESP32 that the user has not
already opted into.** If MQTT is enabled the machine is publishing anyway;
subscribing is free from the machine's point of view. That is strictly better
than a WebSocket on the cost axis that matters most here.

It loses on everything else:

- **It requires a broker.** This server ships as one distroless container with
  no dependencies and a compose file that pulls one image. MQTT means either
  assuming infrastructure most users do not have, or shipping a second service
  with its own port and credentials as a hard dependency of a feature most
  users will not use.
- **It requires the user to have enabled MQTT on the machine**, which is off by
  default (`mqttEnabled: false` in the documented settings example).
- **It adds a second secret.** Broker credentials would need environment
  variables, `.env.example` entries (which `envExample.test.ts` enforces in both
  directions), and documentation — alongside the three OAuth variables.
- **It does not solve the crux.** A subscription is still a push channel into a
  process that has no push channel to the model. Every argument in "Candidate 1"
  applies to MQTT unchanged.

MQTT is the better transport for a problem this server does not have.

## What is valuable here that needs no live connection

Reading the two documents together, the useful findings are all REST.

| WebSocket message | REST equivalent | Verdict |
| --- | --- | --- |
| `d_service_log` (`ServiceLogDto`) | `GET /api/maintenance` | Covered as far as the documentation reveals — `ServiceLogDto`'s field list is not published, so this rests on the two being cross-referenced to the same MQTT maintenance topic. Already tracked as #100. |
| `d_settings` (`GaggiaSettingsDto`) | `GET /api/settings` | Covered by `get_machine_settings`. |
| `d_act_prof` / `d_prof_dict` / `d_prof` | `/api/profiles/all`, `GET /api/profile/{id}` | Covered; the per-profile definition is #99. |
| `d_sensor_snap` | `GET /api/system/status` | Mostly covered. Status omits `pumpFlow`/`weightFlow` and the relay/valve/pin states — none of which change a dial-in answer between shots. The reference gives that endpoint one sentence and no example, so the omission is read off `mockMachineStatusFromHardware` and `MachineStatusSchema`, not off the doc. |
| `d_sys_state` (`SystemStateDto`) | **nothing** | The one real gap. See below. |
| `d_shot_hist_index` (`ShotHistoryIndexDto`) | none | Would replace `history.ts`'s bounded guess with an authoritative list. Real, but see below. |
| `d_shot_snap` | none (REST exposes a shot only once written) | The live shot. This is the thing the crux rules out. |
| `d_notif`, `d_log_record`, `d_esp_mem`, `d_wifi_*`, `d_ble_scls` | none / partial | Machine-operations concerns, not dial-in. Out of scope. |
| `d_fw_upd_progr`, `d_desc_progr` | `GET /api/firmware/progress` | Covered where it matters; OTA is not this server's job. |

Two entries deserve a follow-up, and in both cases the cheapest path is
upstream, not here.

**Sensor fault diagnostics.** `thermocoupleFaulted` / `pressureSensorFaulted`
and their `*FaultReason` strings ("Open circuit", "Short to GND", "Stuck
reading", "ADS error code: -100") have no REST equivalent.
`mockMachineStatusFromHardware`, captured verbatim from a real machine on
2026-07-27, confirms `/api/system/status` did not carry them at that point. So
when a thermocouple faults today, this server reports a temperature with no
indication that it is meaningless.

The cheap fix is not a WebSocket. `MachineStatusSchema` is a `z.looseObject`,
so if the firmware added these fields to `/api/system/status` they would flow
through this server **with no schema change at all** — only `formatStatus` and
`MachineStatusOutput` would need a line each. That is an upstream feature
request worth making before it is a client-side project worth doing.

**Shot history index.** `d_shot_hist_index` would let `walkShotsBack` stop
probing: today a walk spends up to `MAX_GAP_PROBES` (5) wasted 404s discovering
where retained history ends. Authoritative beats bounded guessing — but not at
the price of the entire protobuf stack for a list of ids. Same conclusion: ask
upstream for a REST shot index.

## Decision

**No live telemetry, over either transport, now. Not WebSocket, not MQTT.**

The reason is not cost, it is fit. MCP has no channel to deliver a frame that
arrives after the tool result; the server is the only component on the right
network but has nowhere to put the data; the app has somewhere to put it but
cannot reach the machine from an HTTPS page over `ws://`. Both transports solve
a transport problem, and the problem here is protocol shape.

The costs are recorded above because they matter if the fit question is ever
answered: 33% of a hard three-connection cap held permanently for a 0.2%
relevance window, a log firehose that cannot be unsubscribed from, a
build-time dependency on another repository's `.proto` files with no skew
guard, and a failure mode — silent wrong readings — that inverts this server's
stated preference for failing loudly with an actionable message.

What this note *does* endorse is the REST-only subset it surfaced: #100
(`/api/maintenance`), #99 (`GET /api/profile/{id}`), #102's version surfacing,
and two upstream requests — sensor fault flags on `/api/system/status`, and a
REST shot-history index.

## Rejected, and why

- **A standing WebSocket connection held by the server.** 33% of the connection
  budget, a permanent log firehose, and nowhere to deliver a frame.
- **Connect-on-demand WebSocket for one-shot reads** (`g_sys_state`). The full
  protobuf toolchain plus five unsolicited on-connect pushes and a ≥1.25 s
  window, to fetch fields that would arrive free if the firmware added them to
  an existing JSON endpoint.
- **A WebSocket held by the shot-graph app.** Blocked by mixed content before
  anything else; also inverts the LAN topology and bypasses every guarantee the
  server provides.
- **App-side polling of `get_status` during a shot.** Hammers the ESP32 in the
  precise window it is busiest, to draw a worse version of the graph on the
  machine's own screen.
- **MQTT subscription.** Better on machine load, worse on everything else, and
  it does not address the crux. Requires a broker this server cannot assume.
- **Shipping a broker in compose.** A hard infrastructure dependency for a
  feature most installs would never enable.
- **Mid-shot control tools** (`c_opmode: BREW_MANUAL` + `c_upd_manual_prof`).
  Tempting because they are the only genuinely WS-only *write* capability, and a
  non-starter: a shot is ~30 s, and a model turn plus a `readOnlyHint: false`
  approval prompt plus a network round trip does not fit inside it. Adjusting
  extraction pressure through an LLM's reaction time is not a feature.
- **Vendoring generated protobuf bindings.** A copy of another project's schema
  with no version signal and no mechanism to notice divergence.

## What would change the decision

Concrete triggers, not sentiment.

1. **A version signal on the wire format.** *Narrowed 2026-08-09 (#139) — see
   the amendment under "Protobuf bindings".* This originally read "a published,
   versioned schema package… the single biggest lever, and it is upstream's to
   pull", on the reasoning that codegen, Docker and skew objections would
   collapse together. Two of those three were never really there: ~250 lines of
   hand-written runtime descriptors need no codegen stage and no build-time
   dependency on another repository, which is how a working client does it
   today.

   What survives is the skew objection alone, and it is enough on its own:
   hand-written descriptors pin field numbers with nothing watching them, and
   the failure is a silently wrong reading rather than an error. So the trigger
   is **any mechanism that makes a field-number change observable** — a
   published versioned package is the obvious one and still the best, but a
   protocol version field in the frame, or a documented schema hash, would do
   as well. Absent one, the objection stands however the bindings are obtained.
2. **A host-supported push primitive that reaches the model.** If MCP gains a
   server-initiated message that a host we target actually delivers into model
   context mid-turn — not display-only progress scoped to an in-flight call —
   the crux is gone and this note should be re-run from the top.
3. **The machine serves TLS, or a documented host exemption for private-network
   `ws://`.** Either one revives Candidate 2, though the LAN-topology objection
   would still need answering per install.
4. **The connection cap rises, or the doc documents a passive/read-only mode**
   that does not subscribe the client to the log firehose. `WS_MAX_CONNECTIONS`
   is a firmware constant; a change to it is observable in the same document.
5. **The fault fields appear on `/api/system/status`.** Not a revisit of this
   decision — that is the outcome this note is asking for, and it costs one
   line in `formatStatus` and one field in `MachineStatusOutput`.

Absent all five, the answer stays no, and the reason stays the same: the
transport was never the missing piece.
