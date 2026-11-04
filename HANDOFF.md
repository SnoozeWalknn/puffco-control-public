# Puffco app — handoff

Last updated 2026-11-03. Read this first, then `protocol/PROTOCOL.md`.

## The one-line state

A working Web Bluetooth controller for the Peak Pro 3DXL V2 is built, tested
(71 tests), committed to a **private** repo, and verified against real hardware.

**The control model was wrong and is now decoded.** `/p/htr/tcmd` is a *coil*
setpoint, not a chamber temperature: the chamber settles 27–46 °F under it, so
commanding a temperature directly always undershoots. That is the whole of the
old "488 °F wall", and it was neither power nor a firmware ceiling. The offset
also works to at least 80 °C, not the 20 °C the app's boost UI suggests.

Full decoded surface: **`protocol/PROTOCOL.md` §5–§10** — state machine, session
lifecycle, duration limits, NVM, logs, firmware gating, and what a curve can
really do.

## Hardware in use

| | |
|---|---|
| Device | Peak Pro 3DXL V2 |
| BLE MAC | `AA:BB:CC:DD:EE:FF` |
| Name | `Peak Pro XXXXX` |
| Firmware | **AW** (raw integer 39) |
| Model code | 13 |
| Chamber type | **2 = XL** (3DXL, correct) |
| Serial | ••••2110 (never write the full value) |
| Protocol | Lorax |
| Handshake that works | **lorax handshake** — key supplied at runtime, never committed |

## Repo

```
https://github.com/SnoozeWalknn/puffco-control-public    PUBLIC
```

Pages serves `ui/app.html` from this repo. The app needs the vendor handshake
constant at runtime (`PEAK_HANDSHAKE_KEY`, `tools/handshake.key`, or
`window.__PEAK_KEY_LORAX`); none of those files are tracked.

`reference/` is gitignored and must stay that way — it holds Puffco's decompiled
bundle and community libraries, which are not ours to host.

## What is verified on hardware (not assumed)

### The setpoint offset works

Writing `/p/app/tmpo` moves the device's own target 1:1:

```
offset  0 °C  →  /p/htr/tcmd 501 °F
offset 10 °C  →  /p/htr/tcmd 519 °F    (+18 °F)
offset 20 °C  →  /p/htr/tcmd 537 °F    (+36 °F)
offset  0 °C  →  /p/htr/tcmd 501 °F    (returns exactly)
```

1.8 °F per °C, exact, reversible — and it keeps going: 80 °C gives 635 °F on
`tcmd`. 20 °C was never the device's limit, only the official app's boost UI.

### Four constraints that shape the design

0. **`tcmd` is the coil, not the chamber.** The chamber runs 27–46 °F under it
   (decoded, `protocol/PROTOCOL.md` §6). Command `tcmd = chamber target + ~38 °F`
   or you will always undershoot. The profile temperature cannot be changed
   mid-session either — only the offset moves `tcmd`.

1. **The offset is session-scoped.** While idle, every write reads back `0.0` —
   the path accepts and stores nothing. During a heat cycle the same writes take
   effect immediately. A curve only exists inside a session.

2. **Thermal lag is seconds.** A +20 °C step moved the chamber ~8 °F in 2.5 s.
   Commands land instantly; the chamber does not. The UI must show measured vs
   commanded, never assume they match.

3. **`/p/htr/tcmd` is read-only.** It is the device's *reported* target. Writing
   it dropped it to 32 °F until the session ended. Use the offset.

4. **A session's 120 s must be re-armed after it starts.** Write the duration
   while idle and you get half of it; write it once the cycle is live and you get
   the full 120. `start_session()` does this for you.

### Other verified facts

