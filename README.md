# Puffco app — built

A Web Bluetooth controller for the Peak Pro 3DXL V2 (Lorax protocol), with a
temperature-curve engine the official app does not have.

```
ui/app.html      the app
ui/app.css       design language (Geist, ember, 24px cards)
ui/app.js        state, routing, charts, wiring
ui/ble.js        Web Bluetooth transport
ui/proto/lorax.js  protocol: framing, codecs, auth, command queue
ui/device.js     semantic device API over Lorax paths
ui/curve.js      curve engine: evaluation and planning
ui/fake_lorax.js simulated device for testing without hardware
ui/curve-governor.js    host-side curve governor (2 Hz)
ui/curves-data.js       curve presets and interpolation
ui/governor-adapter.js  adapts the app's Device to the governor's client shape
tools/bridge.py         BLE <-> WebSocket bridge (Web Bluetooth does not work on Linux)
tools/snapshot.py       read-only telemetry; safe before, during and after a run
```


## Not included

The 16-byte handshake constant belongs to the vendor and is **not** in this
repository. Supply it at runtime:

```bash
export PEAK_HANDSHAKE_KEY=<base64>          # tools/*.py
echo '<base64>' > tools/handshake.key       # or a gitignored file
```

```html
<script src="handshake.local.js"></script>  <!-- sets window.__PEAK_KEY_LORAX -->
```

Both paths are gitignored. Without a key the device answers with a seed and
refuses every read; nothing here guesses it.

`reference/` — Puffco's decompiled app bundle and the community libraries — is
gitignored and is not part of this repository.

## Run it on your phone

**https://snoozewalknn.github.io/puffco-control-public/ui/app.html**

That is HTTPS, so it loads on any phone. For it to reach your Peak, run this on
the machine that has the Bluetooth radio, on the same Wi-Fi:

```bash
.venv/bin/python tools/tunnel.py --addr <YOUR-PEAK-MAC>
```

Open the URL it prints and add `?bridge=1` — the page then talks to your bridge
instead of the browser's Bluetooth stack. That is what makes it work on Linux,
and on phones that block Web Bluetooth from plain HTTP.

## Run it locally

```bash
python3 -m http.server 8791 --bind 127.0.0.1 --directory ui
# open http://127.0.0.1:8791/app.html
```

Web Bluetooth needs `https://` or `localhost`. **Safari cannot** — use Chrome,
Edge, or Bluefy on iOS. "Try the simulator" works anywhere, including `file://`.

## Where this can run

| Where | Works? | Why |
|---|---|---|
| Desktop Chrome/Edge, `localhost` | yes | `localhost` counts as a secure context |
| Phone over `http://192.168.x.x` | **no** | not a secure context — Web Bluetooth is blocked |
| Phone via a tunnel (`https://…`) | yes | anyone with the URL can *use* the page, so only run it on a network you trust |
| `file://` | simulator only | no secure context, so no Bluetooth |

To use it on the phone, either trust a local certificate or run a tunnel for the
session and stop it afterwards. **The tunnel has no authentication** and proxies
the bridge socket, so it hands full device control to anyone on the network.

## Tests

```bash
node ui/test_curve.mjs     # 39 — curve maths, planning, safety envelope
node ui/test_lorax.mjs     # 17 — framing, auth gate, typed I/O, sequencing
node ui/e2e.mjs            # 48 — real browser: connect → session → curve → abort
node ui/real-smoke.mjs <MAC>   # browser → bridge → device, never heats
node ui/hw-curve.mjs <MAC>     # one curve on hardware, with a verdict
node ui/demo_curve.mjs hill 20   # visual: commanded vs simulated chamber
node ui/shots.mjs          # screenshots into ui/shots/ (server on 8791)
```

`e2e.mjs` and `shots.mjs` need the server running on 8791, and a `playwright`
package (`npm i playwright`, or set `CHROME_PATH` to a Chromium binary).

## Screens

`node ui/shots.mjs` writes connect, heat, curves, profiles, mood, peak and
session into `ui/shots/` (gitignored — regenerate rather than commit).

## What is verified, and what is not

