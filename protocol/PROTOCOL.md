# Puffco Peak Pro / Proxy — BLE protocol notes for a third-party app

Sources, in order of authority:

| Tag | Meaning |
|---|---|
| **[bundle]** | read from Puffco's own web app (`puffco.app_2.4.3_deobfuscated.js`, 6.0 MB, `reference/`) |
| **[lib]** | corroborated by independently written community Python clients for this device |
| **[writeup]** | a public reverse-engineering writeup for the same device |
| **[unverified]** | inferred, plausible, **not** confirmed on hardware |

Nothing here is confirmed on a device by us. Every row marked **[unverified]** is a
30-second test once hardware is on the bench.

---

## 1. Two generations, one app

Puffco ships two incompatible transports. Which one a unit speaks is decided by firmware.

| | Flat GATT ("pikachu") | Lorax (path-based) |
|---|---|---|
| Firmware | older, and all pre-`X` units | `X` and later; `AG+` current **[lib]** |
| Service | `06caf9c0-74d3-454f-9be9-e30cd999c17a` | `e276967f-ea8a-478a-a92e-d78f5dd15dd5` |
| Shape | one characteristic per field, base `f9a98c15-c651-4f34-b656-d100bf5800XX` | 4 characteristics, addressing by **path string** |
| Values | little-endian `float32` per characteristic | typed per path: `FLOAT`, `U_INT_8/16/32`, `STRING`, `BUFFER` **[bundle]** |
| Auth | seed → `sha256(HANDSHAKE ‖ seed)` → write back to `…00E0` | same idea, different key |

An app must probe, not guess: connect, ask for the Lorax service; if absent, fall back to
flat. The official app tries Lorax first and logs `Peak is using Lorax protocol version N`
**[bundle]**.

### Lorax characteristics **[bundle]**

| Role | UUID |
|---|---|
| Version | `05434bca-cc7f-4ef6-bbb3-b1c520b9800c` |
| Command (write) | `60133d5c-5727-4f2c-9697-d842c5292a3c` |
| Reply (notify) | `8dc5ec05-8f7d-45ad-99db-3fbde65dbd9c` |
| Event (notify) | `43312cd1-7d34-46ce-a7d3-0a98fd9b4cb8` |