| Fact | Value |
|---|---|
| Profile time field | accepts 15–120 s; 121–240 silently clamp to **120** |
| Session budget | **`profile time` + `timo`**, caps 120 + 180 = **300 s**. `timo` is the app's real "extra time" and only works live. |
| Profile slots | 4 real (0–3); the app's 25 is aspirational |
| Read latency | 57–73 ms per read |
| Chamber enum | NONE 0, CLASSIC 1, **XL 2**, PERFORMANCE 3 |
| Hidden telemetry | `/p/htr/pwr`, `/p/htr/duty`, `/p/htr/res` all readable |
| 480 °F curve | **held 476–485 °F, within ±6 °F for 100 % of a 15 s hold** |

## Two bugs found in my own assumptions

**Chamber type 2 is XL, not herbal.** The community Python client lists
`HERBAL 2, XL 4` — swapped. Puffco's own bundle says `NONE 0, CLASSIC 1, XL 2,
PERFORMANCE 3`. The bundle is authoritative. The app had labelled a 3DXL as
herbal. Fixed, and documented so it cannot return.

**Holding the BLE link costs battery.** Measured, 9 samples each:

```
connected      soc 10.8 → 11.3 over 36 s   (+0.5)
disconnected   soc 11.4 → 12.4 over 36 s   (+1.0)
```

A live connection roughly halves the charge rate.

## Open questions

### 1. Why does the chamber stop at ~488 °F?

**STATUS: ANSWERED 2026-11-03 by static decode, not by guessing at a cause.**
`/p/htr/tcmd` is the *coil* setpoint; `/p/htr/temp` is the chamber. The chamber
settles **27–46 °F below `tcmd`** and duty parks at ~10 % once the loop believes
it has arrived. With the offset capped at 20 °C (36 °F) by the app, almost the
entire offset was consumed by the gradient, leaving ~5 °F of usable range — so
"it stops at 488" was the gradient, not power and not a firmware ceiling.
Raising the offset to 15 °C took the chamber straight through 488 to 501 °F.
See `protocol/PROTOCOL.md` §6 and §9.

The original observation. With profile 530 °F and **zero offset**, the chamber
peaked at **458 °F** and the session ended at 48 s. So it is not the offset —
even a plain profile target is not reached.

Earlier the chamber plateaued at 488 °F while `tcmd` read 537 °F, with the
heater at **12 % duty / 5.6 W**. It was not straining; it had stopped driving.

Every one of those runs happened at **10 % battery or below**, which is what made
"it's the battery" look obvious. Battery was a confound, not the cause.

#### Run 1 — 2026-11-03 20:10, battery 71 % → 59.5 %

Raw data: `runs/curve-20261103-201045.csv` (gitignored, kept locally).
Plot it with `.venv/bin/python tools/plot_run.py runs/<file>.csv` → `.svg`.

```bash
.venv/bin/python tools/curve_run.py --addr AA:BB:CC:DD:EE:FF \
    --steps 480:15 490:10 500:8 --profile 455
```

| step | chamber peak | vs target |
|---|---|---|
| 480 °F | **501 °F** | over by 21 |
| 490 °F | **491 °F** | over by 1 |
| 500 °F | **495 °F** | short by 5 |

**The chamber passed 488 °F and reached 501 °F.** At seven times the battery
level of the earlier runs, the 488 °F wall was simply not there. That is
consistent with the power hypothesis and inconsistent with a hard firmware
ceiling at 488 °F.

It is **not** proof: 71 % is not 100 %, and the run never asked for more than
500 °F. A 100 % run that pushes 520–540 °F is still needed.

#### Two anomalies this run exposed (both unexplained)

1. **The chamber fell while the heater drove.** Raising the offset during the
   490 step took `tcmd` 493 → 519 °F, and the chamber went *down*, 471 → 463 °F,
   with duty spiking to **97 % / 45.8 W**. Commanding more heat made it colder.
   It then recovered to 491 °F as duty fell back to ~12 %. A thermal lag cannot
   explain a 40 °F fall against a 45 W heater — something in the control loop
   reacts badly to a large setpoint jump. This may be why curve steps of 10 °F
   track poorly (25 %, 18 %, 38 % of each hold within ±6 °F).

2. **`tcmd` was not honoured.** At the top step `tcmd` read **527 °F** while the
   chamber sat at **495 °F** with duty at **11 % / 5.6 W** — the same idle-heater
   signature as the original 488 °F plateau, just 32 °F higher. So the device
   reports a target it does not drive to. Either `/p/htr/tcmd` is not the
   control loop's real setpoint, or the offset stops being honoured above some
   point. **This is the more interesting question now**, and it matters for
   curve mode: if the offset saturates near 500 °F, the top of the advertised
   400–644 °F range is not reachable through it.

Battery fell 71 → 59.5 % in ~90 s of heating, which is the heater dominating as
the handoff already says.

#### Next run

Charge to 100 %, then ask for more than 500 °F so the question is actually posed:

```bash
.venv/bin/python tools/curve_run.py --addr AA:BB:CC:DD:EE:FF \
    --steps 500:10 520:10 540:10 --profile 470
