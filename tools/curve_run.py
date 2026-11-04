#!/usr/bin/env python3
"""Closed-loop curve runner.

Open-loop (write an offset, assume the chamber follows) does not work: the
chamber takes tens of seconds to respond, the device aims above the profile
temperature, and every unit differs. So this measures the chamber and corrects.

Two things it does that a plain timer does not:

  1. **Waits for the first target before starting the clock.** A 33 s curve that
     begins at 98 °F spends all 33 s climbing and never holds anything.

  2. **Corrects continuously.** The offset is adjusted from the measured error
     rather than computed once, so the chamber converges on each step and stays
     there.

    .venv/bin/python tools/curve_run.py --addr F0:... \\
        --steps 480:15 490:10 500:8 --profile 455

Every step is (temperature °F : seconds to hold). The profile is set below the
lowest step, because the offset can only add.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import struct
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from bleak import BleakClient
from bleak.exc import BleakError
from bleak.backends.device import BLEDevice

from probe import Lorax, P, c_to_f, f_to_c
from liveplot import LivePlot

F_PER_C = 1.8

# Coil/chamber model, measured 2026-11-03 on firmware AW.
#
# `/p/htr/tcmd` is the COIL setpoint, not the chamber. The chamber settles
# CHAMBER_GAP_F below it, and the firmware aims PROFILE_BIAS_F above the stored
# profile entirely on its own. Commanding `target` as if it were a chamber
# temperature undershoots by GAP - BIAS every tick, which is what produced the
# original "stops at 488 °F".
CHAMBER_GAP_F = 22.0   # low-band figure; the true gap shrinks with temperature
PROFILE_BIAS_F = 21.0

# Offset ceiling. The device accepts far more than the app's 20 °C boost UI —
# 80 °C was verified linear and exact. 85 keeps a step past the verified value.
MAX_OFFSET_C = 85.0
# Negative offsets are honoured too and linear at the same 1.8 °F/°C (-5…-40 all
# verified, 0 returns exactly). They do not cool the chamber — nothing can — but
# they let the loop stop driving on a falling segment instead of the runner
# pretending it is still climbing.
MIN_OFFSET_C = -60.0

# Controller gains. The chamber lags the coil by 5-10 s, so a plain integrator
# oscillates: it keeps pushing while the error is already closing, overshoots,
# then reverses and overshoots the other way. Measured drift of -34 then +33 F
# across consecutive rungs. PD-style damping stops the correction when the error
# is closing on its own; a slower loop does the rest.
KP = 0.22          # °C of coil per °F of error
KD = 0.55          # how much closing rate to discount (0 = pure integral)
MAX_OFFSET_STEP_C = 2.5

# Most the offset may move in one tick. The feed-forward term alone wants to jump
# 60+ °C when a step is far away, and the heater cannot absorb that in 0.6 s.
MAX_OFFSET_STEP_C = 4.0
# How close the chamber has to be before a hold is considered to have started.
SETTLE_F = 6.0


async def rf(lx: Lorax, path: str) -> float | None:
    try:
        raw = await lx.read_raw(path)
        return struct.unpack("<f", raw[:4])[0] if len(raw) >= 4 else None
    except Exception:
        return None


async def ru8(lx: Lorax, path: str) -> int | None:
    try:
        raw = await lx.read_raw(path)
        return raw[0] if raw else None
    except Exception:
        return None


async def charging(lx: Lorax) -> bool:
    """Is the unit on the charger? chg_stat/chg_src are 0 while charging on
    firmware AW, so trust current draw and a rising SoC instead."""
    cur = await rf(lx, P["bat_curr"])
    if cur is not None and cur > 0.12:
        return True
    # A very flat pack trickles: current reads 0 but SoC still creeps, so give
    # the slope a longer window before calling it not-charging.
    a = await rf(lx, P["soc"])
    await asyncio.sleep(8.0)
    b = await rf(lx, P["soc"])
    return a is not None and b is not None and b > a + 0.015


async def set_live_target(lx: Lorax, target_f: float) -> None:
    """Set the running session's temperature directly.

    `/p/app/thc/temp` is the LIVE profile field — not the stored one under
    `hc/%N/`. Writing it retargets an active session immediately (verified
    2026-11-04: tcmd 255 -> 195 C, live). This replaces the offset integrator as
    the primary actuator: there is no gap or bias to compensate because we are
    writing the setpoint itself.
    """
    await wf(lx, P["thc_temp"], f_to_c(target_f))


async def boost(lx: Lorax, deg_f: float) -> None:
    """One-shot upward step. Write the live increment, then trigger mode 9.

    `btmp` alone is inert; without the trigger it does nothing. The value is
    additive and magnitude-only: measured, four +10 F presses took tcmd 491 ->
    531 one rung at a time, and a negative value still climbs. So this is only
    ever used for rises — descents go through the offset, which is signed.
    """
    await wf(lx, "/p/app/thc/btmp", deg_f / F_PER_C)
    await asyncio.sleep(0.35)
    await lx.write_u8(P["mode"], 9)
    await asyncio.sleep(0.9)


async def wf(lx: Lorax, path: str, value: float) -> None:
    await lx.write_raw(path, struct.pack("<f", value))


async def run_attempt(addr: str, steps: list[tuple[float, float]], profile_f: float | None,
                      slot: int, timeout_s: float, first_step: int = 0,
                      live: bool = True, min_soc: float = 0.0,
                      max_temp: float = 999.0, use_boost: bool = True) -> int:
    path = f"/org/bluez/hci0/dev_{addr.replace(':', '_').upper()}"
    device = BLEDevice(addr, "Peak Pro", {"path": path, "props": {}})

    async with BleakClient(device, timeout=25.0) as client:
        lx = Lorax(client, device=None)
        await lx.start()
        print("auth:", await lx.authenticate())

        bt = await rf(lx, P["bat_temp"])
        if bt is not None and bt > max_temp:
            print(f"battery is {bt:.1f} C, above {max_temp:.0f} C — the pack throttles "
                  f"charge when hot, so heating now starves it")
            print("  let it cool with the link dropped, then run (temp is in /p/bat/temp)")
            return -1

        if min_soc > 0:
            soc0 = await rf(lx, P["soc"])
            # Heating off the charger is the single biggest endurance win, so a
            # charging unit is never refused for low charge.
            # chg_stat and chg_src both read 0 while charging on this firmware, so
            # detect it from charge current and a rising state of charge instead.
            chg = await charging(lx)
            if soc0 is not None and soc0 < min_soc and not chg:
                cur = await rf(lx, P["bat_curr"])
                print(f"battery {soc0:.1f}% is below {min_soc:.0f}% and not charging "
                      f"(current {cur if cur is not None else 'n/a'} A)")
                print("  plugged in but flat current means the supply is not reaching "
                      "the unit — check the adapter, cable and port")
                print("  --force runs anyway, at the cost of a result you cannot trust")
                return -1
            if chg:
                print(f"battery {soc0:.1f}% but charging — running anyway")
        original_profile = await rf(lx, f"/u/app/hc/{slot}/temp")
        original_time = await rf(lx, f"/u/app/hc/{slot}/time")

        lowest = min(t for t, _ in steps)
        highest = max(t for t, _ in steps)
        total_hold = sum(s for _, s in steps)

        # The offset can only add, and the device aims above the profile, so the
        # profile has to sit below the lowest step or that step is unreachable.
        if profile_f is None:
            profile_f = lowest - 25.0
        print(f"profile {profile_f:.0f} °F (steps span {lowest:.0f}-{highest:.0f} °F)")

        try:
            await wf(lx, f"/u/app/hc/{slot}/temp", f_to_c(profile_f))
            await wf(lx, f"/u/app/hc/{slot}/time", MAX_SESSION_S)
            await asyncio.sleep(0.3)
            print(f"slot {slot} set to {c_to_f(await rf(lx, f'/u/app/hc/{slot}/temp') or 0):.0f} °F")

            if not await start_session(lx, slot, total_hold + timeout_s + 30.0):
                print("session did not start")
                return 1
            print("session running, duration re-armed")

            reached = await execute(lx, steps, total_hold, timeout_s, first_step, live, use_boost)

        finally:
            # Always leave the device idle and the profile as it was found.
            try:
                await wf(lx, P["override"], 0.0)
                await wf(lx, P["time_offset"], 0.0)
                await lx.write_u8(P["mode"], 8)
                await asyncio.sleep(0.2)
                await lx.write_u8(P["mode"], 2)
            except Exception:
                pass
            try:
                if original_profile is not None:
                    await wf(lx, f"/u/app/hc/{slot}/temp", original_profile)
                if original_time is not None:
                    await wf(lx, f"/u/app/hc/{slot}/time", original_time)
                print(f"profile restored to {c_to_f(original_profile or 0):.0f} °F")
            except Exception:
                pass

    return reached


# The profile time field accepts at most this and rejects more by keeping the old
# value. Measured on firmware AW: 121-240 all read back 120, so 200 is not
# reachable through this field even though newer builds may allow it.
#
# It is also order-sensitive. Written while idle the device stores 120 but then
# only grants 60 — `stat/tott` settles at 60 and the session dies at 64-67 s.
# Written again once the cycle is live it grants the full 120 and the session
# runs 120.4 s. So the write below happens *after* the session starts, and the
# warm-up restart budget is set from that.
PROFILE_TIME_MAX_S = 120.0     # what the profile field will store
TIMO_MAX_S = 180.0             # what the time override can add on top
MAX_SESSION_S = PROFILE_TIME_MAX_S + TIMO_MAX_S   # 300, the real budget


def timo_for(seconds: float) -> float:
    """Seconds of `timo` needed for a session of `seconds` beyond the profile."""
    return max(0.0, min(TIMO_MAX_S, seconds - PROFILE_TIME_MAX_S))


async def start_session(lx: Lorax, slot: int, want_s: float = 0.0) -> bool:
    """Start a heat cycle and re-arm its duration.

    The duration write belongs here and not at setup time: written while idle the
    device stores 120 but only grants 60 (measured 2026-11-03). Written once the
    cycle is live it grants the full 120.
    """
    await lx.write_u8(P["mode"], 7)
    for _ in range(180):
        await asyncio.sleep(0.5)
        if await ru8(lx, P["state"]) in (7, 8):
            try:
                await wf(lx, f"/u/app/hc/{slot}/time", min(PROFILE_TIME_MAX_S, max(want_s, 1.0)))
                # Beyond the profile cap the budget comes from timo, live only.
                extra = timo_for(want_s)
                if extra > 0:
                    await wf(lx, P["time_offset"], extra)
                    print(f"  session budget {want_s:.0f}s: profile "
                          f"{min(PROFILE_TIME_MAX_S, max(want_s, 1.0)):.0f}s + timo {extra:.0f}s")
            except Exception:
                pass
            return True
    return False


async def end_session(lx: Lorax) -> None:
    try:
        await wf(lx, P["override"], 0.0)
        await wf(lx, P["time_offset"], 0.0)
        await lx.write_u8(P["mode"], 8)
        await asyncio.sleep(0.25)
        await lx.write_u8(P["mode"], 2)
        await asyncio.sleep(0.3)
    except Exception:
        pass


async def execute(lx: Lorax, steps: list[tuple[float, float]], total_hold: float,
                  timeout_s: float, first_step: int = 0, live: bool = True,
                  use_boost: bool = True) -> int:
    """Drive the chamber through the steps, correcting from measurement."""
    first_target = steps[0][0]

    # Battery is the leading hypothesis for the ~488 °F plateau, so record it.
    # Without this the run cannot show whether the unit was even charged.
    soc_start = await rf(lx, P["soc"])
    if soc_start is not None:
        warn = "  <-- LOW: the plateau test is not valid at this charge" if soc_start < 60 else ""
        print(f"\nbattery at start: {soc_start:.1f}%{warn}")

    # ---- warm-up: no clock, no curve, just get to the first target ----------
    print(f"\nwarming to {first_target:.0f} °F (rate-limited, clock starts when it gets there)…")
    offset_c = 0.0
    warm_start = time.time()
    last_print = 0.0

    while time.time() - warm_start < timeout_s:
        # A session dies at 120 s. Restarting keeps the chamber hot and resets
        # the clock, which is the only way to warm up and still have a full
        # session left for the curve.
        if time.time() - warm_start > MAX_SESSION_S - 30:
            print(f"  session nearing its {MAX_SESSION_S:.0f} s limit — restarting")
            await end_session(lx)
            if not await start_session(lx, 0, total_hold + 20.0):
                print("  could not restart the session")
                return step_i
            warm_start = time.time()
            offset_c = 0.0

        chamber = await rf(lx, P["temp"])
        if chamber is None:
            await asyncio.sleep(0.5)
            continue
        cf = c_to_f(chamber)
        err = first_target - cf

        # Break EARLY, ~25 F short. The offset is still high when the chamber is
        # already at target, so the leftover heat carries it 30-40 F past. Coast
        # the last stretch in with the offset at zero instead.
        if cf >= first_target - 25:
            print(f"  at {cf:.0f} °F after {time.time() - warm_start:.0f} s — coasting in")
            break

        # Same rate-limited integrator as the curve. Uncapped, a 400 F error
        # pinned the offset at the ceiling for the whole climb and arrived 40 F
        # over, which the hold then spent unwinding.
        step_c = max(-MAX_OFFSET_STEP_C, min(MAX_OFFSET_STEP_C, KP * err * 0.6))
        offset_c = max(MIN_OFFSET_C, min(MAX_OFFSET_C, offset_c + step_c))
        # Warm up on the live setpoint, not the offset: absolute, no bias term.
        await set_live_target(lx, min(first_target, cf + 40.0))
        await wf(lx, P["override"], offset_c)

        if time.time() - last_print > 3:
            last_print = time.time()
            print(f"  {cf:5.0f} °F  err {err:+5.0f}  offset {offset_c:5.1f} C")
        await asyncio.sleep(0.6)
    else:
        print(f"  did not reach {first_target:.0f} °F within {timeout_s:.0f} s — running anyway")

    # ---- carry straight on in the SAME session -----------------------------
    # This used to end the warm-up session and start a fresh one, which lost the
    # warm-up: the chamber coasted 15-20 F hot while the new session came up, and
    # the first hold was spent unwinding that rather than following the line.
    # With a 300 s budget there is no need to restart at all — the warm-up and
    # the curve now share one session, so the chamber arrives already settled.
    print("  continuing in the same session")

    # The warm-up drove the offset to its ceiling. Drop it and let the chamber
    # settle onto the first target before the hold clock starts, otherwise the
    # curve opens pinned at maximum and overshoots.
    first = steps[0][0] if steps else None
    await wf(lx, P["override"], 0.0)
    if first is not None:
        best = None
        for _ in range(200):
            ch = await rf(lx, P["temp"])
            if ch is None:
                await asyncio.sleep(0.5)
                continue
            cf = c_to_f(ch)
            if best is None or abs(first - cf) < best:
                best = abs(first - cf)
            if abs(first - cf) <= SETTLE_F:
                break
            await asyncio.sleep(0.5)
        print(f"starting curve at {c_to_f(await rf(lx, P['temp']) or 0):.0f} °F")

    # ---- the curve: hold each step, correcting continuously ----------------
    # duty/pwr are the discriminators for the plateau question: a unit that is
    # power-limited drives the heater hard and still cannot climb, while a unit
    # that has hit a firmware ceiling stops driving and the chamber sits there.
    print(f"\n{'t':>6} {'target':>7} {'chamber':>8} {'err':>6} {'offset':>7} "
          f"{'tcmd':>6} {'duty':>6} {'pwr':>6}")
    t0 = time.time()
    offset_c = await rf(lx, P["override"]) or 0.0
    # Baseline coil target with the offset cleared — everything else is relative.
    await wf(lx, P["override"], 0.0)
    await asyncio.sleep(0.2)
    base_tcmd_c = await rf(lx, P["tcmd"])
    base_tcmd_f = c_to_f(base_tcmd_c) if base_tcmd_c is not None else 0.0
    print(f"baseline tcmd {base_tcmd_f:.0f} °F; coil model gap {CHAMBER_GAP_F:.0f} °F, "
          f"profile bias {PROFILE_BIAS_F:.0f} °F")
    offset_c = 0.0
    rows: list[tuple[float, float, float, float | None, float | None]] = []
    prev_cf = None
    prev_t = time.time()
    step_i = first_step
    step_start = time.time()

    # Runs cost battery and heat, and the numbers matter more than scrollback,
    # so persist every sample next to the tool.
    run_dir = Path(__file__).resolve().parent.parent / "runs"
    run_dir.mkdir(exist_ok=True)
    csv_path = run_dir / f"curve-{time.strftime('%Y%m%d-%H%M%S')}.csv"
    csv_f = csv_path.open("w", newline="")
    csv_w = csv.writer(csv_f)
    csv_w.writerow(["t", "target_f", "chamber_f", "err_f", "offset_c",
                    "tcmd_f", "duty_pct", "pwr_w", "soc_pct"])
    print(f"logging to {csv_path}")
    graph = LivePlot().start() if live else None

    while True:
        elapsed = time.time() - t0
        if step_i >= len(steps):
            break
        target, hold = steps[step_i]

        # advance when this step's hold has elapsed
        if time.time() - step_start >= hold:
            prev_target = steps[step_i][0]
            step_i += 1
            step_start = time.time()
            # Rising steps are one boost write instead of an integrator walk;
            # the trim loop below still corrects whatever the jump lands on.
            if use_boost and step_i < len(steps):
                rise = steps[step_i][0] - prev_target
                if rise > 0:
                    try:
                        await boost(lx, rise)
                    except Exception:
                        pass
            continue

        chamber = await rf(lx, P["temp"])
        tcmd = await rf(lx, "/p/htr/tcmd")
        duty = await rf(lx, P["duty"])
        pwr = await rf(lx, P["power"])
        if chamber is None:
            await asyncio.sleep(0.4)
            continue

        now = time.time()
        cf = c_to_f(chamber)
        err = target - cf
        # Each tick re-asserts the live setpoint. Cheap, absolute, and it removes
        # the integrator's chance to walk the target around.
        await set_live_target(lx, target)
        # Damped integral on the measured chamber error. No predicted gap:
        # the integrator finds whatever coil surplus this atomizer and airflow
        # need, at whatever temperature it is, without a constant to be wrong.
        # An earlier version fed the gap forward and overshot by 25 F because the
        # gap moves with temperature.
        # Discount the correction while the error is already closing, using the
        # measured rate of change rather than trusting the setpoint alone.
        rate = 0.0 if prev_cf is None else (cf - prev_cf) / max(now - prev_t, 1e-3)
        prev_cf, prev_t = cf, now
        closing = max(min(rate / 8.0, 1.0), -1.0)      # +1 = at 8 F/s
        step_c = KP * 0.35 * (err - KD * 8.0 * closing) * 0.6
        step_c = max(-MAX_OFFSET_STEP_C, min(MAX_OFFSET_STEP_C, step_c))
        offset_c = max(MIN_OFFSET_C, min(MAX_OFFSET_C, offset_c + step_c))
        await wf(lx, P["override"], offset_c)

        rows.append((elapsed, target, cf, duty, pwr))
        tf = c_to_f(tcmd) if tcmd is not None else None
        ds = f"{duty:6.0f}" if duty is not None else f"{'—':>6}"
        ps = f"{pwr:6.1f}" if pwr is not None else f"{'—':>6}"
        csv_w.writerow([f"{elapsed:.1f}", f"{target:.0f}", f"{cf:.1f}",
                        f"{err:+.0f}", f"{offset_c:.1f}",
                        "" if tf is None else f"{tf:.1f}",
                        "" if duty is None else f"{duty:.0f}",
                        "" if pwr is None else f"{pwr:.1f}",
                        "" if soc_start is None else f"{soc_start:.1f}"])
        csv_f.flush()
        if graph:
            graph.publish(elapsed, target_f=target,
                          chamber_f=cf, tcmd_f=tf, duty=duty,
                          soc=soc_start, state=None)
        print(f"{elapsed:6.1f} {target:7.0f} {cf:8.0f} {err:+6.0f} {offset_c:7.1f} "
              f"{(tf if tf is not None else 0):6.0f} {ds} {ps}")
        await asyncio.sleep(0.6)
    csv_f.close()
    if graph:
        graph.close()
    return step_i

    # ---- summary -----------------------------------------------------------
    print("\n=== per step ===")
    for i, (target, hold) in enumerate(steps):
        lo = sum(s for _, s in steps[:i])
        hi = lo + hold
        phase = [r for r in rows if lo <= r[0] < hi]
        if not phase:
            continue
        temps = [r[2] for r in phase]
        settled = [t for t in temps if abs(t - target) <= SETTLE_F]
        pct = 100 * len(settled) / len(temps)
        duties = [r[3] for r in phase if r[3] is not None]
        duty_s = f", duty {min(duties):.0f}-{max(duties):.0f}%" if duties else ""
        print(f"  {target:.0f} °F for {hold:.0f} s: "
              f"reached {min(temps):.0f}-{max(temps):.0f} °F, "
              f"within ±{SETTLE_F:.0f} °F for {pct:.0f}% of the hold{duty_s}")

    # ---- the plateau question ----------------------------------------------
    # The whole point of this run: when the chamber stops climbing short of its
    # target, is the heater still working (power/thermal limit) or has it gone
    # idle (firmware ceiling)? Only the duty cycle can tell those apart.
    soc_end = await rf(lx, P["soc"])
    print("\n=== plateau diagnosis ===")
    for line in diagnose_plateau(rows, soc_start, soc_end):
        print(line)


def diagnose_plateau(rows, soc_start: float | None,
                     soc_end: float | None) -> list[str]:
    """Turn a run's samples into a verdict on the ~488 °F plateau.

    Pure so it can be tested without hardware. `rows` are
    (elapsed, target, chamber_f, duty, pwr) tuples; duty/pwr may be None.

    The discriminator is duty cycle while the chamber sits short of target:
    a power-limited unit keeps driving the heater and still cannot climb,
    while a firmware ceiling makes it stop driving.
    """
    out: list[str] = []
    if soc_start is not None and soc_end is not None:
        out.append(f"  battery {soc_start:.1f}% → {soc_end:.1f}%")

    if not rows:
        out.append("  no samples recorded")
        return out

    # Judge each step on its own samples. A global peak is wrong: an early step
    # can overshoot above what a later, hotter step manages, which would hide
    # the plateau behind a sample that was never trying to reach it.
    by_target: dict[float, list] = {}
    for r in rows:
        by_target.setdefault(r[1], []).append(r)

    for target in sorted(by_target):
        step_rows = by_target[target]
        step_peak = max(r[2] for r in step_rows)
        short = target - step_peak
        out.append(f"  step {target:.0f} °F: peak {step_peak:.0f} °F "
                   f"({f'short {short:.0f} °F' if short > 0 else f'over {-short:.0f} °F'})")

    top_target = max(by_target)
    top_rows = by_target[top_target]
    top_peak = max(r[2] for r in top_rows)
    shortfall = top_target - top_peak

    if shortfall <= SETTLE_F:
        out.append(f"  highest step ({top_target:.0f} °F) reached its target "
                   f"— no plateau in this run")
        return out

    # Use the back half of the step: the start is still climbing.
    tail = top_rows[len(top_rows) // 2:] or top_rows
    duties = [r[3] for r in tail if r[3] is not None]
    pwrs = [r[4] for r in tail if r[4] is not None]
    if not duties:
        out.append("  duty unreadable — cannot diagnose; check the link and rerun")
        return out

    d_med = sorted(duties)[len(duties) // 2]
    p_med = sorted(pwrs)[len(pwrs) // 2] if pwrs else None
    out.append(f"  at {top_target:.0f} °F the chamber stalled {shortfall:.0f} °F short: "
               f"duty {d_med:.0f}%, "
               f"power {f'{p_med:.1f} W' if p_med is not None else '—'} "
               f"over {len(tail)} samples")

    if d_med >= 25:
        out.append("  VERDICT: heater still driving hard — the unit is POWER/THERMALLY limited.")
        out.append("           Charge state, ambient, or the atomizer is the constraint,")
        out.append("           not a firmware ceiling. Retest at 100% before concluding.")
    elif d_med <= 15:
        out.append("  VERDICT: heater gone idle while short of target — this looks like a")
        out.append("           FIRMWARE CEILING. Design the app around 480 °F max.")
    else:
        out.append("  VERDICT: inconclusive duty band (15-25%) — rerun at 100% charge")
    return out


def parse_steps(specs: list[str], profile_f: float | None) -> list[tuple[float, float]]:
    """Parse TEMP:SECONDS steps, where TEMP may be relative with a leading +/-.

    Absolute first, then steps stack on the previous target:

        470:15 +10:15 +10:10      ->  470, 480, 490   (the ladder)

    A relative value with no previous target stacks on the profile, so
    `+0:15 +18:15` is a legal way to say "hold the profile, then rise 18".
    """
    out: list[tuple[float, float]] = []
    for spec in specs:
        temp_s, _, hold_s = spec.partition(":")
        hold = float(hold_s or 10)
        if temp_s[:1] in "+-":
            base = out[-1][0] if out else profile_f
            if base is None:
                raise SystemExit(f"step {spec!r} is relative but no --profile is set")
            temp = base + float(temp_s)
        else:
            temp = float(temp_s)
        out.append((temp, hold))
    return out


async def supervise(addr: str, steps: list[tuple[float, float]], profile_f: float | None,
                    slot: int, timeout_s: float, retries: int, live: bool = True,
                    min_soc: float = 0.0, max_temp: float = 999.0,
                    use_boost: bool = True) -> int:
    """Run the curve, reconnecting and resuming if the link drops.

    The Peak drops a live link on its own — we saw two of six runs die mid-flight
    and lose the whole session. Stages already finished are not repeated: the
    attempts walk forward through `steps` and stop once the index reaches the end.
    """
    step = 0
    for attempt in range(retries + 1):
        if attempt:
            print(f"\nlink dropped — reconnecting (attempt {attempt}/{retries})")
            await asyncio.sleep(3.0)
        try:
            step = await run_attempt(addr, steps, profile_f, slot, timeout_s, step, live, min_soc,
                        max_temp, use_boost)
        except (BleakError, RuntimeError, asyncio.TimeoutError, OSError) as e:
            print(f"  attempt failed: {type(e).__name__}: {e}")
            continue
        if step < 0:
            return 1
        if step >= len(steps):
            return 0
    print("\ngave up: link would not hold")
    return 1


def main() -> int:
    ap = argparse.ArgumentParser(description="Run a closed-loop temperature curve")
    ap.add_argument("--addr", required=True, help="Peak MAC")
    ap.add_argument("--steps", required=True, nargs="+",
                    help="TEMP:SECONDS pairs, e.g. 480:15 490:10 500:8")
    ap.add_argument("--profile", type=float, default=None,
                    help="profile temperature to set (default: lowest step - 25)")
    ap.add_argument("--slot", type=int, default=0)
    ap.add_argument("--timeout", type=float, default=180.0,
                    help="seconds to wait for the first target")
    ap.add_argument("--max-bat-temp", type=float, default=40.0,
                    help="refuse to start above this battery temperature, C (default 40)")
    ap.add_argument("--min-soc", type=float, default=15.0,
                    help="refuse to start below this battery %% (default 15)")
    ap.add_argument("--force", action="store_true",
                    help="run even below --min-soc")
    ap.add_argument("--no-boost", action="store_true",
                    help="do not use boost mode for rising steps")
    ap.add_argument("--no-live", dest="live", action="store_false",
                    help="do not open the live graph (default: it opens)")
    ap.add_argument("--retries", type=int, default=2,
                    help="reconnect attempts after a dropped link (default 2)")
    args = ap.parse_args()

    steps = parse_steps(args.steps, args.profile)

    return asyncio.run(supervise(args.addr, steps, args.profile, args.slot,
                                 args.timeout, args.retries, args.live,
                                 0.0 if args.force else args.min_soc,
                                 999.0 if args.force else args.max_bat_temp,
                                 not args.no_boost))


if __name__ == "__main__":
    sys.exit(main())
