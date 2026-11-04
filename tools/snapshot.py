#!/usr/bin/env python3
"""Peak Pro read-only telemetry snapshot.

Answers "what is the device doing right now" without touching it. Every call
here is a read; there is no write path in this file, which is why it is safe to
run while a session is live or while the unit is still cooling from one.

    .venv/bin/python tools/snapshot.py --addr F0:AD:4E:41:5B:76
    .venv/bin/python tools/snapshot.py --addr ... --watch 120

`--watch N` samples every `--every` seconds for N seconds and prints one line
per sample, so the same command covers the before, during and after of a test.
It never starts, stops or retargets a session.
"""

from __future__ import annotations

import argparse
import asyncio
import math
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from bleak import BleakClient

from probe import (  # noqa: E402  (path set above)
    P, SERVICE, SILABS_APP_VERSION, Lorax, find_device, bad, dim, head, line, off, ok, warn,
)

STATE_NAMES = {
    0: "init", 1: "version", 2: "battery", 3: "off", 4: "sleep", 5: "idle",
    6: "temp-select", 7: "preheat", 8: "active", 9: "fade", 10: "version",
    11: "battery", 12: "factory-test", 13: "bonding",
}
IN_SESSION = {7, 8, 9}


def c_to_f(c: float | None) -> float | None:
    return None if c is None else c * 9 / 5 + 32


def show(v: float | None, unit: str = "") -> str:
    # The device answers 0x7F800000 (+inf) for `tott` while idle, and the elapsed
    # counter keeps whatever the last session left. Neither is a number worth
    # printing, so they read as absent.
    if v is None or not math.isfinite(v):
        return "—"
    return f"{v:.1f}{unit}"


async def sample(lx: Lorax, first: bool) -> dict:
    st = await lx.read_u8(P["state"])
    temp_c = await lx.read_float(P["temp"])
    tcmd_c = await lx.read_float(P["tcmd"])
    ov_c = await lx.read_float(P["override"])
    elap = await lx.read_float(P["elap"])
    tott = await lx.read_float(P["tott"])
    thc_c = await lx.read_float(P["thc_temp"])
    soc = await lx.read_float(P["soc"])
    duty = await lx.read_float(P["duty"])
    pwr = await lx.read_float(P["power"])

    d = {
        "state": st, "temp_c": temp_c, "tcmd_c": tcmd_c, "ov_c": ov_c,
        "elap": elap, "tott": tott, "thc_c": thc_c,
        "soc": soc, "duty": duty, "pwr": pwr,
    }

    name = STATE_NAMES.get(st, "?") if st is not None else "unreadable"
    stamp = time.strftime("%H:%M:%S")
    if first:
        head(f"device state at {stamp}")
        line(f"  state            {name} ({st})")
        line(f"  chamber          {show(c_to_f(temp_c), ' °F')}   ({show(temp_c, ' °C')})")
        line(f"  heater target    {show(c_to_f(tcmd_c), ' °F')}   ({show(tcmd_c, ' °C')})")
        line(f"  live base        {show(c_to_f(thc_c), ' °F')}")
        line(f"  offset           {show(ov_c, ' °C')}")
        clock_note = "" if st in IN_SESSION else "   (no session; counters are leftovers)"
        line(f"  session clock    {show(elap, ' s')} of {show(tott, ' s')}{clock_note}")
        line(f"  battery          {show(soc, ' %')}")
        line(f"  heater           {show(duty, ' %')} duty, {show(pwr, ' W')}")
        if st in IN_SESSION:
            line(f"  {warn}in session — the device is heating or fading out{off}")
        else:
            line(f"  {ok}not in session{off}")
    else:
        line(f"  {stamp}  {name:<12} chamber {show(c_to_f(temp_c), '°F'):>9}"
             f"   tcmd {show(c_to_f(tcmd_c), '°F'):>9}"
             f"   base {show(c_to_f(thc_c), '°F'):>9}"
             f"   ov {show(ov_c, '°C'):>7}"
             f"   {show(duty, '%')} duty")
    return d


async def run(args) -> int:
    dev = await find_device(args.addr)
    if dev is None:
        return 1

    line(f"connecting to {dev.address} (read-only)")
    async with BleakClient(dev, timeout=25.0) as client:
        try:
            await client.read_gatt_char(SILABS_APP_VERSION)
        except Exception:
            pass

        lx = Lorax(client, device=dev)
        await lx.start()
        try:
            mode = await lx.authenticate()
        except Exception as e:
            line(f"{bad}auth failed: {e}{off}")
            return 3
        line(f"{dim}unlocked via {mode}{off}")

        first = await sample(lx, True)
        if first["state"] in IN_SESSION:
            line(f"{dim}note: reads stay safe in-session; nothing here writes.{off}")

        if args.watch:
            head(f"watching {args.watch:.0f}s, every {args.every:.1f}s")
            end = time.monotonic() + args.watch
            peak = first["temp_c"] or 0.0
            n = 0
            next_at = time.monotonic()
            while time.monotonic() < end:
                d = await sample(lx, False)
                n += 1
                if d["temp_c"] is not None:
                    peak = max(peak, d["temp_c"])
                # Schedule on absolute time: sampling takes ~1 s, and sleeping
                # `every` after it would stretch the interval every time.
                next_at = max(next_at + args.every, time.monotonic())
                delay = next_at - time.monotonic()
                if delay > 0:
                    await asyncio.sleep(delay)
            head("summary")
            line(f"  peak chamber     {show(c_to_f(peak), ' °F')}")
            line(f"  final state      {STATE_NAMES.get(d['state'], '?') if d['state'] is not None else 'unreadable'}")
            line(f"  final chamber    {show(c_to_f(d['temp_c']), ' °F')}")
            line(f"  samples          {n}")

        line(f"{dim}disconnecting — nothing was written{off}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Read-only Peak Pro telemetry snapshot.")
    ap.add_argument("--addr", help="connect straight to this MAC")
    ap.add_argument("--watch", type=float, default=0.0, help="sample for N seconds")
    ap.add_argument("--every", type=float, default=2.0, help="seconds between samples")
    args = ap.parse_args()
    try:
        return asyncio.run(run(args))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