```

Watch two numbers: whether the chamber passes 500 at all, and whether duty at the
top is high (power) or idle (ceiling / offset saturation).

`curve_run.py` records `duty`, `pwr` and `soc` on every sample, writes a CSV to
`runs/`, and prints a **plateau diagnosis** at the end:

- **duty ≥ 25 %** while stalled short of target → **power / thermal limit**.
- **duty ≤ 15 %** while stalled → heater idle: **firmware ceiling or offset
  saturation**.
- **15–25 %** → inconclusive, rerun at full charge.

It warns if battery is below 60 %, because a repeat at low charge proves nothing.

> Note for the next session: the duty/pwr instrumentation did not exist when
> this handoff was first written. The original test could not have distinguished
> the two causes — it logged only temperature, and the discriminator is duty
> cycle. Do not remove the duty/pwr columns.

### 2b. ~~Are negative offsets accepted?~~ ANSWERED — yes, and linearly

−5…−40 °C each stored exactly and moved `tcmd` down by 1.8 °F/°C, with 0
returning to baseline. Descent can be commanded. It still cannot be *driven* —
nothing removes heat — so the chamber falls at its own rate and a falling curve
will sit below the truth. The UI should show commanded vs measured on descent
rather than implying the line is followed.

### 2. Is the 1 °F/s follow rate temperature-dependent?

`MAX_FOLLOW_F_PER_SEC = 1.0` in `ui/curve.js` comes from **one** measurement
(+20 °C step at ~490 °F). A curve near 600 °F will follow faster; one at 400 °F
slower. Measure at two temperatures before trusting it.

### 3. ~~What is the duration cap?~~ ANSWERED — 300 s, as a sum of two fields

The user said the app allows 200 s and was **right**, twice over. The budget is
`profile time + timo`: profile carries 120, `timo` adds up to 180, ceiling 300.
Measured on the device's own counter — `120 + 80 → tott 200`, `120 + 180 → 300`,
and a 300 s session was still live at 81 s. `timo` is the app's "extra time"
boost and only applies on a live cycle.

My 60 was an idle-write artefact; my 120 was reading one half of a sum and
calling it the ceiling. `SESSION_LIFE_S` is 300, split into
`SESSION_PROFILE_MAX_S`/`TIMO_MAX_S`, and `start_session()` writes both.

### 3b. Original framing (superseded)

The profile time field clamps at 120 and the active phase comes out ~60. But the
device reports firmware **`AW`** while the app's own `MAX_FIRMWARE_SUPPORTED` is
**`AJ`** (`AW` = 49, `AJ` = 36 by the bundle's own base-26 comparison) — the app
is *older* than the unit. 120 may be an app-era limit exactly like the 20 °C
offset clamp was.

Test: write `hc/N/time` **during an active session**, not while idle, and watch
`stat/tott`. Our idle-only clamp test would not have seen an active-phase path.
The app never writes `time` at idle either — it writes `/p/app/timo`.

### 4. Undecoded log records

Audit types 14–21 and fault types 15/17 appear in bulk on this firmware and do
not match the published tables. A clean cycle emits one type 15 and one type 16
with **no** fault entries, so they are lifecycle records, not failures. Their
layouts are in `protocol/PROTOCOL.md` §8 if anyone wants to finish them.

## Architecture

```
ui/proto/lorax.js   framing, codecs, auth, serialised command queue
ui/device.js        semantic API over the Lorax path map
ui/curve.js         curve eval, plan builder, safety envelope, runner
ui/ble.js           Web Bluetooth transport + bridge transport
ui/app.html/.css/.js   five tabs, charts, wiring
ui/fake_lorax.js    simulated device (auth gate + thermal lag)
tools/probe.py      terminal diagnostic — the thing that actually works
tools/curve_run.py  closed-loop curve runner (warms first, then holds)
tools/plot_run.py   renders a run CSV to a standalone SVG
tools/liveplot.py   live browser graph, fed by whichever tool holds the link
tools/duration_test.py  settles the session budget
tools/offset_test.py    settles negative-offset support
tools/bridge.py     BLE ⇄ WebSocket bridge for the browser UI
```

### Why the bridge exists

**Web Bluetooth does not work on Linux.** Chromium's `requestDevice()` never
resolves — it logs *"Web Bluetooth is experimental on this platform"* and hangs.
There is no device chooser. Brave removes the API entirely with no flag to
restore it.

So `tools/bridge.py` owns the BLE link and forwards bytes over a WebSocket;
`ui/ble.js` speaks the same transport interface either way. The protocol layer
and the UI are identical in both modes.

```bash
# terminal only (most reliable)
.venv/bin/python tools/probe.py --addr AA:BB:CC:DD:EE:FF
.venv/bin/python tools/probe.py --addr AA:BB:CC:DD:EE:FF --live
.venv/bin/python tools/curve_run.py --addr AA:BB:CC:DD:EE:FF --steps 480:15 490:10 500:8 --profile 455