Opcode table (from the bundle's `{getAccessSeed:0, unlockAccess:1, getLimits:2, ackEvents:3,
readShort:16, writeShort:17, statShort:18, unlink:19, open:32, read:33, write:34, watch:35,
unwatch:36, stat:37, close:38}`):

- `getLimits` returns `{maxPayload:u16@0, maxFiles:u16@2, maxCommands:u16@4}` — **transport**
  limits only. It does **not** report temperature bounds. Those are enforced device-side.
- `readShort` / `writeShort` are the whole API for short values: the path plus a typed payload.
- `read` / `write` / `watch` / `stat` / `open` / `close` are the file-handle API (bulk transfers:
  firmware images, logs).
- Commands carry a sequence id and are matched to replies; the app prunes stale handles after
  1200 ms **[lib]**.

### Discovery

| Signal | Value |
|---|---|
| Flat service | `06caf9c0-74d3-454f-9be9-e30cd999c17a` |
| Lorax service | `e276967f-ea8a-478a-a92e-d78f5dd15dd5` |
| Manufacturer data id | `3075` (`0x0C03`) **[lib]** |
| MAC prefixes seen | `84:2E:14:`, `84:FD:27:`, `0C:43:14:`, `F0:AD:4E:` **[lib]** |
| Default name | MAC with the colons stripped (12 hex chars) **[lib]** |

For Web Bluetooth, filter on both service UUIDs — the OS chooser then lists Puffco and any
other device family in one picker, which is the whole "pick a device, get its UI" UX.

---

## 2. Authentication

Firmware `X` added a handshake; without it almost every read and write is refused
**[writeup]**, **[lib]**.

```
seed  = read(0xE0 / /p/sys/… seed path)      # 16 bytes, different every connection
key   = sha256( HANDSHAKE_KEY[16] ‖ seed[16] )[:16]
write(0xE0, key)                              # then read/write is unlocked
```

Two hardcoded handshake keys exist, one per generation:

| Key | Bytes |
|---|---|
| flat | 16-byte constant, likewise omitted |
| Lorax | 16-byte constant extracted from Puffco's app; omitted here |

A third variant exists — `sha256(0¹⁶ ‖ seed)` with the first half zeroed — and the app uses it
in some paths **[lib]** (`create_lorax_auth_token_seed_only`). Which one applies when is
**[unverified]**; the safe implementation tries the documented one, verifies by reading a known
path, and only then reports "connected".

---

## 3. Field map

Flat offset in brackets; Lorax path in the right column. Types from the bundle.

### Chamber type codes (authoritative: Puffco's own bundle)

| Code | Meaning |
|---|---|
| 0 | none |
| 1 | classic |
| 2 | **XL / 3DXL** |
| 3 | performance |

The community Python client lists `HERBAL = 2, XL = 4`. **That is wrong** —
it has 2 and 4 swapped, and following it makes a 3DXL report as a herbal
chamber. A Peak Pro 3DXL V2 reports **2**.

### Device / identity
| Field | Flat | Lorax | Type |
|---|---|---|---|
| Manufacturer | `2A29` | — | string |
| Model code | `2A24` | `/p/sys/hw/mdcd` | u32 / string |
| Serial | `2A25` | `/p/sys/hw/ser` | string |
| HW rev | `2A27` | `/p/sys/hw/ver` | string |
| FW rev | `2A28` | `/p/sys/fw/ver` | u32 (revision string, e.g. `AW`) |
| FW git hash | `02` | `/p/sys/fw/gith` | string |
| Name | `4D` | `/u/sys/name` | string (29 chars flat / 26 PUP) |
| Birthday | `4E` | `/u/sys/bday` | u32 |
| Mfg date | `00` | `/p/sys/mfgd` | u32 |
| BT MAC | — | `/p/sys/bt/mac` | string |
| Uptime | `35` | `/p/sys/uptm` | float s |
| Clock | `44` | `/p/sys/time` | u32 |

### Session / heater
| Field | Flat | Lorax | Type |
|---|---|---|---|
| Operating state | `22` | `/p/app/stat/id` | u8 (see enum below) |
| Elapsed in state | `23` | `/p/app/stat/elap` | float s |
| Total state time | `24` | `/p/app/stat/tott` | float s |
| Chamber temp | `25` | `/p/htr/temp` | float °C |
| **Temp command** | `26` | `/p/htr/tcmd` | float °C |
| **Temp override** | `45` | `/p/app/tmpo` | float °C — **delta**, see §5 |
| **Time override** | `46` | `/p/app/timo` | float s — **remaining**, see §5 |
| Mode command | `40` | `/p/app/mc` | float32 (flat) / u8 (Lorax) |
| Active heat cycle | `41` | `/p/app/hcs` | u32 |
| New heat cycle | `60` | `/p/app/nhc` | u32 |
| Chamber type | `3F` | `/p/htr/chmt` | u8 |
| Stealth | `42` | `/u/app/ui/stlm` | u8 |

Operating states **[bundle]**: `0` init memory, `1` version display, `2` battery display,
`3` master off, `4` sleep, `5` idle, `6` temp select, `7` preheat, `8` active, `9` fade,
`10` version display, `11` battery display, `12` factory test, `13` bonding.

Mode commands **[writeup]**, **[bundle]**: `0` master off, `1` sleep, `2` idle,
`3` temp-select begin, `4` temp-select stop, `5` show battery, `6` show version,
`7` heat-cycle start, `8` heat-cycle abort, `9` heat-cycle boost, `10` factory test,
`11` bonding.

### Heater telemetry — **not shown by the official app** **[bundle]**
`/p/htr/pwr` W, `/p/htr/duty`, `/p/htr/vavg`, `/p/htr/iavg`, `/p/htr/stet`,
`/p/htr/res` Ω. This is the closed-loop state: it makes a real power/temperature graph
possible instead of a single number.

### Profiles
| Field | Flat | Lorax | Type |
|---|---|---|---|
| Profile selector (app) | `61` | — | u32 |
| Profile selector (device) | `41` | `/p/app/hcs` | u32 |
| Name | `62` | `/u/app/hc/%N/name` | string (31 chars) |
| Temp | `63` | `/u/app/hc/%N/temp` | float °C |
| Time | `64` | `/u/app/hc/%N/time` | float s |
| Colour | `65` | `/u/app/hc/%N/colr` | buffer |
| Pattern speed | `66` | `/u/app/hc/%N/scpd` | buffer |
| Boost temp | `67` | `/u/app/hc/%N/btmp` | float °C |
| Boost time | `68` | `/u/app/hc/%N/btim` | float s |
| Threshold temp | `69` | `/u/app/hc/%N/thrt` | float °C |
| Preheat colour | `6A` | `/u/app/hc/%N/phcl` | buffer |
| Active colour | `6B` | `/u/app/hc/%N/accl` | buffer |

`MAX_HEAT_PROFILES: 25` next to `MAX_HEAT_PROFILES_UNVERIFIED: 4` in the bundle means the app
believes newer firmware stores 25 cycles. **Test this first** — if true, it is the single
biggest feature the official app leaves on the table (4 profiles → 25).

### Lantern / LEDs
`/p/app/ltrn/cmd` (u8 on/off), `/p/app/ltrn/colr` (buffer), `/p/app/ltrn/time` (float s,
max 7200), `/p/app/ltrn/scpd` (buffer), `/p/app/ltrn/remt` (float s remaining),
`/u/app/ui/lbrt` (buffer — four brightness segments: ring, under-glass, main, battery),
`/p/app/led/aclr`, `/p/app/led/pclr`, `/u/app/led/{aa,ca,oa}/` (animation scratchpads).

Colour modes **[writeup]**: `0` preserve, `1` static, `5` breathing, `6` rising,
`7` circling, `0x15` circling slow. Animation tempo caps at 480 colour changes/minute
**[bundle]**.

### Battery
`/p/bat/soc` %, `/p/bat/volt`, `/p/bat/curr`, `/p/bat/temp`, `/p/bat/cap`,
`/p/bat/chg/stat`, `/p/bat/chg/etf` (ETA to full), `/p/bat/chg/elap`, `/p/bat/chg/src`,
`/p/bat/chg/iout`, `/u/bat/msoc`.
Charge states: `0` bulk, `1` top-up, `2` full, `3` over-temp, `4` disconnected.

### Counters — the "device knows more than the app shows" bucket
`/p/app/odom/0/nc` total cycles, `/p/app/odom/0/tm` total heat time, `/p/app/odom/1/nc`
**trip** cycles, `/p/app/odom/1/tm` **trip** time, `/p/app/info/dpd` dabs/day,
`/p/app/info/drem` dabs remaining, `/p/magm/bfld` magnetic field.

### Logs
`/p/logv/aud/{begn,sel,entr,curr,end}` audit log; `/p/logv/flt/…` fault log. These are
handle-based reads (`open`/`read`/`close`), i.e. bulk transfers — a fault history view is
possible but is a separate build.

### Factory / tuning — do not expose casually
`/p/app/facr` factory reset, `/p/app/bt/delb` delete bondings, `/p/app/bt/tba` trigger bond,
`/p/htr/tun/{pco,ico,dco}` PID coefficients, `/p/htr/tun/{dft,stdt,sthc,msf}` thermal model.
The flat equivalents are `E1`–`E7`. Writing these changes how the heater behaves; a wrong
coefficient is a safety issue, not a preference. Keep them behind an explicit expert gate or
leave them out.

---

## 4. What the official app does

Feature inventory from the bundle, so nothing is missed when porting:

| Feature | Paths |
|---|---|
| Connect / bond / auth | seed + unlock, Silabs OTA service read to trigger bonding |
| Device info, rename | `/u/sys/name`, `/p/sys/*` |
| Session start / abort | `/p/app/mc` (7 / 8 → then 2) |
| Live session screen | `/p/app/stat/*`, `/p/htr/temp`, `/p/htr/tcmd` |
| **Boost during session** | `/p/app/tmpo`, `/p/app/timo` — see §5 |
| Profiles (name, temp, time, colour, speed, boost, threshold, preheat colour) | `/u/app/hc/%N/*` |
| Profile selector | `/p/app/hcs` |
| Lantern (colour, mode, speed, brightness, timer, remaining) | `/p/app/ltrn/*`, `/u/app/ui/lbrt` |
| Stealth mode | `/u/app/ui/stlm` |
| Ready mode | `/u/app/rdym/hc` |
| Battery + charge ETA | `/p/bat/*` |
| Odometer, dabs/day | `/p/app/odom/*`, `/p/app/info/*` |
| Firmware update | Silabs OTA service `1d14d6ee-…`, app version `0d77cc11-…` |
| Cleaning reminder | app-side only |

---

## 5. Complete decoded surface (static, from the bundle)

Everything in §5–§8 was read out of `reference/puffco_app_2.4.3.js` and the
community library. Rows are tagged `[bundle]` (Puffco's own code) or `[lib]`.
Where a value was later confirmed on hardware it says so.

### 5.1 Operating-state machine — `[bundle]`

`/p/app/stat/id` (u8). `meetsMinimumFirmware` — see §7 — only gates which of
these the app reacts to.

| Value | Name | Meaning |
|---|---|---|
| 0 | `INIT_MEMORY` | boot |
| 1 | `INIT_VERSION_DISP` | boot |
| 2 | `INIT_BATTERY_DISP` | boot |
| 3 | `MASTER_OFF` | off (`mc` 0) |
| 4 | `SLEEP` | asleep (`mc` 1) |
| 5 | `IDLE` | idle (`mc` 2) |
| 6 | `TEMP_SELECT` | profile picker running (`mc` 3 → 4) |
| 7 | `HEAT_CYCLE_PREHEAT` | climbing to target |
| 8 | `HEAT_CYCLE_ACTIVE` | on target, session running |
| 9 | `HEAT_CYCLE_FADE` | session over, cooling |
| 10 | `VERSION_DISP` | shows version (`mc` 6) |
| 11 | `BATTERY_DISP` | shows battery (`mc` 5) |
| 12 | `FACTORY_TEST` | `mc` 10 |
| 13 | `BLE_BONDING_` | `mc` 11 |

A full cycle is **7 → 8 → 9 → 5**. `8` is the only state in which the offset
does anything useful.

### 5.2 Session lifecycle, exactly as the app drives it `[bundle]`

```
startDabbing(slot):  write /p/app/hcs = slot      (select)
                     write /p/app/mc  = 7         (heatCycleStart)
stopDabbing():       write /p/app/mc  = 8         (heatCycleAbort)
                     write /p/app/mc  = 2         (idle)
```

Note the app **selects the profile first** (`/p/app/hcs`, `041`). A client that
writes `mc = 7` without selecting runs whatever slot happens to be current —
ours always ran slot 0 because `hcs` was already 0, which was luck, not design.

### 5.3 Duration: three different numbers `[bundle]` + hardware

| Thing | Value | Source |
|---|---|---|
| Slider minimum | **15 s** | `DURATION_MIN` |
| Slider maximum | **120 s** | `DURATION_MAX` |
| Time field `hc/%N/time` | float32, preheat/heating budget | §3 |
| Hard write clamp | **120 s** — 121…240 all read back 120 | hardware |
| `stat/tott` after an **idle** `time` write | settles at **60** | hardware |
| Observed session end, idle write | **64–67 s**, state 9 → 5, no fault logged | hardware |
| `stat/tott` after a **live-session** `time` write | **120.0** | hardware |
| Observed session end, live write | **120.4 s** | hardware |
| Boost time cap | **60 s** (`BOOST_DURATION_MAX`, `BOOST_DURATION_MIN` 0) | `[bundle]` |
| Time override `timo` cap | **180 s**, live only | hardware |
| **Real session ceiling** | **300 s = 120 profile + 180 timo** | hardware |

**The budget is a sum, not a field.** `stat/tott` is
`profile time + timo`, and both halves are capped: the profile field stores at
most 120 (and an idle write only yields half of it until re-armed), while `timo`
adds up to 180 and only works on a live cycle.

Verified by reading the device's own counter: `120 + 0 → 120`, `120 + 80 → 200`,
`120 + 180 → 300`, and a session set to 300 s was still live at 81 s. So the
app's 200-second profile is `120 + 80`, nothing exotic — and 200 was never stored
in the profile field, which is why reading that field alone looked capped at 120.

A planner must therefore ask for the overage through `timo` (see
`timoForSession` in `ui/curve.js`) and re-arm, never treat a stored value as
runtime.

`/p/app/stat/tott` (`024`) and `stat/elap` (`023`) are **read-only** from the
app — the API never writes them; it only reads both while state = 8.

### 5.4 Extending a live session: `timo`, not `time` `[bundle]`

The app's "add time" boost is `addDabbingTime()` → writes **`/p/app/timo`**
(`046`, float). Its "add temperature" is `addDabbingTemp()` → **`/p/app/tmpo`**
(`045`, float). Both send an **increment**, converted with
`convertTempIncrement` / `convertTempIncrement`-style scale-only maths — i.e.
Celsius, no 32 °F offset:

```js
convertTempIncrement = (from, v, to) =>
  from === to ? v : to === 'Fahrenheit' ? v * 9 / 5 : v * 5 / 9
```

The UI computes the increment live, e.g.
`readDabbingTime({ time: (totalTime - preheatTarget) + boostTime })`, and gates
the time boost on `totalTime < DURATION_MAX`. That gate is why a boost can never
push a session past 120 s in the official app.

`time` (`hc/%N/time`) itself is written by `writeHeatCycleDuration` when a
profile is saved, and is *also* writable mid-session.

### 5.5 Boost is also a mode `[bundle]`

`MODE_COMMAND.heatCycleBoost = 9` exists. In this build it is only defined —
grep finds no call site — so boost is currently driven by writing `tmpo`/`timo`,
which is what the community describes as "double-click to boost".

Per-profile boost storage `[lib]`, `[bundle]` path map:

| Path | Reg | Type | Meaning |
|---|---|---|---|
| `/u/app/hc/%N/btmp` | `067` | FLOAT | boost temperature increment (0–36 °F / 0–20 °C) |
| `/u/app/hc/%N/btim` | `068` | FLOAT | boost duration (0–60 s) |

### 5.5b LIVE cycle fields vs stored profile `[lib]` + hardware

Two distinct sets, and writing the wrong one does nothing useful:

| | stored (shelf) | **live (running)** |
|---|---|---|
| temperature | `/u/app/hc/%N/temp` | **`/p/app/thc/temp`** |
| time | `/u/app/hc/%N/time` | **`/p/app/thc/time`** |
| name | `/u/app/hc/%N/name` | `/p/app/thc/name` |
| colour | `/u/app/hc/%N/colr` | `/p/app/thc/colr` |
| boost temp | `/u/app/hc/%N/btmp` | **`/p/app/thc/btmp`** |
| boost time | `/u/app/hc/%N/btim` | **`/p/app/thc/btim`** |

Confirmed on hardware 2026-11-04: with a session ACTIVE, writing
`/p/app/thc/temp` moved `/p/htr/tcmd` **255 °C → 195 °C live**, while
`/u/app/hc/0/temp` stayed at 260 °C. This is the retarget we could not get from
the stored field — the reason `--profile` appeared to do nothing during a cycle.

**This is the clean actuator.** `thc/temp` moves the setpoint directly, without
an offset at all, and `thc/time` extends the session the same way. The offset is
still the right tool for trim and for descents below the live profile, but a
ladder can now be driven by writing the live temperature per rung.

Caveat: it writes the *session's* target, so it does not survive the session the
way a profile edit does.

### 5.4b Battery charge state codes `[lib]`

`/p/bat/chg/stat`: **0 BULK, 1 TOPUP, 2 FULL, 3 TEMP_STOP, 4 DONE_DISCONNECTED**.
`TEMP_STOP` is the thermal gate that stops charging on a hot pack — the cause of
"plugged in but not charging" after a run. `chg_src`: 0 USB, 1 qi, 2 dock, 3 none.

### 5.6 Full profile record `[bundle]`

`%N` is a literal slot index. Four slots really exist (0–3); the app carries an
index space up to 24.

| Path | Reg | Type |
|---|---|---|
| `/u/app/hc/%N/name` | `062` | STRING |
| `/u/app/hc/%N/temp` | `063` | FLOAT |
| `/u/app/hc/%N/time` | `064` | FLOAT |
| `/u/app/hc/%N/colr` | `065` | BUFFER |
| `/u/app/hc/%N/scpd` | `066` | BUFFER (LED scratchpad) |
| `/u/app/hc/%N/btmp` | `067` | FLOAT |
| `/u/app/hc/%N/btim` | `068` | FLOAT |
| `/u/app/hc/%N/thrt` | `069` | FLOAT — **threshold temp; app maps it but never reads or writes it** |
| `/u/app/hc/%N/phcl` | `06A` | preheat colour |
| `/u/app/hc/%N/accl` | `06B` | active colour |
| `/p/app/hcs` | `041` | U_INT_8 — currently selected slot |
| `/p/app/nhc` | `060` | slot count |

### 5.7 Chamber, vapour and profile versions `[bundle]`

Chamber (`/p/htr/chmt`, u8): 0 none, **1 classic, 2 XL/3DXL, 3 performance**.
The community library's `HERBAL 2 / XL 4` is wrong.

`ProfileVersion`: `'Pre-T'` and `'T'`. Vapour setting only exists on `T`
profiles, on firmware ≥ `AC`:

| `vaporSetting` | Text on XL | Text otherwise |
|---|---|---|
| 0 | STANDARD | STANDARD |
| 0.5 | HIGH | HIGH |
| 1 | MAX | MAX |
| 1.5 | **XL** | MAX |

`useChamberType().isXLChamber` decides. Slider max is `XL_MAX` 1.5 on XL,
`VAPOR_MAX` 1 elsewhere, always ×10 on the wire.

### 5.8 Modes `[bundle]`

`/p/app/mc`: 0 masterOff, 1 sleep, 2 idle, 3 tempSelectBegin, 4 tempSelectStop,
5 showBatteryLevel, 6 showVersion, 7 heatCycleStart, 8 heatCycleAbort,
9 heatCycleBoost, 10 factoryTest, 11 bonding.

---

## 6. Heater control and telemetry `[bundle]`

| Path | Reg | Type | Meaning |
|---|---|---|---|
| `/p/htr/temp` | `03c` | FLOAT | chamber temp, °C |
| `/p/htr/tcmd` | `03d` | FLOAT | **coil** setpoint, °C — read-only |
| `/p/htr/duty` | `029` | FLOAT | heater duty, % |
| `/p/htr/pwr` | `028` | FLOAT | heater power, W |
| `/p/htr/vavg` | `02a` | FLOAT | average voltage |
| `/p/htr/iavg` | `02b` | FLOAT | average current |
| `/p/htr/res` | `02d` | FLOAT | heater resistance, Ω |
| `/p/htr/stet` | `02c` | FLOAT | **safety thermal estimate, °C** |
| `/p/htr/chmt` | `03f` | U_INT_8 | chamber type |

PID and safety constants (`[bundle]` names, all FLOAT):

| Path | Reg | Name |
|---|---|---|
| `/p/htr/tun/pco` | `0e1` | `pCoeff` |
| `/p/htr/tun/ico` | `0e2` | `iCoeff` |
| `/p/htr/tun/dco` | `0e3` | `dCoeff` |
| `/p/htr/tun/dft` | `0e4` | `dFilterTime` |
| `/p/htr/tun/sthc` | `0e5` | `safetyThermalHeatCap` |
| `/p/htr/tun/stdt` | `0e6` | `safetyThermalDecayTau` |
| `/p/htr/tun/msf` | `0e7` | `minWattSteadyStateFraction` |

`minWattSteadyStateFraction` is the most interesting of these: it is a floor on
steady-state heater wattage, and it matches the observed behaviour that duty
parks near 10 % and stops falling. `stet` is the temperature the safety model
*believes*, not a measurement — a thermal-violation fault records commanded,
estimated and measured side by side (§8).

**Caution:** the `tun/*` paths are in the register map but reading them with a
plain short read fails — they are reached through the NVM window (§7.2), not
`readShort`.

### 6.1 What the hardware actually did (2026-11-03, firmware AW)

- `tcmd` = profile + ~21 °F with the offset at zero; the firmware aims above the
  profile by itself.
- The chamber settles **27–46 °F below `tcmd`** and duty parks at 9–14 %. The
  two are different thermal nodes: `tcmd` is the coil, `temp` is the chamber.
- Writing the **profile temp mid-session does not move `tcmd`**. Only the offset
  does.
- Offset writes are honoured far past the app's 20 °C: 25/30/40/60/80 °C all
  read back exactly and moved `tcmd` 1.8 °F per °C (80 °C → +144 °F).
- A gradient-compensated closed loop *did* hold 540 °F chamber (settled 540.8 °F
  after passing through a 547 °F overshoot), so the mechanism is usable.

### 6.2 Negative offsets

Never exercised. The app only ever adds. `DELTA_LIMITS_C.min` is 0 because there
is no evidence for below-profile control; the register is a float and may well
accept negatives — test before relying on it.

---

## 7. NVM, versioning, OTA

### 7.1 Firmware version comparison `[bundle]`

```js
lettersToNumber = s => s.split('').reduce((i, c) => i * 26 + c.charCodeAt(0) - 64, 0)
meetsMinimumFirmware = (have, need) => have !== undefined && lettersToNumber(have) >= lettersToNumber(need)
```

Base-26 over letters, so **`AW` == 49 and `AJ` == 36**.

`MINIMUM_FIRMWARE_VERSION` gate table: `TEMP_PROFILE 'N'`, `MOOD_LIGHTING 'X'`,
`CHAMBER_TYPE 'V'`, `PREVIEW_COLOR 'V'`, `FIRMWARE_AUTHENTICATION 'X'`,
`BATTERY_PRESERVATION 'Y'`, `VAPOR_SETTING 'AC'`, `LED3 'AF'`, `XL_CHAMBER 'AG'`.

`MAX_FIRMWARE_SUPPORTED = 'AJ'`.

**This device reports firmware `AW`, which is newer than the app's own maximum
supported `AJ`.** App 2.4.3 is behind the unit it is talking to. That is the
structural reason its limits are conservative and should not be treated as
device limits — the 20 °C offset clamp is the proven example, and the 120 s
duration cap is probably another.

### 7.2 NVM access window `[bundle]`

`/p/app/…`? No — `/p/…` prefix, two paths:

| Path | Reg | Type |
|---|---|---|
| `/p/nvm/aptr` *(named `nvmAccessPointer`)* | `100` | U_INT_16 |
| `/p/nvm/adata` *(named `nvmAccessData`)* | `101` | BUFFER |

Write pointer, then data. `NVM_ACCESS_USER_ARRAY_STARTING_OFFSET = 8`, packed
as `((8 + A) << 4) | (8 + B)` so the two nibbles carry a 4-bit-pair offset.
Array indices: `HEAT_PROFILE_TEMP 0`, `HEAT_PROFILE_0..3 1..4`,
`DEFAULT_LANTERN_ARRAY_INDEX 5`, `ALTERNATIVE_LANTERN_ARRAY_INDEX 6`.
Offset arrays: `colorArray 51`, `offsetArray 59`.

### 7.3 OTA `[bundle]`

Silabs gecko bootloader: service `1d14d6ee-fd63-4fa1-bfa4-8f47b42119f0`,
control `f7bf3564-…`, data `984227f3-…`, app version `0d77cc11-…`, loader
version `4cc07bcf-…`. A separate PUP service
(`420b9b40-457d-4abe-a3bf-71609d79581b`) exposes trigger, version, hash, device
info and serial characteristics. The app reads the OTA version once on connect to
trigger bonding and never writes the service.

---

## 8. Device logs — two logs, two code tables `[bundle]`

Two independent ring buffers, each entry `{timestamp u32 @0, type u8 @4, payload…}`,
read by selecting an index and polling until `curr` matches:

```
write /p/logv/{aud|flt}/sel = idx (u32)
poll  /p/logv/{aud|flt}/curr == idx      (20 ms backoff, ~25 tries)
read  /p/logv/{aud|flt}/entr             (BUFFER)
```

Ranges come from `/p/logv/{aud|flt}/begn` and `/end`.

> The register map lists `curr` at `0c1`/`0d1` and `entr` at `0c2`/`0d2`, but the
> code also uses a `sel` path that is not in the map. Use the string paths.

### 8.1 Audit log codes (`aud`)

| # | Code | Payload |
|---|---|---|
| 0 | CHARGE_START | battery temp, voltage |
| 1 | CHARGER_DISCONNECTED | battery temp, voltage |
| 2 | CHARGE_COMPLETE | battery temp, voltage |
| 3 | HEAT_CYCLE_ENTER_PREHEAT | heat-cycle record |
| 4 | HEAT_CYCLE_ABORT_PREHEAT | heat-cycle record |
| 5 | HEAT_CYCLE_ABORT_ACTIVE | heat-cycle record |
| 6 | HEAT_CYCLE_COMPLETE | heat-cycle record |
| 7 | **HEAT_CYCLE_BOOSTED** | heat-cycle record |
| 8 | SYSTEM_BOOT | u32 |
| 9 | **HEAT_CYCLE_ACTIVE** | heat-cycle record |
| 10 | FACTORY_RESET | — |
| 11 | CLOCK_ADJUST | prev timestamp, uptime |
| 12 | HEAT_CYCLE_FAULTED | heat-cycle record |
| 13 | MOOD_LIGHT_ENDED | usage, duration, ULID |

Heat-cycle record: `nominal i16@6 /10`, `commanded i16@8 /10`,
`actual i16@10 /10`, `total u16@12 /100`, `elapsed u16@14 /100` — all °C, times
in centiseconds.

### 8.2 Fault log codes (`flt`)

| # | Code | Payload |
|---|---|---|
| 0 | CHARGE_LOW_CAPACITY | SOC start/end, temps, duration, charge |
| 1 | CHARGE_TEMP_STOP | battery temp/voltage |
| 2 | **HEAT_CYCLE_START_LOW_BATTERY** | battery voltage @6 |
| 3 | HEATER_CURRENT_SENSE | sensor V, current, battery V, duty |
| 4 | HEATER_SHORT_CIRCUIT | same as 3 |
| 5 | HEATER_OPEN_CIRCUIT | same as 3 |
| 6 | HEATER_TEMP_ERRATIC | previous temp, current temp |
| 7 | HEATER_TEMP_LOST | last raw code |
| 8 | **HEATER_SAFETY_THERMAL_VIOLATION** | commanded i16@7, estimated i16@8, measured i16@10 |
| 9 | LOW_BATTERY_VOLTAGE | battery temp, voltage |
| 10 | HIGH_BATTERY_TEMP | battery temp, voltage |
| 11 | BOND_FAILED | reason, conn handle, bond handle |
| 12 | SYSTEM_BOOT | u32 |
| 13 | CLOCK_ADJUST | prev timestamp, uptime |

`HEATER_SAFETY_THERMAL_VIOLATION` is the one to watch when probing high
temperatures: it hands you commanded vs estimated vs measured at the moment the
safety model objected, which is exactly the data a plateau investigation wants.

> On firmware `AW` the tables above do **not** cover everything actually seen.
> The audit log also emits types **14–21** and the fault log types **15** and
> **17** in bulk, with byte layouts that do not match the published codes. Those
> are newer-firmware records; treat them as undecoded. A clean 14 s cycle
> produced exactly one type 15 and one type 16 and zero fault entries, so type
> 15/16 track heat-cycle start rather than failure.

---

## 9. Temperature curves — what is actually true

The setpoint offset is the only live control surface, and it does work. What was
wrong in the first version of this document is the claim that the *chamber*
follows it.

```
/p/app/tmpo (float32, °C)  — increment added to the active profile temperature
offset  0 °C → /p/htr/tcmd  491 °F
offset 10 °C → /p/htr/tcmd  509 °F
offset 20 °C → /p/htr/tcmd  527 °F
offset 80 °C → /p/htr/tcmd  635 °F     (1.8 °F/°C, exact, all the way up)
```

### The real constraints

1. **Session-scoped.** Written while idle it reads back `0.0` and stores
   nothing. It only means anything inside a heat cycle.
2. **`tcmd` is a coil setpoint, not a chamber temperature.** The chamber settles
   27–46 °F under it. Commanding `tcmd` directly therefore always undershoots.
3. **The profile cannot be retargeted mid-session** — only the offset can.
4. **Duty floors near 10 %** and the chamber bleeds while it does.
5. **Sessions run ~60 s of active phase**, not the 120 the profile can store.
6. **The heater is one-way.** It can climb but never actively cool; a falling
   curve is a request.

### Making a curve work

Command the coil *above* the chamber target and let the loop land the chamber on
the line:

```
tcmd_want = chamber_target + gap + Kp * (chamber_target − chamber)
offset_c  = clamp((tcmd_want − (profile + bias)) / 1.8, 0, 85)
```

with `gap` ≈ 38 °F measured per unit and `bias` ≈ 21 °F. That held 540 °F chamber
to within 1 °F after settling. `ui/curve.js` carries `COIL_CHAMBER_GAP_F`,
`PROFILE_TCMD_BIAS_F`, `DELTA_LIMITS_C.max = 85` and `SESSION_LIFE_S = 60` for
this reason.

### Safety envelope enforced in `ui/curve.js`

1. Hard clamp to the app's own constants: 400–644 °F (204–340 °C).
2. Offset clamped 0–85 °C.
3. Slew limit 3 °C/s so a curve's step never becomes a shock.
4. No write outside a heat cycle.
5. No write on a stale link (> 4 s without status).
6. On stop, write offset 0 so the device falls back to its profile temperature.
7. Deadband 0.5 °C — no duplicate writes.

---

## 10. Still undecoded

1. Whether `/p/app/tmpo` accepts a **negative** increment.
2. The real device-side duration ceiling. The register clamps at 120 and active
   phase comes out ~60, but the app is older than the firmware (§7.1) so 120 may
   itself be an app-era limit. Try writing `hc/N/time` during an **active**
   session (not idle) and watch `stat/tott`.
3. Audit types 14–21 and fault types 15/17 (§8).
4. Whether `heatCycleBoost` mode 9 changes anything on this firmware.
5. `/u/app/hc/%N/thrt` — what the threshold temperature actually gates.
6. Whether `/p/htr/tun/*` is writable through the NVM window and what the
   factory PID/safety values are.
7. Auth variant selection per firmware generation.

---

## 11. Superseded text kept for history

### Old §5 — original offset notes

**Confirmed 2026-11-03 on a Peak Pro 3DXL V2, firmware AW, model code 13, chamber type 2.**


**Confirmed 2026-11-03 on a Peak Pro 3DXL V2, firmware AW, model code 13, chamber type 2.**

Firmware has no curve mode. It has a live setpoint offset, and the offset works
(moved to §9 above; the old 20 °C ceiling it cites is superseded):

```
/p/app/tmpo  (float32, Celsius)  — a DELTA added to the active profile temperature

offset 0 °C   → device target 501 °F
offset 10 °C  → device target 519 °F     (+18 °F = 10 °C)
offset 20 °C  → device target 537 °F     (+36 °F = 20 °C)
offset 0 °C   → device target 501 °F     (returns exactly)
```

Measured by writing `/p/app/tmpo` and reading back `/p/htr/tcmd`, the device's own
target. The firmware tracks the offset exactly, and clears it when the session
ends.

### Three things that matter for the design

1. **It is session-scoped.** Written while idle, `/p/app/tmpo` reads back `0.0`
   for every value — the path silently accepts and stores nothing. The same
   writes during a heat cycle take effect immediately. A curve therefore only
   exists inside a session.

2. **The thermal lag is seconds, not milliseconds.** A +20 °C step moved the
   chamber about 8 °F in 2.5 s. Commands land instantly; the chamber does not.
   Any curve display must show measured temperature against commanded, not
   assume they match.

3. **Never write `/p/htr/tcmd`.** It is the device's *reported* target. Writing
   it is not how you steer the heater — the device recomputes it, and during
   testing a write left it reading 0 until the session ended. Use the offset.

### What a curve can and cannot do

| | |
|---|---|
| ✅ Rise, hold, step, ramp, hill, valley, multi-stage | the setpoint is followed by the existing control loop |
| ✅ Sub-degree steps, deadbanded writes | the wire is float32; only changed values are written |
| ❌ Force a fast **drop** | the heater can only stop; the chamber cools passively (~1 °C/s at high Δ). A falling curve is a *request*, the real temp sits above it. Report this instead of pretending. |
| ✅ **Rise above the profile temperature** | verified: the offset moves the device's own target 1:1 |
| ⚠️ Fall below the profile temperature | a negative delta was never seen accepted; treat descent as "hold and let it cool" |
| ❌ Run while the phone is away | the curve lives in the app. Lose the link and the device holds the last setpoint. A watchdog must clear the offset. |
| ❌ Survive a session end | state leaves `HEAT_CYCLE_ACTIVE` → the curve is over, by definition |

### Safety envelope enforced in `ui/curve.js`

1. Hard clamp to the app's own constants: 400–644 °F (204–340 °C).
2. Delta clamped to 0–20 °C — the range the firmware's own UI exercises. *(Now 85 °C; see §9.)*
3. Slew limit 3 °C/s so a curve's step never becomes a shock.
4. No write outside a heat cycle.
5. No write on a stale link (> 5 s without status).
6. On stop, write delta 0 so the device falls back to its profile temperature.
7. Deadband 0.5 °C — no duplicate writes.

These are the same discipline as the Carta app: only official frames, only while idle/valid,
always with a defined fallback.

---

### Old §6 — original open questions

1. Does `/p/app/tmpo` accept a **negative** delta (below profile temp)? The app never sends one.
2. Is the delta clamped to ±20 °C device-side, or is that only a UI limit?
3. Does a profile count above 3 exist on current firmware (the 25 vs 4 constant)?
4. Which auth variant does the installed firmware want?
5. Does the device hold the offset if the app disconnects mid-session, or drop it?
6. Read rate: how fast can `/p/htr/temp` be polled before the link degrades?

Each answer changes the app, so run them before designing the UI around them.
