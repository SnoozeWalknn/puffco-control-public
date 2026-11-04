#!/usr/bin/env python3
"""Prove the tunnel's token gate: no token, wrong token, right token, and the
WebSocket upgrade path. No BLE, no bridge — the gate runs before either.

    .venv/bin/python tools/test_tunnel.py
"""

from __future__ import annotations

import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import tunnel  # noqa: E402

TOKEN = "test-token-abc123"
pass_n = 0
fail_n = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global pass_n, fail_n
    if cond:
        pass_n += 1
    else:
        fail_n += 1
        print(f"FAIL {name}" + (f"\n  {detail}" if detail else ""))


class FakeWriter:
    def __init__(self) -> None:
        self.buf = bytearray()
        self.closed = False

    def write(self, data: bytes) -> None:
        self.buf.extend(data)

    async def drain(self) -> None:
        return None

    def close(self) -> None:
        self.closed = True

    def status(self) -> int:
        line = bytes(self.buf).split(b"\r\n", 1)[0].decode("latin-1")
        return int(line.split(" ")[1])


async def request(path: str, token: str | None = TOKEN, upgrade: bool = False,
                  cookie: str | None = None) -> FakeWriter:
    reader = asyncio.StreamReader()
    head = [f"GET {path} HTTP/1.1", "Host: 127.0.0.1"]
    if token is not None:
        head.append(f"Authorization: Bearer {token}")
    if cookie is not None:
        head.append(f"Cookie: {tunnel.COOKIE}={cookie}")
    if upgrade:
        head.append("Upgrade: websocket")
        head.append("Connection: Upgrade")
        head.append("Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==")
    reader.feed_data(("\r\n".join(head) + "\r\n\r\n").encode())
    reader.feed_eof()
    writer = FakeWriter()
    await tunnel.handle(reader, writer, TOKEN)
    return writer


async def main() -> int:
    # The query-string form is what the printed URL uses.
    w = await request("/app.html?t=" + TOKEN)
    check("token in the query string is accepted", w.status() == 200, w.status())

    # A phone opening a link cannot set headers, but the header form is useful
    # for curl and for scripts.
    w = await request("/app.html", token=TOKEN)
    check("bearer header is accepted", w.status() == 200, w.status())

    w = await request("/app.html", token=None)
    check("no credentials at all is refused", w.status() == 401, w.status())

    w = await request("/app.html?t=wrong", token=None)
    check("a wrong token is refused", w.status() == 401, w.status())

    w = await request("/app.html?t=" + TOKEN[:-1], token=None)
    check("a near-miss token is refused", w.status() == 401, w.status())

    # The gate must come before the file resolver: an unauthenticated request
    # must not be able to tell an existing file from a missing one.
    w = await request("/does-not-exist.js", token=None)
    check("unauthenticated 404 becomes 401", w.status() == 401, w.status())

    # Traversal is refused even with a valid token.
    w = await request("/../tools/bridge.py?t=" + TOKEN)
    check("traversal is refused", w.status() == 404, w.status())

    # The WebSocket upgrade is the dangerous path: it proxies the bridge, which
    # is full device control.
    w = await request("/bridge", token=None, upgrade=True)
    check("websocket upgrade without a token is refused", w.status() == 401, w.status())

    w = await request("/bridge?t=" + TOKEN, upgrade=True)
    check("websocket upgrade with a token gets past the gate",
          w.status() != 401, w.status())

    # Sub-resources carry no query string: the cookie set on the first request
    # is what keeps app.js and app.css reachable.
    w = await request("/app.js", token=None, cookie=TOKEN)
    check("cookie authorises a sub-resource", w.status() == 200, w.status())

    w = await request("/app.js", token=None, cookie="wrong")
    check("a wrong cookie is refused", w.status() == 401, w.status())

    w = await request("/app.html?t=" + TOKEN)
    cookie_hdr = bytes(w.buf).decode("latin-1")
    check("the authorised response sets the session cookie",
          f"Set-Cookie: {tunnel.COOKIE}={TOKEN}" in cookie_hdr,
          cookie_hdr.split("\r\n")[:8])

    w = await request("/app.html", token=None)
    check("a refused response does not set a cookie",
          "Set-Cookie" not in bytes(w.buf).decode("latin-1"))

    print(f"\ntunnel: {pass_n} passed, {fail_n} failed")
    return 1 if fail_n else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