# browser UI via bridge
.venv/bin/python tools/bridge.py --addr AA:BB:CC:DD:EE:FF --idle-timeout 30 &
python3 -m http.server 8791 --bind 127.0.0.1 --directory ui &
~/.local/opt/node/bin/node open-app.mjs      # opens app.html?bridge=1
```

### Driving the ladder

Each rung is now set through **`/p/app/thc/temp`** — the live profile field — so
the setpoint is written directly instead of being reached by walking an offset.
The offset integrator is kept only as small trim.

This is the difference between editing the shelf and editing the running cycle.
Verified: writing `thc/temp` mid-session moved `tcmd` 255 → 195 °C immediately
while the stored `hc/0/temp` stayed put.

### The ladder pattern

Steps may be relative, stacking on the previous target:

```bash
.venv/bin/python tools/curve_run.py --addr AA:BB:CC:DD:EE:FF \
    --profile 470 --steps 470:15 +10:15 +10:10
```

That is 470 for 15 s, 480 for 15 s, 490 for 10 s — hold at the profile, then two
10 °F rises. Set `--profile` to the start of the ladder so the first rung needs no
offset at all.

### Watching a run live

A Peak takes one connection, so the graph is not its own client — the running
tool feeds it. Every test tool opens it **by default**: `curve_run.py`,
`duration_test.py` and `offset_test.py` launch `http://127.0.0.1:8792/` in the
operator's browser and draw chamber, coil target, requested target and duty
against a rolling window, with battery and state in the header. `--no-live`
suppresses it. It reports `tool stopped` when the feed ends so a dead run does
not look like a flat one.

## Safety envelope (enforced in code, tested)

| Rule | Why |
|---|---|
| Offset clamped −45 … +85 °C | device accepts ≥80 °C up and ≥40 °C **down**, all linear; the app's 0…20 is only its boost UI |
| Temperature clamped 400–644 °F | the official app's constants |
| Slew ≤ 3 °C/s | a step should not shock the control loop |
| Never write outside a heat cycle | the device has no reason to honour it |
| Never write on a stale link (> 4 s) | and never clear the offset there either |
| Write 0 on stop | so the device falls back to its profile temperature |
| Never write `/p/htr/tcmd` | it is a reported value, not a control surface |

