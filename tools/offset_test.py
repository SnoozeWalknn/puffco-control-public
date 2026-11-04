#!/usr/bin/env python3
"""Does the offset accept NEGATIVE values, and does the heater act on them?

The offset is documented as additive-only and the official app never sends a
negative one, so every "curve down" in the UI is currently a promise rather than
a mechanism. The register is a signed-capable float; whether the firmware honours
it is untested.

Two separate questions, and the second is the one that matters:

  1. does `/p/app/tmpo` store a negative and move `/p/htr/tcmd` down?
  2. when it does, does the chamber actually follow — or does the loop just idle
     and let physics take it, which is what happens today with offset 0?

    .venv/bin/python tools/offset_test.py --addr F0:AD:4E:41:5B:76

Safe to run: it always clears the offset and stops the session on the way out,
and never writes `/p/htr/tcmd`.
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
from bleak.backends.device import BLEDevice

from probe import Lorax, P
from liveplot import LivePlot

C2F = lambda c: c * 1.8 + 32
STEPS = [-5.0, -10.0, -20.0, -30.0, -40.0, 0.0, 5.0]


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


async def run(addr: str, slot: int, live: bool = True) -> int:
    path = f"/org/bluez/hci0/dev_{addr.replace(':', '_').upper()}"
    device = BLEDevice(addr, "Peak Pro", {"path": path, "props": {}})

    async with BleakClient(device, timeout=25.0) as client:
        lx = Lorax(client, device=None)
        await lx.start()
        print("auth:", await lx.authenticate())

        soc = await rf(lx, P["soc"])
        print(f"battery {soc:.1f}%" if soc is not None else "battery unknown")
        original = await rf(lx, f"/u/app/hc/{slot}/temp")

        await lx.write_u8(P["mode"], 7)
        state = None
        for _ in range(180):
            await asyncio.sleep(0.5)
            state = await ru8(lx, P["state"])
            if state in (7, 8):
                break
        if state not in (7, 8):
            print(f"session did not start (state {state})")
            return 1

        # Let it reach ACTIVE so the loop is actually regulating.
        for _ in range(120):
            if await ru8(lx, P["state"]) == 8:
                break
            await asyncio.sleep(0.5)

        await wf(lx, P["override"], 0.0)
        await asyncio.sleep(0.6)
        base_c = await rf(lx, P["tcmd"])
        base_f = C2F(base_c) if base_c is not None else None
        print(f"session live. baseline tcmd {base_f:.0f} °F\n")

        run_dir = Path(__file__).resolve().parent.parent / "runs"
        run_dir.mkdir(exist_ok=True)
        csv_path = run_dir / f"offset-{time.strftime('%Y%m%d-%H%M%S')}.csv"
        f = csv_path.open("w", newline="")
        w = csv.writer(f)
        w.writerow(["t", "want_c", "readback_c", "tcmd_f", "chamber_f", "duty", "soc"])

        graph = LivePlot().start() if live else None
        print(f"{'want C':>7} {'stored C':>9} {'tcmd F':>8} {'delta F':>8} {'duty':>6}")
        effects = {}
        t0 = time.time()
        try:
            for want in STEPS:
                await wf(lx, P["override"], want)
                await asyncio.sleep(1.2)
                rb = await rf(lx, P["override"])
                tc = await rf(lx, P["tcmd"])
                ch = await rf(lx, P["temp"])
                du = await rf(lx, P["duty"])
                so = await rf(lx, P["soc"])
                tcf = C2F(tc) if tc is not None else None
                delta = (tcf - base_f) if (tcf is not None and base_f is not None) else None
                effects[want] = delta
                w.writerow([f"{time.time()-t0:.1f}", want, rb,
                            f"{tcf:.1f}" if tcf is not None else "", 
                            f"{C2F(ch):.1f}" if ch is not None else "",
                            du, so])
                f.flush()
                print(f"{want:7.0f} {rb if rb is not None else 0:9.1f} "
                      f"{tcf if tcf is not None else 0:8.1f} "
                      f"{delta if delta is not None else 0:+8.1f} "
                      f"{du if du is not None else 0:6.1f}")
                if graph:
                    graph.publish(time.time() - t0,
                                  target_f=(base_f + want * 1.8) if base_f else None,
                                  chamber_f=C2F(ch) if ch is not None else None,
                                  tcmd_f=tcf, duty=du, soc=so)
                await asyncio.sleep(0.6)
            f.close()
            if graph:
                graph.close()
        finally:
            try:
                await wf(lx, P["override"], 0.0)
                await wf(lx, P["time_offset"], 0.0)
                await lx.write_u8(P["mode"], 8)
                await asyncio.sleep(0.3)
                await lx.write_u8(P["mode"], 2)
                if original is not None:
                    await wf(lx, f"/u/app/hc/{slot}/temp", original)
            except Exception:
                pass

        print(f"\n=== verdict ===\n  log: {csv_path}")
        neg = {k: v for k, v in effects.items() if k < 0 and v is not None}
        if not neg:
            print("  no negative step produced a delta")
            return 1
        moved = [k for k, v in neg.items() if v < -2.0]
        linear = [k for k, v in neg.items() if v is not None and abs(v - k * 1.8) <= 4.0]
        print(f"  negative steps that moved tcmd down: {moved}")
        print(f"  negative steps within 4 °F of 1.8 °F/°C: {linear}")
        if len(moved) == len(neg) and len(linear) == len(neg):
            print("  RESULT: negatives are honoured linearly. A falling curve can be")
            print("          commanded, not just requested — set curve.js source limits")
            print("          to a negative minimum and drop the decay caveat.")
        elif moved:
            print("  RESULT: negatives partly work but not linearly; floor at the last")
            print("          value that tracked 1.8 °F/°C before using them in the UI.")
        else:
            print("  RESULT: negatives are stored but ignored, tcmd does not move.")
            print("          Keep the 0 floor and keep treating descent as passive.")
        return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Test negative offset acceptance")
    ap.add_argument("--addr", required=True, help="Peak MAC")
    ap.add_argument("--slot", type=int, default=0)
    ap.add_argument("--no-live", dest="live", action="store_false",
                    help="do not open the live graph (default: it opens)")
    args = ap.parse_args()
    return asyncio.run(run(args.addr, args.slot, args.live))


if __name__ == "__main__":
    raise SystemExit(main())