**Verified on hardware** (Peak Pro 3DXL V2, firmware AW): reads, `tcmd` moving
exactly with the live target, session start/stop, profile temp and duration
writes, negative offsets to −40 °C, and a **30 s curve completing in the
browser** — preheat exit at ~17 s, live control held throughout, 13 distinct
`tcmd` values, profile restored afterwards.

**Still open:** the coil-to-chamber gradient is measured, not modelled. The
chamber settles 24–38 °F under `tcmd`, and that figure drifts with temperature,
so a curve tracks a little low at the top of its range. `COIL_CHAMBER_GAP_F` is
a single number; a per-unit calibration is the honest fix.

## The curve engine

Puffco firmware has no curve mode. It has a live setpoint **offset**:

```
/p/app/tmpo = float32 Celsius, added to the active profile temperature
```

The official app's boost button proves the semantics:
`currentTarget − profileBaseTemp + boostDelta`. So a curve is executed by the
host: evaluate once a second, subtract the profile temperature, clamp, write.

Safety envelope, all enforced and tested:

| | |
|---|---|
| Temperature range | 400–644 °F (the official app's own constants) |
| Offset range | 0 … +20 °C (36 °F) — the range their UI exercises |
| Slew | ≤ 3 °C/s, so a step never shocks the loop |
| Outside a heat cycle | never writes |
| Stale link (> 5 s) | never writes, and never clears |
| On stop | writes 0 so the device falls back to its profile temperature |

**The offset is verified on hardware** (Peak Pro 3DXL V2, firmware AW): writing
10 °C moved the device's own target from 501 °F to 519 °F, 20 °C to 537 °F, and
0 °C returned it to 501 °F exactly.

**Thermal lag is the real constraint, not the offset.** A +20 °C step moved the
chamber about 8 °F in 2.5 s. The command lands instantly; the chamber takes
seconds. So the session chart draws two lines — the device's own target sampled
from `/p/htr/tcmd`, and the measured chamber — with a live lag figure between
them. A curve steeper than about 1 °F/s is flagged as too steep to follow,
because that is what the hardware showed.

**Every template starts at or above the profile temperature.** The offset is
0 … +20 °C, so nothing can be commanded below the profile. The `valley` shape
was removed rather than shipped as a curve the device could never run.

## What it does that the official app does not

| | |
|---|---|
| Live chamber graph with history | the app shows a number, not a trace |
| Temperature curves | no equivalent exists |
| Heater power, duty, coil Ω | `/p/htr/pwr`, `/p/htr/duty`, `/p/htr/res` — read by the app, never shown |
| Trip counters, dabs remaining | `/p/app/odom/1/*`, `/p/app/info/drem` |
| Curve warning before you run | cooling and offset limits, computed |
| Works offline | no account, no cloud |

Dropped from the official app: login, account, social, shop, warranty — all
cloud-only, none of it reachable over BLE.

## Deliberately not exposed

- **Heater tuning** (`/p/htr/tun/*`, PID coefficients) — a wrong value changes
  how the chamber heats. That is a safety issue, not a preference.
- **Factory reset** (`/p/app/facr`) — one mistap from a wiped device.
- **OTA** — the Silabs service is read once to trigger bonding, never written.


## Battery

Measured, not assumed.

| What | Before | After |
|---|---|---|
| Idle polling | 4 reads/s | **0.8 reads/s** |
| Session polling | ~16 reads/s | **10 reads/s** |
| Backgrounded tab | kept polling | **0 reads/s** |
| BLE link when no page is open | held forever | **released after 30 s** |

The last row is the one that matters. Measured on hardware: with the link held
open, charge rose 0.5 % in 36 s; with it down, 1.0 % over the same period. A
live BLE connection roughly halves the charge rate.

What none of this fixes: **the heater is the drain.** A session draws 34–40 W.
A minute of heating costs more than hours of polling. No amount of software
tuning changes that — it is the device doing its job.

Practical rules:

- `tools/bridge.py --idle-timeout 30` releases the link when nothing is reading.
- The app stops polling entirely when its tab is hidden.
- Close the app (or let the bridge time out) before putting the Peak on the
  charger; it charges noticeably faster.

## Licence

MIT. Unofficial; not affiliated with Puffco.