Heater tuning (`/p/htr/tun/*`, PID) and factory reset are readable but
deliberately not exposed. A wrong PID coefficient is a safety issue.

## Tests

```bash
node ui/test_curve.mjs           # 35
node ui/test_lorax.mjs          # 20
.venv/bin/python tools/test_curve_run.py   # 14  (plateau diagnosis, no hardware)
node ui/e2e.mjs                  # 45  (needs the server on 8791)
```

Run them all; the counts move as tests are added. `e2e.mjs` and `shots.mjs` need a `playwright` package or
`CHROME_PATH`; they resolve Chromium from `CHROME_PATH` → bundled → any install.

`test_curve_run.py` pins the plateau rule against the historical observation
(488 °F at 12 % duty must read as a firmware ceiling) so the verdict cannot
silently drift.

## Battery work done

| | Before | After |
|---|---|---|
| Idle polling | 4 reads/s | **0.8 reads/s** |
| Session polling | ~16 reads/s | **10 reads/s** |
| Backgrounded tab | kept polling | **0 reads/s** |
| Link with no page | held forever | **released after 30 s** |

`statusFast()` reads only what the graph draws; `statusSlow()` handles battery,
counters and heater telemetry on a 5 s tick; polling stops entirely when
`document.hidden`.

### Making a charge go further

Ranked, largest effect first:

1. **Test on the charger.** The heater draws 34–40 W and swamps everything 
   software does. `curve_run.py` skips its battery guard while charging.
2. **Test low.** Power falls steeply with temperature — a 400–430 °F run costs a
   fraction of a 480 °F one and still exercises the loop.
3. **Shorter holds, fewer restarts.** Every session start re-heats from wherever
   the chamber fell to.
4. **Avoid overshoot.** Overshoot is heat paid for and then waited off; the
   settle-wait before a hold exists partly for this.
5. **Poll less.** Real but small — ~10 Hz to the link against a 35 W heater.

`msoc` (`/u/bat/msoc`) is the charge ceiling: 80 enables the app's "battery
preservation" (charges to 80 %, better longevity); 100 is maximum runtime and is
what this unit is set to. `minWattSteadyStateFraction` (`/p/htr/tun/msf`) is the
only firmware-side power floor worth trying, reachable only through the NVM
window and untested.

**Honest limit: the heater is 34–40 W and dominates.** A minute of heating costs
more than hours of polling. This is the software's share, not the battery's fate.

## Gotchas for the next session

- **A Peak accepts one BLE connection.** Two clients (a bridge and a test script)
  will interleave and produce garbage. Kill one before starting the other.
- **BlueZ caches devices**, so `bluetoothctl scan` prints no `NEW` line for a
  known device — look for `RSSI`/`ManufacturerData` change lines instead.
- **`bluetoothctl` can leave `Discovering: yes` stuck** after a killed process,
  which blocks everything. Fix: `bluetoothctl power off; sleep 2; bluetoothctl power on`.
- **bleak's scanner returned 0 devices** on this machine while `bluetoothctl`
  saw the Peak clearly. Connect by MAC via the BlueZ object path instead:
  `/org/bluez/hci0/dev_F0_AD_4E_41_5B_76`.
- **bleak 3.x removed `get_services()`.** Calling it raised AttributeError which
  a retry path read as a dropped link, causing a 12-reconnect loop.
- The device sleeps on a flat battery and stops responding until it has charge.

## Deliberately not done

- **Public hosting.** The user asked for private. Pages is unavailable for
  private repos on the free plan, so there is no URL. If a phone link is wanted,
  the options are a tunnel (page reachable, repo private) or making the repo
  public — a decision the user has not made.
- **Flat GATT protocol.** Not needed for this unit; it speaks Lorax.
- **Firmware update.** The Silabs OTA service is read once to trigger bonding,
  never written.
- **Login / account / social / shop.** Cloud-only, none of it reachable over BLE.
