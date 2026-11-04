#!/usr/bin/env python3
"""Serve the Peak app to your phone over the LAN, with the BLE bridge included.

Why this exists rather than `http.server --bind 0.0.0.0`:

  ui/ble.js hardcodes the bridge at ws://127.0.0.1:8792, which on a phone means
  the phone. So the page must be reachable on port 8791 *and* the bridge has to
  answer on the same origin. This is a small reverse proxy: plain HTTP for the
  files, and a WebSocket upgrade on /bridge relayed to tools/bridge.py.

    .venv/bin/python tools/tunnel.py --addr F0:AD:4E:41:5B:76

Open the printed URL on your phone. Ctrl-C stops the bridge too.

Exposure: everything the app can do, to every device on your LAN, with no
authentication. It controls a 600 F heater. Trusted networks only, never
port-forwarded.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import socket
import struct
import subprocess
import sys
from pathlib import Path

import websockets

ROOT = Path(__file__).resolve().parent.parent
UI = ROOT / "ui"
BRIDGE_PORT = 8792
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".ico": "image/x-icon",
}


def lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def resolve(path: str) -> Path | None:
    p = path.split("?", 1)[0].split("#", 1)[0]
    if p == "/":
        p = "/app.html"
    target = (UI / p.lstrip("/")).resolve()
    # Confine to ui/: without this a traversal would hand out the whole repo.
    try:
        target.relative_to(UI.resolve())
    except ValueError:
        return None
    return target if target.is_file() else None


def http_response(status: int, body: bytes, ctype="text/plain; charset=utf-8",
                  extra: dict | None = None) -> bytes:
    reason = {200: "OK", 400: "Bad Request", 404: "Not Found",
              502: "Bad Gateway"}.get(status, "ERROR")
    head = [f"HTTP/1.1 {status} {reason}",
            f"Content-Type: {ctype}",
            f"Content-Length: {len(body)}",
            "Cache-Control: no-store",
            "Connection: close"]
    for k, v in (extra or {}).items():
        head.append(f"{k}: {v}")
    return ("\r\n".join(head) + "\r\n\r\n").encode() + body


async def pump_client_to_upstream(reader: asyncio.StreamReader, ws) -> None:
    # Every exit is normal here: the browser closes the tab whenever it likes.
    """Browser WebSocket frames -> upstream socket.

    The browser has already been upgraded by us, so its frames arrive as
    WebSocket frames. Unmask them and forward the payload.
    """
    try:
        await _pump(reader, ws)
    except (asyncio.IncompleteReadError, ConnectionResetError, OSError):
        return



async def _pump(reader: asyncio.StreamReader, ws) -> None:
    while True:
        hdr = await reader.readexactly(2)
        fin = hdr[0] & 0x80
        op = hdr[0] & 0x0F
        masked = hdr[1] & 0x80
        ln = hdr[1] & 0x7F
        if ln == 126:
            ln = struct.unpack(">H", await reader.readexactly(2))[0]
        elif ln == 127:
            ln = struct.unpack(">Q", await reader.readexactly(8))[0]
        mask = await reader.readexactly(4) if masked else b"\0\0\0\0"
        payload = bytearray(await reader.readexactly(ln))
        for i in range(len(payload)):
            payload[i] ^= mask[i % 4]
        if op == 0x8:
            await ws.send(b"")
            return
        if op in (0x1, 0x0) and payload:
            # The bridge's control protocol is TEXT ("ping", "connect …"), and it
            # branches on isinstance(message, str). Forwarding these as bytes made
            # them fall through its binary path and vanish.
            await ws.send(payload.decode("utf-8", "replace"))
        elif op == 0x2 and payload:
            await ws.send(bytes(payload))
        elif op == 0x9:
            pass  # browser ping; the bridge does not need it


async def pump_upstream_to_client(ws, writer: asyncio.StreamWriter) -> None:
    """Upstream bytes -> browser, framed as a WebSocket message.

    Text stays text (the bridge's control frames) and binary stays binary (its
    protocol frames), because the client distinguishes them by frame type.
    """
    try:
        async for msg in ws:
            await _send_frame(writer, msg)
    except (ConnectionResetError, OSError, websockets.exceptions.ConnectionClosed):
        return


async def _send_frame(writer, msg) -> None:
    is_text = isinstance(msg, str)
    data = msg.encode() if is_text else msg
    opcode = 0x81 if is_text else 0x82
    n = len(data)
    if n < 126:
        frame = bytes([opcode, n]) + data
    elif n < 65536:
        frame = bytes([opcode, 126]) + struct.pack(">H", n) + data
    else:
        frame = bytes([opcode, 127]) + struct.pack(">Q", n) + data
    writer.write(frame)
    await writer.drain()


async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        raw = await reader.readuntil(b"\r\n\r\n")
    except Exception:
        writer.close()
        return
    lines = raw.decode("latin-1").split("\r\n")
    try:
        method, path, _ = lines[0].split(" ", 2)
    except ValueError:
        writer.write(http_response(400, b"bad request\n"))
        await writer.drain()
        writer.close()
        return
    headers = {}
    for ln in lines[1:]:
        if ":" in ln:
            k, v = ln.split(":", 1)
            headers[k.strip().lower()] = v.strip()

    if method != "GET":
        writer.write(http_response(400, b"GET only\n"))
        await writer.drain()
        writer.close()
        return

    # ---- WebSocket bridge ----
    if headers.get("upgrade", "").lower() == "websocket":
        key = headers.get("sec-websocket-key")
        try:
            ws = await websockets.connect(f"ws://127.0.0.1:{BRIDGE_PORT}",
                                          open_timeout=5, max_size=None)
        except Exception as e:
            writer.write(http_response(502, f"bridge not reachable: {e}\n".encode()))
            await writer.drain()
            writer.close()
            return
        accept = base64.b64encode(
            hashlib.sha1((key + GUID).encode()).digest()).decode()
        writer.write(("HTTP/1.1 101 Switching Protocols\r\n"
                      "Upgrade: websocket\r\n"
                      "Connection: Upgrade\r\n"
                      f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode())
        await writer.drain()
        # Swallow per-direction errors: a browser closing the tab mid-frame is
        # normal and must not surface as a traceback.
        try:
            await asyncio.wait(
                [asyncio.create_task(pump_client_to_upstream(reader, ws)),
                 asyncio.create_task(pump_upstream_to_client(ws, writer))],
                return_when=asyncio.FIRST_COMPLETED)
        except (asyncio.IncompleteReadError, ConnectionResetError, Exception):
            pass
        finally:
            await ws.close()
            writer.close()
        return

    # ---- static files ----
    if path == "/health":
        body, ctype = b"ok\n", "text/plain; charset=utf-8"
    else:
        target = resolve(path)
        if target is None:
            body, ctype = b"not found\n", "text/plain; charset=utf-8"
            writer.write(http_response(404, body, ctype))
            await writer.drain()
            writer.close()
            return
        body = target.read_bytes()
        ctype = TYPES.get(target.suffix, "application/octet-stream")
    writer.write(http_response(200, body, ctype))
    await writer.drain()
    writer.close()


def banner(ip: str, port: int) -> None:
    url = f"http://{ip}:{port}/app.html?bridge=1"
    print()
    print("  " + "=" * 70)
    print("   Peak app on your LAN — full device control, no authentication")
    print("  " + "=" * 70)
    print(f"   {url}")
    print()
    print("   Open it on your phone. The BLE bridge is proxied on the same")
    print("   origin, so there is no second port and no flag to remember.")
    print()
    print("   If the page loads but Connect hangs, it is the secure-context")
    print("   rule: plain http on a LAN IP is not a secure context in Chrome")
    print("   for Android. Tell me and I will front it with HTTPS.")
    print()
    print("   Anyone on this network can start a 600 F session. Ctrl-C stops.")
    print("  " + "=" * 70)
    print()


async def main_async(args) -> int:
    bridge = subprocess.Popen(
        [sys.executable, str(ROOT / "tools" / "bridge.py"),
         "--addr", args.addr, "--idle-timeout", "30"],
        cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    await asyncio.sleep(1.2)
    if bridge.poll() is not None:
        print("the BLE bridge exited immediately — run tools/bridge.py alone to see why")
        return 1
    server = await asyncio.start_server(handle, "0.0.0.0", args.port)
    banner(lan_ip(), args.port)
    try:
        async with server:
            await server.serve_forever()
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        server.close()
        bridge.terminate()
        try:
            bridge.wait(timeout=5)
        except Exception:
            bridge.kill()
        print("\nstopped")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="LAN tunnel for the Peak app + BLE bridge")
    ap.add_argument("--addr", required=True, help="Peak MAC")
    ap.add_argument("--port", type=int, default=8791)
    args = ap.parse_args()
    try:
        return asyncio.run(main_async(args))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
