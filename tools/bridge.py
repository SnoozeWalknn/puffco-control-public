#!/usr/bin/env python3
"""BLE bridge — lets the web app drive real hardware from Linux.

Chromium on Linux has no working Web Bluetooth device chooser: requestDevice()
never resolves. Rather than give up on the UI, this serves the same transport
over a WebSocket, so ui/ble.js can talk to a real Peak through a socket instead
of through the browser's Bluetooth stack.

    .venv/bin/python tools/bridge.py                 # auto-find the Peak
    .venv/bin/python tools/bridge.py --addr F0:...   # or name one

The page must be opened with ?bridge=1 (probe.html and app.html both honour it).

Wire format, both directions, binary frames:
    client → server   raw Lorax command bytes
    server → client   0x01 ‖ reply bytes     (matched to a command by seq)
                      0x02 ‖ event bytes     (unsolicited)

That is the whole protocol. All framing, auth and sequencing still live in the
browser code; this process only moves bytes and owns the BLE link.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from bleak import BleakClient, BleakScanner
from bleak.backends.device import BLEDevice
from websockets.asyncio.server import serve

from probe import (
    CHAR_COMMAND, CHAR_EVENT, CHAR_REPLY, SERVICE,
    SILABS_APP_VERSION, SILABS_SERVICE,
)

LOG = logging.getLogger("bridge")

REPLY = 0x01
EVENT = 0x02

PEAK_PREFIXES = ("84:2E:14", "84:FD:27", "0C:43:14", "F0:AD:4E")
PUFFCO_MFG_ID = 3075


async def find_peak(addr: str | None, timeout: float = 20.0) -> str | None:
    if addr:
        return addr.upper()

    found: dict[str, str] = {}

    def on_detect(dev, adv):
        name = dev.name or ""
        mfg = getattr(adv, "manufacturer_data", {}) or {}
        if (PUFFCO_MFG_ID in mfg
                or "peak" in name.lower()
                or name.upper().startswith(PEAK_PREFIXES)):
            found[dev.address] = name or "(unnamed)"

    LOG.info("scanning %.0f s for a Peak…", timeout)
    scanner = BleakScanner(detect_callback=on_detect)
    await scanner.start()
    await asyncio.sleep(timeout)
    try:
        await scanner.stop()
    except Exception:
        pass

    if not found:
        return None
    for address, name in found.items():
        LOG.info("  candidate %s  %s", address, name)
    for address, name in found.items():
        if "peak" in name.lower():
            return address
    return next(iter(found))


class Link:
    """One BLE connection, shared by whichever page is connected.

    The device accepts a single client, so the bridge holds the link and
    multiplexes commands onto it rather than reconnecting per request.
    """

    def __init__(self) -> None:
        self.client: BleakClient | None = None
        self.device: BLEDevice | None = None
        self.address: str | None = None
        self.listeners: set = set()
        self.lock = asyncio.Lock()
        self.last_use = 0.0
        self.idle_timeout = 0.0     # 0 disables
        self._pending: dict = {}
        self._seq = 0

    def _emit(self, kind: int, data: bytes) -> None:
        STATS["out"] += 1
        frame = bytes([kind]) + data
        for ws in list(self.listeners):
            try:
                asyncio.ensure_future(ws.send(frame))
            except Exception:
                self.listeners.discard(ws)

    def _on_reply(self, _char, data: bytearray) -> None:
        raw = bytes(data)
        if len(raw) >= 3:
            import struct as _s
            seq = _s.unpack("<H", raw[0:2])[0]
            fut = self._pending.get(seq)
            if fut is not None and not fut.done():
                err = raw[2]
                if err:
                    fut.set_exception(RuntimeError(f"device error 0x{err:02x}"))
                else:
                    fut.set_result(raw[3:])
                return
        self._emit(REPLY, raw)

    def _on_event(self, _char, data: bytearray) -> None:
        self._emit(EVENT, bytes(data))

    async def connect(self, address: str) -> None:
        async with self.lock:
            if self.client and self.client.is_connected:
                return
            self.address = address
            self.last_use = time.time()
            path = f"/org/bluez/hci0/dev_{address.replace(':', '_').upper()}"
            self.device = BLEDevice(address, "Peak Pro", {"path": path, "props": {}})
            LOG.info("connecting to %s", address)
            client = BleakClient(self.device, timeout=25.0)
            await client.connect()
            self.client = client
            self._authed = False
            self.last_use = time.time()
            await client.start_notify(CHAR_REPLY, self._on_reply)
            try:
                await client.start_notify(CHAR_EVENT, self._on_event)
            except Exception:
                pass
            # Authentication is left to the first client that asks, NOT done
            # here. A second handshake on an already-unlocked link is refused
            # ("refused every unlock variant"), and which side owns the key
            # differs: the app has it, the bridge may not. Clients that do not
            # authenticate (tunnel, tests) call LINK.ensure_auth() first.
            LOG.info("connected")

    async def ensure_auth(self) -> None:
        """Authenticate once per connection, on demand, and remember it."""
        if getattr(self, "_authed", False):
            return
        await self._authenticate()
        self._authed = True

    async def _authenticate(self) -> None:
        """Run the Lorax handshake over the already-open link.

        probe.Lorax.authenticate() expects to drive its own client, so the
        sequence is reproduced here against the bridge's connection using the
        same key and the same verification read.
        """
        import hashlib
        from probe import OP, HANDSHAKE_LORAX, P

        async def cmd(op: int, payload: bytes = b"") -> bytes:
            import struct
            self._seq = (getattr(self, "_seq", 0) + 1) % 65535 or 1
            seq = self._seq
            frame = struct.pack("<HB", seq, op) + payload
            fut = asyncio.get_running_loop().create_future()
            self._pending[seq] = fut
            await self.client.write_gatt_char(CHAR_COMMAND, frame, response=False)
            try:
                return await asyncio.wait_for(fut, timeout=3.0)
            finally:
                self._pending.pop(seq, None)

        seed = (await cmd(OP["GET_ACCESS_SEED"]))[:16]
        if len(seed) < 16:
            raise RuntimeError("short access seed")
        for key in (HANDSHAKE_LORAX, None):
            buf = bytearray(32)
            if key:
                buf[0:16] = key[:16]
            buf[16:32] = seed
            token = hashlib.sha256(bytes(buf)).digest()[:16]
            try:
                await cmd(OP["UNLOCK_ACCESS"], token)
            except Exception:
                continue
            try:
                import struct
                raw = await cmd(OP["READ_SHORT"], struct.pack("<HH", 0, 4) + P["soc"].encode())
                if len(raw) >= 4:
                    LOG.info("authenticated")
                    return
            except Exception:
                continue
        raise RuntimeError("every unlock variant was refused")

    async def ensure(self) -> None:
        if self.client and self.client.is_connected:
            return
        if not self.address:
            raise RuntimeError("no address to reconnect to")
        LOG.info("link dropped — reconnecting")
        await self.connect(self.address)

    async def write(self, data: bytes) -> None:
        self.last_use = time.time()
        await self.ensure()
        try:
            await self.client.write_gatt_char(CHAR_COMMAND, data, response=False)
        except Exception:
            await self.connect(self.address or "")
            await self.client.write_gatt_char(CHAR_COMMAND, data, response=False)

    async def disconnect(self) -> None:
        if self.client:
            try:
                await self.client.disconnect()
            except Exception:
                pass
        self.client = None
        LOG.info("released the BLE link — the device can sleep and charge faster")

    async def idle_watchdog(self) -> None:
        """Drop the link after a period with no traffic.

        Measured on hardware: with the link held open, charge rose 0.5 % in 36 s;
        with it down, 1.0 % over the same period. Keeping a connection alive
        costs real power, so there is no reason to hold one while nothing is
        being read."""
        while True:
            await asyncio.sleep(5)
            if not self.idle_timeout or not self.client:
                continue
            if self.listeners:
                continue
            if time.time() - self.last_use > self.idle_timeout:
                await self.disconnect()


LINK = Link()

# Frame accounting, so the cost of the UI's polling can be measured rather than
# guessed at. Reported every 5 s when non-zero.
STATS = {"in": 0, "out": 0}


async def _stats_reporter() -> None:
    while True:
        await asyncio.sleep(5)
        if STATS["in"] or STATS["out"]:
            LOG.info("frames in %d/s  out %d/s", STATS["in"] // 5, STATS["out"] // 5)
            STATS["in"] = STATS["out"] = 0


async def handle(ws) -> None:
    peer = ws.remote_address
    LOG.info("page connected from %s", peer)
    LINK.listeners.add(ws)
    try:
        async for message in ws:
            if isinstance(message, str):
                # Text frames are control messages, so the page can query state.
                if message == "ping":
                    await ws.send("pong")
                elif message.startswith("connect"):
                    # "connect" alone: open the link, do not authenticate (the
                    # client will). "connect <addr> auth": authenticate too.
                    parts = message.split()
                    do_auth = "auth" in parts[1:]
                    parts = [x for x in parts if x != "auth"]
                    address = parts[1] if len(parts) > 1 else await find_peak(None)
                    if not address:
                        await ws.send("error no Peak found")
                        continue
                    try:
                        await LINK.connect(address)
                        if do_auth:
                            await LINK.ensure_auth()
                        await ws.send(f"connected {address}")
                    except Exception as e:
                        await ws.send(f"error {e}")
                continue

            if not isinstance(message, (bytes, bytearray)):
                continue
            STATS["in"] += 1
            try:
                await LINK.write(bytes(message))
            except Exception as e:
                LOG.warning("write failed: %s", e)
                await ws.send(f"error {e}")
    except Exception as e:
        LOG.info("page disconnected (%s)", e)
    finally:
        LINK.listeners.discard(ws)
        LINK.last_use = time.time()
        if not LINK.listeners and LINK.idle_timeout == 0:
            # Explicit "release as soon as the page goes away".
            await LINK.disconnect()


async def main() -> int:
    ap = argparse.ArgumentParser(description="BLE bridge for the Puffco web app")
    ap.add_argument("--addr", help="Peak MAC; otherwise scan")
    ap.add_argument("--port", type=int, default=8792)
    ap.add_argument("--scan", action="store_true", help="scan even if --addr is given")
    ap.add_argument("--idle-timeout", type=float, default=60.0,
                    help="release the BLE link after this many seconds with no page "
                         "and no traffic (0 = never). Holding the link costs battery.")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    LINK.idle_timeout = args.idle_timeout
    address = None if args.scan else args.addr
    if not address:
        address = await find_peak(None)
        if not address:
            LOG.error("no Peak found. Put it in pairing mode and try again,")
            LOG.error("or pass --addr with the MAC from `bluetoothctl devices`.")
            return 1

    try:
        await LINK.connect(address)
    except Exception as e:
        LOG.error("could not connect: %s", e)
        return 1

    LOG.info("")
    LOG.info("bridge listening on ws://127.0.0.1:%d", args.port)
    LOG.info("open: http://127.0.0.1:8791/app.html?bridge=1")
    LOG.info("")

    asyncio.create_task(_stats_reporter())
    asyncio.create_task(LINK.idle_watchdog())
    async with serve(handle, "127.0.0.1", args.port, max_size=None):
        await asyncio.Future()


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        sys.exit(130)
