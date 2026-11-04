# Plan — with confidence

Last updated 2026-11-03. Confidence is 0–100 and means *"how sure am I that this
area's stated model is correct"*, not *"how much is written"*. Low numbers are
work items, not failures.

Read with `protocol/PROTOCOL.md` §5–§10 (the decode) and `HANDOFF.md`.

---

## Where things stand, flat

The protocol is decoded, the control model is understood, and as of 2026-11-03
the software now implements it. `buildPlan` converts a chamber target into a
compensated coil delta (`(chamber + gap − profile − bias) / 1.8`), warns
`unreachable-target` when the offset ceiling genuinely cannot get there, splits
anything longer than a session budget, and the runner carries the same model with
a rate-limited feed-forward and reconnect-and-resume.

Phase 1 is done. The next work is hardware.

---

## Confidence by area

| # | Area | Conf. | Basis | What raises it |
|---|---|---|---|---|
| 1 | Framing, auth, codecs, queue | **92** | 20 protocol tests, real handshake on hardware, long run history | edge cases only |
| 2 | Path map, register table, types | **95** | read straight out of the bundle; wire types per field | device-side type confirmations |
| 3 | Enums (state, mode, chamber, log, vapour, version gate) | **93** | decoded from enum bodies in Puffco's code | — |
| 4 | Session lifecycle (`hcs` → `mc 7`, abort `8`→`2`) | **90** | literal call order in `startDabbing`/`stopDabbing` | none needed |
| 5 | `tmpo`/`timo` are °C **increments**, session-scoped | **85** | `convertTempIncrement` call sites + idle-vs-session behaviour measured | a negative-increment test |
| 6 | Coil/chamber gradient ≈ 38 °F | **72** | reproduced at 5 settle levels (27/31/30/31/45 °F), two controllers, one unit | second unit, or a 3-point re-measure |
| 7 | Offset honoured to ≥ 80 °C, 1.8 °F/°C linear | **88** | 25/30/40/60/80 all read back exact and moved `tcmd` exactly | test 85, 100, find the real ceiling |
| 8 | Gradient-compensated loop holds a target | **65** | held 540.8 °F after settling; one run, one target, ±8 °F overshoot | repeated holds at 480/540/600 |
| 9 | Session ceiling is 300 (120 profile + 180 timo) | **88** | 4 composition points read off `tott`, 300 s session still live at 81 s | a full 300 s run to completion |
| 10 | Profile field caps at 120, timo at 180 | **92** | direct sweeps both fields, both clamped consistently | — |
| 11 | Negative offset accepted | **95** | −5…−40 all stored and moved tcmd at 1.8 °F/°C, +5 control, 0 returned exactly | — |
| 12 | PID / safety constants (`tun/*`) readable & writable | **35** | paths exist in the map; plain short reads fail; NVM route unproven | NVM window experiment |
| 13 | Log format, documented codes (0–13) | **85** | byte offsets + dividers from the decoder | — |
| 14 | Log types 14–21 and fault 15/17 | **20** | observed in bulk, layouts do not match the tables | controlled events + diffing |
| 15 | `heatCycleBoost` mode 9 does anything | **25** | defined in the enum, zero call sites | one mode-9 write during a session |
| 16 | `hc/%N/thrt` semantics | **15** | path mapped and typed FLOAT, never used by the app | sweep it and watch the loop |
| 17 | `ui/curve.js` planner correctness | **85** | gap/bias compensated, unreachable-target warns, session split, 7 new tests | a real curve run end to end |
| 18 | `tools/curve_run.py` controller | **70** | same model, 6 °C/tick rate limit, retry + resume; offline sim converges in 8 ticks with no overshoot | one live run confirming it on hardware |
| 19 | Link robustness | **55** | supervisor retries and resumes; never exercised against a real drop | force a drop and confirm it resumes |
| 20 | Battery reality (heater dominates) | **90** | measured; ~12 % consumed per short run | — |
| 21 | Privacy / hosting posture | **95** | private repo verified 404, Pages unavailable, documented | user decision only |

---

## Sequence

**Phase 1 — DONE 2026-11-03**

1. ~~**Make `buildPlan` use the model.**~~ Delta becomes
   `(chamberF + GAP − profileF − BIAS) / 1.8`, clamped to `DELTA_LIMITS_C`.
   Emit a warning when `profileF` is too high for the requested target instead of
   silently clamping. Tests: a 540 °F plan off a 470 °F profile must produce the
   compensated delta, and an unreachable plan must warn.
2. ~~**Same model in `curve_run.py`**, with `gap`/`bias` as arguments rather than
   buried constants, plus reconnect-and-resume so a dropped link doesn't burn
   the run.~~
3. ~~Adopt `SESSION_LIFE_S` in the planner: split anything longer than the budget
   into segments with a session restart between, rather than planning one long
   session that cannot finish.~~

**Phase 2 — one charged session, cheapest decisive tests**

4. ~~**Duration, active-session**~~ **DONE 2026-11-03 — you were right about 200.** The budget is `profile time + timo` (120 + 180 = 300). `120+80` produced a `tott` of 200 and `120+180` produced 300; a 300 s session was still live at 81 s. 60 was an idle-write artefact, and 120 was one half of a sum. `SESSION_LIFE_S` is 300 and `start_session()` writes profile + timo. Harness:
   `tools/duration_test.py` starts the cycle, waits for state 8, *then* writes 200
   and watches `tott` until the session ends or 215 s pass. It prints a verdict
   and an instruction for what to change. `--idle-control` also reproduces the old
   idle-write clamp for contrast, so the comparison is in one artefact.

   ```bash
   .venv/bin/python tools/duration_test.py --addr AA:BB:CC:DD:EE:FF --idle-control
   ```
