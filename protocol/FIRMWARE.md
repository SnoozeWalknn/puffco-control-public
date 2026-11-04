# Puffco firmware — what was obtained, what it is, what it isn't

Investigated 2026-11-04. Read this before attempting anything with the image.

## How to get the image

The OTA endpoint is live and needs three headers, all discoverable from the app:

```
GET https://api.puffco.app/api/ota/latest?model=13
  x-app-platform: Web
  x-app-type:     puffco-app
  x-app-version:  3.8.5        # anything >= the minimum the API states
```

`model` is the gateway to a firmware, **not** `serialNumber` and not
`modelCode`. Models 10-13 return the same record; everything else returns
`No firmware found.`

The API validates and names its own requirements, so it is easy to walk:
missing headers return 403 with the exact list, and `model=13` returns:

```json
{"version": "G", "url": "https://assets.puffco.app/ota/df30c638-....puff"}
```

Note the app version it reports as current: **Web 3.8.5, Android 3.13.31**. The
2.4.3 bundle this repo once decoded was ~5 versions stale, and the live paths it
was missing (`thc/intn`, `thc/phcl`) are downstream of that gap.

## What the file is

204,056 bytes. Verified **intact**:

| field | offset | value |
|---|---|---|
| id | 0x00 | `0x4db49d0b` |
| flags | 0x04 | `0` |
| length | 0x08 | 204,040 |
| flash addr | 0x0c | `0x0800a000` (Cortex-M flash window) |
| block len | 0x10 | `0x98` (152) |
| body | 0x14… | opaque |
| crc32 | last 4 | `0xfce81558`, matches `zlib.crc32(body)` |

### The container check is only a CRC `[decompiled]`

From the Android 3.13.31 build (`isOtaValid`):

```js
isOtaValid(buf) {
  if (buf.length < 4) return false;
  const body = buf.slice(0, buf.length - 4);
  const tail = buf.slice(-4);
  return crc32(body) === tail.readInt32LE(0);
}
```

There is **no signature and no key check** in the client. A modified image would
pass this test. That is a finding about the client, not a licence to flash.

### The payload is not readable as-is

- **entropy 7.999 bits/byte** over the whole body — indistinguishable from random
- **no Cortex-M vector table** anywhere in 204 KB (a real flash image starts with
  `SP` in `0x20000000-0x2004xxxx` and an odd reset vector in `0x08000000+`)
- no zlib/gzip stream at any offset in the first 400 bytes
- 16-byte blocks are all unique, so not ECB

So the body is either encrypted with a key the client never sees, or stored in a
form this investigation could not frame. **The CRC only proves transport
integrity.**

## Why the key is not in the app

The only AES in either client is `AES-CTR` and its key is a **parameter**, not a
constant — it decrypts *broadcast advertising data* supplied by the device, in
`decryptPayloadWithAesCtr(keyBytes, counterU32, payload)` with the counter built
as a 16-byte block with the u32 at offset 12. Nothing in the app decrypts `.puff`.

If the payload is encrypted, the key is on the device and the decrypt happens
there, which is exactly why the file is served publicly.

## What the device itself exposes `[hardware]`

Read live from the unit, which puts an upper bound on what any image holds:

| path | result |
|---|---|
| `/p/sys/fw/gith` | `1d90ae1` — the running build's git hash |
| `/p/sys/fw/bver` | `0x27` = **39** — bootloader revision |
| `/p/sys/fw/ver` | `AW` (49 by the base-26 compare) |
| `/p/sys/fw/lver`, `/p/sys/fw/hash`, `/p/sys/fw/sig`, `/p/sys/fw/key`, `/p/sys/hw/key`, `/p/sys/fw/type` | all absent — every one raises |

So there is **no device-side key or signature surface** reachable over Lorax. If
an image is encrypted, the material is inside the application region itself and
is not exported by any known path.

The device reports its own build hash, which is the useful lever for later: a
flash is verifiable by comparing `gith` before and after, without trusting the
transfer.

## Last structural detail: the payload is a whole number of cipher blocks

The 20-byte header is followed by a blob of exactly **204,032 bytes = 12,752 ×
16**, with the CRC32 after it. So the encrypted region is 16-byte aligned and
the header is *outside* it — the layout of something produced by a block cipher
or a CTR stream, not of a packed binary.

Every hypothesis that would make the contents readable has now been tested and
failed: not zlib/gzip/raw-deflate at any offset, not ECB (all 12,752 blocks
unique), not plaintext code (no vector table, no zero-spike, no strings), and
not a container the client unpacks — the client's only use of the bytes is a
CRC32 check followed by handing them to the device.

## Why "fully reverse engineer it" is not reachable from here

Stated plainly so a future session does not restart this from scratch:

- the payload is **statistically random** (7.999 bits/byte, 0.38 % adjacent
  equal bytes against a 0.39 % random expectation, no zero-spike, no strings
  beyond coincidence, no vector table)
- a CRC32 trailer is the **only** integrity check, client-side, and it verifies
- the client has no `.puff` decryptor; its one AES is CTR over broadcast data
  with the key supplied at runtime
- the device exposes no key, signature or plaintext-version surface
- **no key is known or derivable from the material in this repo**

Producing real strings, function boundaries or a control-loop disassembly from
this 204 KB blob is not achievable honestly. Anyone reporting otherwise from
this file is guessing.

## Status

| Question | Answer | Confidence |
|---|---|---|
| Can the image be obtained? | Yes, via `?model=13` | 100 |
| Is the file intact? | Yes, CRC32 verified | 100 |
| Is it signed by the client's check? | No, CRC only | 95 |
| Is the payload readable? | No | 90 |
| Where would the key be? | Device side, or not encrypted at all | 40 |

**Treat the image as undecoded.** Do not write it to a device. A failed flash on
this unit is not recoverable without a known-good image, and we do not have one
in a form we understand.

The objective as worded — pull the firmware **and fully reverse engineer it** —
is therefore **partly achieved**: pulled and container-decoded, payload not
reversed. What the firmware actually does is better established from its
observable behaviour over BLE, which is what `PROTOCOL.md` and the working
controller already encode.
