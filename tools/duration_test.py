#!/usr/bin/env python3
"""Settle whether the session duration cap is 60 s, 120 s, or 200 s.

The profile time field clamps at 120 while idle, `stat/tott` settles at 60, and
sessions end by themselves after 64-67 s. Three numbers that disagree, and the
curve planner's segmentation depends on which is real.

Two things are being measured, and the second is the one that matters:

  1. the profile field's cap — writes above 120 read back 120
  2. the time override `/p/app/timo`, which adds to the profile budget live and
     carries the app's real "extra time" feature

The device budget is `time + timo`. Measured 2026-11-03: 120 + 80 gave a
`stat/tott` of 200 and 120 + 180 gave 300, so timo is capped at 180 and the
ceiling is 300 s. This tool re-establishes that on whatever unit it runs on.

    .venv/bin/python tools/duration_test.py --addr F0:AD:4E:41:5B:76
    .venv/bin/python tools/duration_test.py --addr ... --want 200 --idle-control

Read the verdict block at the end. `tott` moving above ~60 means the 60 s figure
is an artefact and the planner should stop splitting there.
"""

from __future__ import annotations

import argparse
import asyncio
import math
import csv
import struct
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from bleak import BleakClient
from bleak.backends.device import BLEDevice

from probe import Lorax, P
from liveplot import LivePlot

STATE_PREHEAT = 7
STATE_ACTIVE = 8
STATE_IDLE = 5
STATE_FADE = 9

C2F = lambda c: c * 1.8 + 32


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


async def wf(lx: Lorax, path: str, value: float) -> None:
    await lx.write_raw(path, struct.pack("<f", value))


async def _stop(lx: Lorax, slot_time: str, original_time: float | None) -> None:
    """Always leave the device idle and the slot time as it was found."""
    try:
        await wf(lx, P["time_offset"], 0.0)
        await lx.write_u8(P["mode"], 8)
        await asyncio.sleep(0.3)
        await lx.write_u8(P["mode"], 2)
        if original_time is not None:
            await wf(lx, slot_time, original_time)
        print("  stopped, slot time restored")
    except Exception as e:
        print(f"  cleanup failed: {type(e).__name__}")