5. ~~**Negative offset**~~ **DONE 2026-11-03 — accepted and linear.** `DELTA_LIMITS_C.min` is −45 and the runner's floor matches. What remains is display honesty on descent, since the chamber still falls passively. Harness kept: `tools/offset_test.py` steps
   −5/−10/−20/−30/−40 then +5 as a control, and judges both storage *and*
   whether `tcmd` moves, because a stored negative that the loop ignores is not
   usable. It also reports how far each step sits from the expected 1.8 °F/°C,
   so a partial answer is visible rather than rounded to pass/fail.

   ```bash
   .venv/bin/python tools/offset_test.py --addr AA:BB:CC:DD:EE:FF
   ```

   (Every test tool opens the live graph by default; `--no-live` suppresses it.)

   A pass lets `ui/curve.js` take a negative source minimum and drop the
   decay caveat; a fail keeps the 0 floor and the passive-descent language.
6. **Ceiling** (area 7): push 85, 100 and find where it stops being linear.

**Phase 3 — decode the rest**

7. `thrt` sweep (area 16) — one session, small deltas, watch for any loop change.
8. Mode 9 during a session (area 15).
9. Type 15/17 layouts (area 14) — controlled start/finish/abort events, snapshot
   before and after, diff.
10. NVM window (area 12) — read the factory PID/safety values before ever
    writing one.

**Phase 4 — ship**

11. Re-run the full suite including the 45 e2e (needs a server on 8791).
12. Decide the hosting question: private plus tunnel, or public repo.

---

## Phase 2b — boost as the actuator (found 2026-11-04)

The official boost is a **live register pair plus a mode**, not just the tmpo
write we had been using. Decoded from the bundle:

| Path | Type | Meaning |
|---|---|---|
| `/p/app/thc/btmp` | FLOAT | boost increment, **Celsius on the wire** — UI is Fahrenheit 0–36, which is the same 0–20 as tmpo after *5/9 |
| `/p/app/thc/btim` | FLOAT | boost **time, seconds** |
| `/p/app/mc = 9` | u8 | `heatCycleBoost` — the trigger, and the reason mode 9 has no other caller |

`thc` = the live cycle; the same four fields also exist per profile (`hc/%N/*`)
for storage. `writeBoostModeValues` writes the live pair and then broadcasts the
stored value to all four profile slots.

Why this beats streaming `tmpo`:

- it is the **official** mechanism, so the firmware is built to honour it
- **one write plus a mode**, instead of a 10 Hz offset stream that churns the link
- it carries **time and temperature together**, which is exactly what a curve
  segment needs
- probed magnitude may exceed the UI's 20 °C/60 s, the same way `tmpo` exceeded
  its 20 °C UI clamp

**Units:** the boost UI is °F and the register is °C. `10 °F` is **5.56** on the
wire. Never write an F number straight to `btmp`. The 36 °F cap and the 20 °C cap
are one cap; both are UI-side and both were exceeded on `tmpo`.

### What must be established, cheapest first

1. Does `thc/btmp` + mode 9 move `tcmd` at all? (one 20 °C boost)
2. Does it alone move `tcmd`, without mode 9 — and is `btmp` absolute or additive?
3. Does it accept above 20 °C? Sweep 30 / 50 / 80.
4. **Does it stack** across repeated boosts? This is the whole exploit: N presses of
   +36 °F is unbounded if it accumulates.
5. Does `btim` extend a session the way `timo` does, and does it also cap?

### Confidence

paths exist and are typed **95**; the device honours them **40**; stacking
**30**; magnitude above the UI cap **unknown**. Boost may also require the
physical double-click state rather than a bare mode write.

### Design if it holds

Boost becomes the **coarse actuator** (one-shot steps, and it buys time), with
`tmpo` kept as fine trim inside a segment. That removes the streaming write path
from the critical loop, which is also why it is worth the tests.

## Ordering rules

- **Never write a `tun/*` value before reading the factory one through NVM.**
  A wrong PID coefficient is a safety regression.
- **One BLE client at a time.** Kill the bridge before a probe; this bit us.
- **Battery below ~55 % invalidates duration and ceiling tests**, because the
  device starts dying of its own accord.
- **Wake the unit before a run** — it sleeps after a long idle and connect times out.
- **Anything measured on this one unit is provisional.** The 3DXL gradient is a
  property of *this* atomizer and airflow.

## Explicitly not planned

- Firmware update. The OTA surface is decoded, but a bad flash costs a device.
- Flat GATT. This unit speaks Lorax.
- PID tuning beyond reading it. Measuring before writing.
- Cloud features. Unreachable over BLE.

---

## Honest summary

Solid: protocol, paths, enums, lifecycle, logs, the gradient's *existence*.
Weak: the software that is supposed to exploit any of it, the duration numbers,
and everything to do with PID and the newer log records.

The decode moved this from "guess at the device" to "read the device". The
software is still a phase behind — which is why area 17 sits at 35 and is first
in the sequence.
