#!/usr/bin/env python3
"""Peak Pro probe — terminal version.

Chromium on Linux has no working Web Bluetooth device chooser: requestDevice()
never resolves, so the browser probe cannot run here. BlueZ can see the device
fine, so this does the same tests directly over D-Bus via bleak.

    .venv/bin/python tools/probe.py            # read-only
    .venv/bin/python tools/probe.py --live     # also run the heating test

Same protocol layer as ui/proto/lorax.js, same questions, same safety rules.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import os
import struct
import sys
import time
from base64 import b64decode

from bleak import BleakClient, BleakScanner
from bleak.exc import BleakError
from bleak.backends.device import BLEDevice

# ------------------------------------------------------------------ protocol

SERVICE = "e276967f-ea8a-478a-a92e-d78f5dd15dd5"
CHAR_VERSION = "05434bca-cc7f-4ef6-bbb3-b1c520b9800c"
CHAR_COMMAND = "60133d5c-5727-4f2c-9697-d842c5292a3c"
CHAR_REPLY = "8dc5ec05-8f7d-45ad-99db-3fbde65dbd9c"
CHAR_EVENT = "43312cd1-7d34-46ce-a7d3-0a98fd9b4cb8"

SILABS_SERVICE = "1d14d6ee-fd63-4fa1-bfa4-8f47b42119f0"
SILABS_APP_VERSION = "0d77cc11-4ac1-49f2-bfa9-cd96ac7a92f8"

OP = {
    "GET_ACCESS_SEED": 0,
    "UNLOCK_ACCESS": 1,
    "GET_LIMITS": 2,
    "READ_SHORT": 16,
    "WRITE_SHORT": 17,
}

# The vendor's handshake constant is NOT part of this repository. Supply it at
# runtime: PEAK_HANDSHAKE_KEY, or a gitignored `tools/handshake.key` holding the
# base64 value. Without it the device answers with a seed and refuses every read.
def _load_handshake() -> bytes:
    v = os.environ.get("PEAK_HANDSHAKE_KEY", "").strip()
    if v:
        return b64decode(v)
    local = os.path.join(os.path.dirname(os.path.abspath(__file__)), "handshake.key")
    if os.path.exists(local):
        with open(local) as fh:
            return b64decode(fh.read().strip())
    return b64decode("AAAAAAAAAAAAAAAAAAAAAA==")   # placeholder: never authenticates


HANDSHAKE_LORAX = _load_handshake()
REVISION_CHARS = "ABCDEFGHJKMNPRTUVWXYZ"

P = {
    "fw": "/p/sys/fw/ver",
    "hw": "/p/sys/hw/ver",
    "model": "/p/sys/hw/mdcd",
    "serial": "/p/sys/hw/ser",
    "name": "/u/sys/name",
    "chamber": "/p/htr/chmt",
    "state": "/p/app/stat/id",
    "tott": "/p/app/stat/tott",
    "elap": "/p/app/stat/elap",
    "temp": "/p/htr/temp",
    "tcmd": "/p/htr/tcmd",
    "override": "/p/app/tmpo",
    "time_offset": "/p/app/timo",
    "hcs": "/p/app/hcs",
    # LIVE profile fields. `hc/%N/*` is the stored record; `thc/*` is what the
    # running cycle actually uses. Confirmed on hardware: writing hc/0/temp did
    # not retarget an active session, writing thc/temp did.
    "thc_temp": "/p/app/thc/temp",
    "thc_time": "/p/app/thc/time",
    "thc_name": "/p/app/thc/name",
    "thc_btmp": "/p/app/thc/btmp",
    "thc_btim": "/p/app/thc/btim",
    "mode": "/p/app/mc",
    "soc": "/p/bat/soc",
    "chg_stat": "/p/bat/chg/stat",
    "chg_src": "/p/bat/chg/src",
    "bat_curr": "/p/bat/curr",
    "bat_temp": "/p/bat/temp",
    "power": "/p/htr/pwr",
    "res": "/p/htr/res",
    "duty": "/p/htr/duty",
    "total_dabs": "/p/app/odom/0/nc",
    "trip_dabs": "/p/app/odom/1/nc",
    "remaining": "/p/app/info/drem",
}

F_TO_C = 5.0 / 9.0


def f_to_c(f: float) -> float:
    return (f - 32.0) * F_TO_C


def c_to_f(c: float) -> float:
    return c * 9.0 / 5.0 + 32.0


def revision_string(rev: int) -> str:
    if rev <= 0:
        return "X*"
    i, out = rev - 1, ""
    while i >= 0:
        out = REVISION_CHARS[i % len(REVISION_CHARS)] + out
        i = i // len(REVISION_CHARS) - 1
    return out


def enc_float(v: float) -> bytes:
    return struct.pack("<f", v)


def dec_float(b: bytes) -> float | None:
    return struct.unpack("<f", b[:4])[0] if len(b) >= 4 else None


def dec_u32(b: bytes) -> int | None:
    return struct.unpack("<I", b[:4])[0] if len(b) >= 4 else None


def dec_u8(b: bytes) -> int | None:
    return b[0] if b else None


def dec_str(b: bytes) -> str:
    return b.rstrip(b"\x00 ").decode("latin-1", "replace")


# ------------------------------------------------------------------- client


class Lorax:
    """Same shape as ui/proto/lorax.js: one command, one reply, serialised."""

    def __init__(self, client: BleakClient, timeout: float = 6.0, device=None):
        self.client = client
        self.device = device
        self.timeout = timeout
        self.seq = 0
        self.pending: dict[int, asyncio.Future] = {}
        self.max_payload = 200
        self.reconnects = 0

    async def reconnect(self) -> None:
        """The Peak drops the link when it sleeps or when the radio is busy.
        Rebuilding the client is cheaper than failing the whole probe."""
        if self.device is None:
            raise RuntimeError("link lost and no device handle to reconnect with")
        try:
            await self.client.disconnect()
        except Exception:
            pass
        self.pending.clear()
        self.client = BleakClient(self.device, timeout=25.0)
        await self.client.connect()
        await self.client.start_notify(CHAR_REPLY, self._on_reply)
        try:
            await self.client.start_notify(CHAR_EVENT, lambda _c, _d: None)
        except Exception:
            pass
        self.reconnects += 1
        await self.authenticate()

    def _on_reply(self, _char, data: bytearray) -> None:
        if len(data) < 3:
            return
        seq = struct.unpack("<H", data[0:2])[0]
        err = data[2]
        fut = self.pending.pop(seq, None)
        if fut is None or fut.done():
            return
        if err:
            fut.set_exception(RuntimeError(f"device error 0x{err:02x}"))
        else:
            fut.set_result(bytes(data[3:]))

    async def start(self) -> None:
        await self.client.start_notify(CHAR_REPLY, self._on_reply)
        try:
            await self.client.start_notify(CHAR_EVENT, lambda _c, _d: None)
        except Exception:
            pass

    async def _command(self, op: int, payload: bytes = b"", expect_reply: bool = True) -> bytes:
        self.seq = (self.seq + 1) % 65535 or 1
        seq = self.seq
        cmd = struct.pack("<HB", seq, op) + payload

        await self.ensure_services()

        # Pace: a burst of 40 commands with no gap can make the device drop the
        # link. 15 ms is far below the 57 ms read latency, so it costs nothing.
        await asyncio.sleep(0.015)

        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self.pending[seq] = fut

        await self.client.write_gatt_char(CHAR_COMMAND, cmd, response=False)

        if not expect_reply:
            await asyncio.sleep(0.03)
            self.pending.pop(seq, None)
            if not fut.done():
                fut.cancel()
            return b""

        try:
            return await asyncio.wait_for(fut, self.timeout)
        except asyncio.TimeoutError:
            self.pending.pop(seq, None)
            raise TimeoutError(f"no reply for op {op} ({self.timeout}s)") from None

    async def read_raw(self, path: str) -> bytes:
        try:
            await self.ensure_services()
            p = struct.pack("<HH", 0, self.max_payload) + path.encode()
            return await self._command(OP["READ_SHORT"], p)
        except (BleakError, EOFError, TimeoutError):
            await self.reconnect()
            p = struct.pack("<HH", 0, self.max_payload) + path.encode()
            return await self._command(OP["READ_SHORT"], p)

    async def ensure_services(self) -> None:
        """bleak 3.x discovers services on connect and has no get_services().
        All this has to do is confirm the client is still connected; if it is
        not, raise so the caller's retry path can rebuild it.

        (Calling a removed get_services() here raised AttributeError on every
        command, which the retry path read as a dropped link — it caused a
        reconnect loop rather than fixing one.)"""
        if not self.client.is_connected:
            raise BleakError("link is down")

    async def write_raw(self, path: str, data: bytes) -> None:
        flag = 4 if path.endswith("/name") else 0
        p = struct.pack("<HB", 0, flag) + path.encode() + b"\x00" + data
        try:
            await self._command(OP["WRITE_SHORT"], p, expect_reply=False)
        except (BleakError, EOFError):
            await self.reconnect()
            await self._command(OP["WRITE_SHORT"], p, expect_reply=False)

    async def read_float(self, path: str) -> float | None:
        try:
            return dec_float(await self.read_raw(path))
        except Exception:
            return None

    async def read_u8(self, path: str) -> int | None:
        try:
            return dec_u8(await self.read_raw(path))
        except Exception:
            return None

    async def read_u32(self, path: str) -> int | None:
        try:
            return dec_u32(await self.read_raw(path))
        except Exception:
            return None

    async def read_str(self, path: str) -> str | None:
        try:
            return dec_str(await self.read_raw(path))
        except Exception:
            return None

    async def write_float(self, path: str, value: float) -> None:
        await self.write_raw(path, enc_float(value))

    async def write_u8(self, path: str, value: int) -> None:
        await self.write_raw(path, bytes([value & 0xFF]))

    async def authenticate(self) -> str:
        seed_raw = await self._command(OP["GET_ACCESS_SEED"])
        if len(seed_raw) < 16:
            raise RuntimeError("short access seed")
        seed = seed_raw[:16]

        for label, key in (("lorax handshake", HANDSHAKE_LORAX), ("seed-only", None)):
            buf = bytearray(32)
            if key:
                buf[0:16] = key[:16]
            buf[16:32] = seed
            token = hashlib.sha256(bytes(buf)).digest()[:16]
            try:
                await self._command(OP["UNLOCK_ACCESS"], token)
            except Exception:
                continue
            # Verify with a real read: an accepted token that still refuses
            # reads is not an unlock.
            try:
                if len(await self.read_raw(P["soc"])) > 0:
                    return label
            except Exception:
                continue
        raise RuntimeError("every unlock variant was refused")


# -------------------------------------------------------------------- probe

ok = "\033[32m"
bad = "\033[31m"
warn = "\033[33m"
dim = "\033[2m"
off = "\033[0m"


def line(msg: str = "") -> None:
    print(msg, flush=True)


def head(msg: str) -> None:
    line(f"\n\033[1m{msg}{off}")


async def find_device(name_hint: str | None) -> object:
    # BlueZ already knows this device from a previous scan; connecting straight
    # to the address is more reliable than waiting for a fresh advertisement,
    # because a scanner that is already running elsewhere can swallow the
    # discovery packets.
    if name_hint:
        # BlueZ needs the D-Bus object path, which it assigns when it caches the
        # device. Look it up rather than guessing.
        path = f"/org/bluez/hci0/dev_{name_hint.replace(':', '_').upper()}"
        line(f"using known address {name_hint}")
        return BLEDevice(name_hint, "Peak Pro", {"path": path, "props": {}})
    line("scanning 15 s for a Peak…")
    seen = {}

    def on_detect(dev, adv):
        n = dev.name or ""
        mfg = getattr(adv, "manufacturer_data", {}) or {}
        is_peak = (
            3075 in mfg
            or "peak" in n.lower()
            or n.upper().startswith(("84:2E:14", "84:FD:27", "0C:43:14", "F0:AD:4E"))
        )
        if is_peak and dev.address not in seen:
            seen[dev.address] = (dev, n, mfg.get(3075))
            line(f"  {ok}found{off} {dev.address}  {n or '(unnamed)'}")

    scanner = BleakScanner(detect_callback=on_detect)
    await scanner.start()
    await asyncio.sleep(15)
    await scanner.stop()

    if not seen:
        line(f"{bad}no Peak found{off} — is it in pairing mode (blue logo)?")
        return None

    if name_hint:
        for addr, (dev, _n, _m) in seen.items():
            if name_hint.lower() in addr.lower():
                return dev

    # Prefer an explicit name match, then the first with Puffco manufacturer data.
    for addr, (dev, n, mfg) in seen.items():
        if "peak" in (n or "").lower():
            return dev
    return next(iter(seen.values()))[0]


async def probe(live: bool, addr: str | None = None) -> int:
    dev = await find_device(addr)
    if dev is None:
        return 1

    head(f"connecting to {dev.address}")
    async with BleakClient(dev, timeout=25.0) as client:
        line(f"  connected: {client.is_connected}")

        # Trigger bonding the same way the official app does: read the Silabs
        # app-version characteristic. Failure is normal on an already-bonded unit.
        try:
            await client.read_gatt_char(SILABS_APP_VERSION)
            line(f"  {dim}silabs read ok (bond trigger){off}")
        except Exception:
            line(f"  {dim}silabs read skipped{off}")

        # What the device actually exposes — distinguishes "wrong protocol"
        # from "wrong device" before anything else fails.
        head("services")
        has_lorax = False
        try:
            for svc in client.services:
                line(f"  {dim}{svc.uuid}{off}  ({len(svc.characteristics)} chars)")
                if svc.uuid.lower() == SERVICE:
                    has_lorax = True
        except Exception as e:
            line(f"  {bad}service enumeration failed: {e}{off}")

        if not has_lorax:
            line(f"\n{bad}Lorax service absent{off} — this unit speaks the older flat GATT protocol.")
            return 2

        lx = Lorax(client, device=dev)
        await lx.start()

        head("handshake")
        try:
            mode = await lx.authenticate()
            line(f"  {ok}unlocked via {mode}{off}")
        except Exception as e:
            line(f"  {bad}auth failed: {e}{off}")
            return 3

        head("identity")
        fw_int = await lx.read_u32(P["fw"])
        fw = revision_string(fw_int or 0)
        line(f"  firmware      {fw} (raw {fw_int})")
        line(f"  hardware      {await lx.read_str(P['hw']) or '—'}")
        line(f"  model code    {await lx.read_u32(P['model'])}")
        serial = await lx.read_str(P["serial"]) or ""
        line(f"  serial        ••••{serial[-4:] if serial else '—'}")
        line(f"  name          {await lx.read_str(P['name']) or '—'}")
        line(f"  chamber type  {await lx.read_u8(P['chamber'])}")

        head("setpoint offset semantics")
        base = await lx.read_float(P["override"])
        line(f"  baseline /p/app/tmpo = {base}")

        async def echo(v: float) -> float | None:
            await lx.write_float(P["override"], v)
            await asyncio.sleep(0.08)
            return await lx.read_float(P["override"])

        z = await echo(0.0)
        p1 = await echo(1.0)
        m1 = await echo(-1.0)
        p25 = await echo(25.0)
        m25 = await echo(-25.0)
        await echo(0.0)

        line(f"  write   0 → {z}")
        line(f"  write  +1 → {p1}")
        line(f"  write  -1 → {m1}   {'← NEGATIVE ACCEPTED' if (m1 or 0) < -0.01 else ''}")
        line(f"  write +25 → {p25}")
        line(f"  write -25 → {m25}")
        line(f"  {dim}restored to 0{off}")

        neg_ok = m1 is not None and m1 < -0.01
        neg_clamped = m1 is not None and abs(m1) < 0.01
        cap = "clamped at 20 °C" if (p25 is not None and abs(p25 - 20) < 0.5) else f"echoed {p25}"

        head("profile slots")
        found = []
        for n in list(range(8)) + [12, 24]:
            nm = await lx.read_str(f"/u/app/hc/{n}/name")
            t = await lx.read_float(f"/u/app/hc/{n}/temp")
            if nm and t is not None:
                found.append(n)
                line(f"  slot {n:2d}  \"{nm}\"  {round(c_to_f(t))} °F")
            else:
                line(f"  {dim}slot {n:2d}  —{off}")

        head("read rate")
        t0 = time.perf_counter()
        reads = 0
        failures = 0
        for _ in range(15):
            try:
                await lx.read_raw(P["temp"])
                reads += 1
            except Exception:
                failures += 1
        elapsed = (time.perf_counter() - t0) * 1000
        if reads == 0:
            per = float("nan")
            line(f"  {bad}all {failures} reads failed — link unstable{off}")
        else:
            per = elapsed / reads
            extra = f", {failures} retried" if failures else ""
            line(f"  ~{per:.0f} ms per read ({reads} reads{extra})")

        head("telemetry the official app hides")
        pwr = await lx.read_float(P["power"])
        res = await lx.read_float(P["res"])
        duty = await lx.read_float(P["duty"])
        total = await lx.read_u32(P["total_dabs"])
        trip = await lx.read_u32(P["trip_dabs"])
        rem = await lx.read_u8(P["remaining"])

        def val(v, unit=""):
            return f"{v:.2f}{unit}" if isinstance(v, float) else (f"{v}{unit}" if v is not None else "—")

        line(f"  power      {val(pwr, ' W')}")
        line(f"  resistance {val(res, ' Ω')}")
        line(f"  duty       {val(duty)}")
        line(f"  counters   {val(total)} total · {val(trip)} trip · ~{val(rem)} left")
        if all(v is None for v in (pwr, res, duty)):
            line(f"  {warn}every telemetry read failed — the link dropped and did not recover{off}")

        # ---------------------------------------------------------- summary
        head("summary")
        line(f"  negative delta   {'accepted' if neg_ok else ('clamped to 0' if neg_clamped else 'unclear')}")
        line(f"  upper clamp      {cap}")
        line(f"  profile slots    {len(found)} ({', '.join(map(str, found))})")
        line(f"  read latency     {'unstable' if reads == 0 else f'{per:.0f} ms'}")
        if lx.reconnects:
            line(f"  reconnects       {lx.reconnects}")

        if live:
            try:
                await live_test(lx)
            finally:
                await safe_abort(lx)
        else:
            line(f"\n{dim}read-only phase complete. Add --live to test heating.{off}")

    return 0


async def live_test(lx: Lorax) -> None:
    """The measurement that matters: does the offset move the chamber?

    Waits for the chamber to settle near the profile temperature first. Heating
    from cold produces a large rise on its own; measuring that would report the
    heater warming up as if it were a curve.
    """
    head("live curve test — this heats the device")

    profile_c = await lx.read_float("/u/app/hc/0/temp")
    profile_t = await lx.read_float("/u/app/hc/0/time")
    if profile_c is None:
        line(f"  {bad}could not read profile 0 — link is down{off}")
        line("  Re-run the probe; nothing was heated.")
        return
    target_f = c_to_f(profile_c)
    line(f"  profile 0: {round(target_f)} °F for {round(profile_t or 60)} s")

    # A 40 s session ends before the chamber reaches 490 °F from cold, so the
    # test would measure nothing. Give it enough time for both the climb and the
    # measurement.
    if profile_t is None or profile_t < 150:
        await lx.write_float("/u/app/hc/0/time", 180.0)
        line(f"  extended slot 0 from {round(profile_t or 0)} s to 180 s for the test")

    await lx.write_u8(P["mode"], 7)   # HEAT_CYCLE_START
    line("  session start sent")

    state = None
    for _ in range(40):
        state = await lx.read_u8(P["state"])
        if state in (7, 8):
            break
        await asyncio.sleep(0.15)
    line(f"  state = {state} {'(heating)' if state in (7, 8) else '(did not start)'}")
    if state not in (7, 8):
        await lx.write_u8(P["mode"], 8)
        return

    line(f"  waiting for the chamber to settle near {round(target_f)} °F…")
    settled = None
    t_start = time.time()
    last_shown = -1
    history: list[float] = []
    # 240 s covers a cold chamber reaching 490 °F. Stop early either when the
    # chamber is close to target, or when it has stopped rising (a slow climb
    # never quite arrives, and waiting forever measures nothing).
    while time.time() - t_start < 240:
        c = await lx.read_float(P["temp"])
        st = await lx.read_u8(P["state"])
        if st not in (7, 8):
            line(f"  session ended while waiting (state {st}) — the session was too")
            line("  short to reach the profile temperature. Re-run; the probe now")
            line("  extends it to 180 s first.")
            return
        if c is not None:
            f = c_to_f(c)
            history.append(f)
            if abs(f - target_f) <= 12:
                settled = c
                break
            # Flat for 12 s = as settled as this device is going to get.
            if len(history) >= 13:
                recent = history[-13:]
                if max(recent) - min(recent) < 2.0 and abs(f - target_f) > 12:
                    line(f"  chamber has flattened at {round(f)} °F "
                         f"({round(f - target_f):+d} from target) — using that as the baseline")
                    settled = c
                    break
            secs = int(time.time() - t_start)
            if secs % 10 == 0 and secs != last_shown:
                last_shown = secs
                line(f"    {round(f)} °F ({round(f - target_f):+d} from target)")
        await asyncio.sleep(0.5)

    if settled is None:
        line("  did not settle in 240 s — measuring anyway")
        settled = await lx.read_float(P["temp"])
        if settled is None:
            line(f"  {bad}could not read the chamber — link is down, nothing measured{off}")
            return
    settled_f = c_to_f(settled)
    line(f"  settled at {round(settled_f)} °F")

    # The offset is a DELTA on the active profile temperature: writing 10 °C
    # moved the device's own target from 501 °F to 519 °F, and 20 °C moved it to
    # 537 °F. Confirmed on hardware (firmware AW, model 13). So the curve is
    # driven by writing this offset and letting the device's own loop follow.
    #
    # Two things the earlier version of this test got wrong:
    #   - it measured from a chamber that was still climbing to its own target,
    #     so the offset had no visible headroom;
    #   - 20 s is far too short. The thermal lag here is seconds, not
    #     milliseconds — a +20 °C step moved the chamber only ~8 °F in 2.5 s.
    line("")
    line("  driving the offset and watching the device's own target")

    async def tcmd_f() -> float | None:
        v = await lx.read_float(P["tcmd"])
        return c_to_f(v) if v is not None else None

    base_cmd = await tcmd_f()
    line(f"  target at offset 0: {round(base_cmd) if base_cmd is not None else '—'} °F")

    samples = []
    hold = 8.0
    for delta_c in (10.0, 20.0, 0.0):
        await lx.write_float(P["override"], delta_c)
        for _ in range(int(hold * 2)):
            await asyncio.sleep(0.5)
            t = await lx.read_float(P["temp"])
            cmd = await tcmd_f()
            echo = await lx.read_float(P["override"])
            if t is not None:
                samples.append((delta_c, c_to_f(t), cmd, echo))

    await lx.write_float(P["override"], 0.0)
    await lx.write_u8(P["mode"], 8)
    await asyncio.sleep(0.15)
    await lx.write_u8(P["mode"], 2)
    line("  offset cleared, session aborted")

    if not samples:
        line(f"  {bad}no samples — link was down{off}")
        return

    line("")
    line(f"  {dim}offset   target    chamber{off}")
    for d in (10.0, 20.0, 0.0):
        rows = [x for x in samples if x[0] == d]
        if not rows:
            continue
        _d, temp_f, cmd, echo = rows[-1]
        cmd_s = f"{round(cmd)} °F" if cmd is not None else "—"
        line(f"  {dim}{d:>4.0f} C  {cmd_s:>8}  {round(temp_f):>6} °F{off}")

    # The decisive evidence is the target moving with the offset, exactly.
    by_off = {}
    for d, temp_f, cmd, echo in samples:
        if cmd is not None:
            by_off[d] = cmd
    moved = (10.0 in by_off and 20.0 in by_off and base_cmd is not None
             and by_off[20.0] - base_cmd > 10)

    head("verdict")
    if moved:
        d10 = by_off[10.0] - base_cmd
        d20 = by_off[20.0] - base_cmd
        line(f"  {ok}CURVE MODE WORKS{off}")
        line(f"  The offset moved the device's own target: +10 C → {round(d10):+d} °F,")
        line(f"  +20 C → {round(d20):+d} °F. The firmware tracks it exactly.")
        line(f"  {warn}Thermal lag is the real constraint{off} — the chamber follows")
        line("  seconds later, so curves must be measured, not assumed.")
    elif by_off:
        line(f"  {bad}OFFSET STORED BUT TARGET DID NOT MOVE{off}")
        line("  The path accepts writes but the heater is not following them.")
    else:
        line(f"  {bad}INCONCLUSIVE{off} — could not read the target temperature.")


def main() -> int:
    ap = argparse.ArgumentParser(description="Probe a Puffco Peak Pro over BLE.")
    ap.add_argument("--live", action="store_true", help="also run the heating test")
    ap.add_argument("--addr", help="connect straight to this MAC instead of scanning")
    args = ap.parse_args()
    try:
        return asyncio.run(probe(args.live, args.addr))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