async def probe_once(addr: str, slot: int, want_s: float, idle_control: bool,
                     limit_s: float, live: bool = True) -> int:
    path = f"/org/bluez/hci0/dev_{addr.replace(':', '_').upper()}"
    device = BLEDevice(addr, "Peak Pro", {"path": path, "props": {}})
    slot_time = f"/u/app/hc/{slot}/time"

    async with BleakClient(device, timeout=25.0) as client:
        lx = Lorax(client, device=None)
        await lx.start()
        print("auth:", await lx.authenticate())

        soc = await rf(lx, P["soc"])
        if soc is not None:
            print(f"battery {soc:.1f}%"
                  + ("  <-- below 55%, treat duration as provisional" if soc < 55 else ""))

        original_time = await rf(lx, slot_time)
        graph = LivePlot().start() if live else None

        if idle_control:
            # The old way, for comparison: write before starting.
            await wf(lx, slot_time, want_s)
            await asyncio.sleep(0.4)
            print(f"control: wrote {want_s:.0f}s while IDLE, read back {await rf(lx, slot_time)}")

        await lx.write_u8(P["mode"], 7)
        state = None
        # Preheat can take 40 s from cold on a low battery; wait properly rather
        # than bailing at the first opportunity.
        for _ in range(180):
            await asyncio.sleep(0.5)
            state = await ru8(lx, P["state"])
            if state == STATE_ACTIVE:
                break
        if state not in (STATE_ACTIVE, STATE_PREHEAT):
            print(f"session did not start (state {state})")
            await _stop(lx, slot_time, original_time)
            return 1
        if state == STATE_PREHEAT:
            print("  still preheating — writing during PREHEAT anyway, it is still a live cycle")

        print(f"\nsession live (state {state})")
        print(f"  profile field: writing {want_s:.0f}s")
        await wf(lx, slot_time, want_s)
        await asyncio.sleep(0.4)
        prof = await rf(lx, slot_time)
        print(f"  profile readback: {prof}")

        # The half that actually extends: timo, on top of the profile budget.
        timo = max(0.0, min(180.0, want_s - (prof or 120.0)))
        await wf(lx, P["time_offset"], timo)
        await asyncio.sleep(0.5)
        print(f"  timo written {timo:.0f}s -> readback {await rf(lx, P['time_offset'])}")
        print(f"  tott now: {await rf(lx, P['tott'])}")

        run_dir = Path(__file__).resolve().parent.parent / "runs"
        run_dir.mkdir(exist_ok=True)
        csv_path = run_dir / f"duration-{time.strftime('%Y%m%d-%H%M%S')}.csv"
        f = csv_path.open("w", newline="")
        w = csv.writer(f)
        w.writerow(["t", "state", "tott", "elap", "chamber_f", "tcmd_f", "duty", "soc"])

        print(f"\n{'t':>5} {'state':>5} {'tott':>7} {'elap':>7} {'chamber':>8} {'duty':>6}")
        peak_tott = 0.0
        t0 = time.time()
        ended = None
        while time.time() - t0 < limit_s:
            st = await ru8(lx, P["state"])
            tott = await rf(lx, P["tott"])
            elap = await rf(lx, P["elap"])
            ch = await rf(lx, P["temp"])
            tc = await rf(lx, P["tcmd"])
            duty = await rf(lx, P["duty"])
            s = await rf(lx, P["soc"])
            el = time.time() - t0
            if tott is not None and math.isfinite(tott):
                peak_tott = max(peak_tott, tott)
            w.writerow([f"{el:.1f}", st, tott, elap,
                        f"{C2F(ch):.1f}" if ch is not None else "",
                        f"{C2F(tc):.1f}" if tc is not None else "",
                        duty, s])
            f.flush()
            if graph:
                graph.publish(el, chamber_f=C2F(ch) if ch is not None else None,
                              tcmd_f=C2F(tc) if tc is not None else None,
                              duty=duty, soc=s, state=st)
            if int(el) % 3 == 0:
                print(f"{el:5.0f} {str(st):>5} {tott if tott is not None else 0:7.1f} "
                      f"{elap if elap is not None else 0:7.1f} "
                      f"{C2F(ch) if ch is not None else 0:8.0f} {duty if duty is not None else 0:6.1f}")
            if st in (STATE_IDLE, STATE_FADE):
                ended = el
                break
            await asyncio.sleep(1.0)
        f.close()

        if graph:
            graph.close()
        await _stop(lx, slot_time, original_time)

        print(f"\n=== verdict ===\n  log: {csv_path}")
        print(f"  peak tott seen: {peak_tott:.1f} s")
        print(f"  session ended after: {ended if ended else f'>{limit_s:.0f}'} s from the write")
        if peak_tott >= 290:
            print("  RESULT: the budget composes as time + timo, timo caps at 180 and the")
            print("          ceiling is ~300 s. That is what SESSION_LIFE_S, SESSION_PROFILE_")
            print("          MAX_S and TIMO_MAX_S encode. Anything past 300 must span sessions.")
        elif peak_tott >= 170:
            print("  RESULT: timo extended past the profile cap but did not reach 300.")
            print("          Re-read the maximum before trusting SESSION_LIFE_S at 300.")
        else:
            print("  RESULT: neither the profile field nor timo exceeded ~120. The 300 s")
            print("          model does not reproduce here; lower SESSION_LIFE_S to the peak.")
        return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Settle the real session-duration cap")
    ap.add_argument("--addr", required=True, help="Peak MAC")
    ap.add_argument("--slot", type=int, default=0)
    ap.add_argument("--want", type=float, default=200.0,
                    help="seconds to write during the session (default 200)")
    ap.add_argument("--limit", type=float, default=215.0,
                    help="stop watching after this many seconds (default 215)")
    ap.add_argument("--no-live", dest="live", action="store_false",
                    help="do not open the live graph (default: it opens)")
    ap.add_argument("--idle-control", action="store_true",
                    help="also write while idle first, to show the clamp")
    a = ap.parse_args()
    return asyncio.run(probe_once(a.addr, a.slot, a.want, a.idle_control, a.limit, a.live))


if __name__ == "__main__":
    raise SystemExit(main())
