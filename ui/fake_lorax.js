/* Simulated Peak Pro — same transport interface as ui/ble.js.
 *
 * This is a SIMULATOR, not a protocol claim. It implements the framing and the
 * auth gate exactly as ui/proto/lorax.js expects, so the app can be exercised
 * end to end without hardware, and it models the heater with a first-order lag
 * so the curve runner has something physical to fight against.
 *
 * What it deliberately reproduces from the real thing:
 *   - reads and writes are refused until UNLOCK_ACCESS succeeds
 *   - WRITE_SHORT is silent on success and only replies on error
 *   - replies are [seq u16 LE][error u8][payload]
 *   - /p/app/tmpo is a DELTA in Celsius added to the profile temperature
 *
 * What it invents: the thermal constants, the preheat timing, and the exact
 * error code for a locked device. Those are guesses and are marked as such.
 */

import { OP, TYPE, enc, dec, authToken, KEYS, revisionString } from './proto/lorax.js';
import { P, MODE } from './device.js';

const ERR_LOCKED = 0x05;   /* guessed: any non-zero code reads as "refused" */

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function createFakeLorax(opts = {}) {
  const {
    firmware = 'AG',
    name = 'Peak Pro 3DXL',
    serial = 'FAKE0001',
    chamber = 4,
    startC = 22,
    ambientC = 22,
    riseCPerSec = 9,
    lag = 0.55,
    coolK = 0.0042,
    /* The coil runs hotter than the chamber. Without this the simulator lets
     * the chamber reach the coil setpoint exactly, so a governor that forgets
     * the gradient looks perfect offline and tracks low on hardware. */
    gapC = 12.2,
    tickMs = 100,
    seedBytes = null,
  } = opts;

  const replyCbs = [];
  const eventCbs = [];

  /* ---------------------------------------------------------- state */
  const seed = seedBytes || crypto.getRandomValues(new Uint8Array(16));
  let unlocked = false;

  const profiles = [
    { name: 'Morning',   temp: 249.0, time: 75,  btmp: 5.5, btim: 15 },
    { name: 'Hill climb', temp: 277.0, time: 90,  btmp: 5.5, btim: 15 },
    { name: 'Low & slow', temp: 227.0, time: 120, btmp: 4.0, btim: 20 },
    { name: 'Hot one',   temp: 315.0, time: 45,  btmp: 6.0, btim: 10 },
  ];

  const S = {
    state: 5,
    elapsed: 0,
    total: 0,
    tempC: startC,
    targetC: profiles[0].temp,
    override: 0,
    soc: 72,
    charge: 4,
    eta: 2280,
    profileCurrent: 0,
    lantern: 0,
    lanternRemaining: 0,
    brightness: new Uint8Array([210, 154, 255, 86]),
    stealth: 0,
    totalDabs: 1284,
    tripDabs: 47,
    totalTime: 94440,
    tripTime: 3120,
    perDay: 6.2,
    remaining: 62,
    uptime: 64800,
    phase: null,
    phaseUntil: 0,
    /* Live session target (`/p/app/thc/temp`) — what a running cycle actually
     * heats to. Writes are refused while idle, like the hardware. */
    liveWrites: 0,
    liveTemp: profiles[0].temp,
  };

  let timer = null;
  let lastTick = Date.now();

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function profilePath(path) {
    const m = /^\/u\/app\/hc\/(\d+)\/(\w+)$/.exec(path);
    if (!m) return null;
    return { n: Number(m[1]), field: m[2] };
  }

  /* ------------------------------------------------------- handlers */

  /* A failed read is what the app sees as `null`, and what the governor must not
   * read as "the session ended". Set this to model a busy link. */
  let stateDropEvery = 0;
  let stateReads = 0;

  function readPath(path) {
    if (path === P.state && stateDropEvery && (++stateReads % stateDropEvery === 0)) {
      throw new Error('simulated read failure');
    }
    const pr = profilePath(path);
    if (pr) {
      const p = profiles[pr.n];
      if (!p) throw new Error('no slot');
      switch (pr.field) {
        case 'name': return enc(TYPE.STRING, p.name);
        case 'temp': return enc(TYPE.FLOAT, p.temp);
        case 'time': return enc(TYPE.FLOAT, p.time);
        case 'btmp': return enc(TYPE.FLOAT, p.btmp);
        case 'btim': return enc(TYPE.FLOAT, p.btim);
        case 'colr': return new Uint8Array([255, 122, 69, 1, 0, 0, 0, 0]);
        case 'scpd': return new Uint8Array([3]);
        case 'thrt': return enc(TYPE.FLOAT, p.temp);
        default: throw new Error('no field');
      }
    }

    switch (path) {
      case P.fwVersion: return enc(TYPE.U32, revToInt(firmware));
      case P.model: return enc(TYPE.U32, 21);
      case P.serial: return enc(TYPE.STRING, serial);
      case P.hw: return enc(TYPE.STRING, 'V2.0');
      case P.name: return enc(TYPE.STRING, name);
      case P.state: return enc(TYPE.U8, S.state);
      case P.elapsed: return enc(TYPE.FLOAT, S.elapsed);
      case P.total: return enc(TYPE.FLOAT, S.total);
      case P.temp: return enc(TYPE.FLOAT, S.tempC);
      case P.tempCmd: return enc(TYPE.FLOAT, S.targetC + S.override);
      /* The live session target is the base the heater works from; `tcmd` is
       * that plus the offset. Hardware moved tcmd immediately when this was
       * written mid-session, so the simulator does the same. */
      case P.liveTemp: return enc(TYPE.FLOAT, S.targetC);
      case P.liveTime: return enc(TYPE.FLOAT, S.total || profiles[S.profileCurrent].time);
      case P.liveName: return enc(TYPE.STRING, profiles[S.profileCurrent].name);
      case P.tempOverride: return enc(TYPE.FLOAT, S.override);
      case P.timeOverride: return enc(TYPE.FLOAT, Math.max(0, S.total - S.elapsed));
      case P.chamber: return enc(TYPE.U8, chamber);
      case P.power: {
        const err = (S.targetC + S.override) - S.tempC;
        return enc(TYPE.FLOAT, S.state === 8 || S.state === 7 ? clamp(err * 9.5, 0, 40) : 0);
      }
      case P.duty: {
        const err = (S.targetC + S.override) - S.tempC;
        return enc(TYPE.FLOAT, S.state === 8 || S.state === 7 ? clamp(err * 19, 0, 100) : 0);
      }
      case P.volts: return enc(TYPE.FLOAT, 18.9);
      case P.amps: return enc(TYPE.FLOAT, 1.64);
      case P.resistance: return enc(TYPE.FLOAT, 4.1);
      case P.profileCurrent: return enc(TYPE.U32, S.profileCurrent);
      case P.soc: return enc(TYPE.FLOAT, S.soc);
      case P.chargeState: return enc(TYPE.U8, S.charge);
      case P.chargeEta: return enc(TYPE.FLOAT, S.eta);
      case P.batteryVolts: return enc(TYPE.FLOAT, 3.92);
      case P.batteryAmps: return enc(TYPE.FLOAT, 1.2);
      case P.batteryTemp: return enc(TYPE.FLOAT, 28);
      case P.lanternCmd: return enc(TYPE.U8, S.lantern);
      case P.lanternRemaining: return enc(TYPE.FLOAT, S.lanternRemaining);
      case P.brightness: return S.brightness.slice();
      case P.stealth: return enc(TYPE.U8, S.stealth);
      case P.totalDabs: return enc(TYPE.U32, S.totalDabs);
      case P.tripDabs: return enc(TYPE.U32, S.tripDabs);
      case P.totalTime: return enc(TYPE.FLOAT, S.totalTime);
      case P.tripTime: return enc(TYPE.FLOAT, S.tripTime);
      case P.dabsPerDay: return enc(TYPE.FLOAT, S.perDay);
      case P.dabsRemaining: return enc(TYPE.U8, S.remaining);
      case P.uptime: return enc(TYPE.FLOAT, S.uptime);
      default: throw new Error('unknown path ' + path);
    }
  }

  function writePath(path, data) {
    const pr = profilePath(path);
    if (pr) {
      const p = profiles[pr.n];
      if (!p) throw new Error('no slot');
      switch (pr.field) {
        case 'name': p.name = dec(TYPE.STRING, data); break;
        case 'temp': p.temp = dec(TYPE.FLOAT, data); break;
        case 'time': p.time = dec(TYPE.FLOAT, data); break;
        case 'btmp': p.btmp = dec(TYPE.FLOAT, data); break;
        case 'btim': p.btim = dec(TYPE.FLOAT, data); break;
        default: break;
      }
      return;
    }

    switch (path) {
      case P.mode: {
        const m = dec(TYPE.U8, data);
        if (m === MODE.HEAT_CYCLE_START) {
          S.state = 7; S.elapsed = 0;
          S.total = profiles[S.profileCurrent].time;
          S.targetC = profiles[S.profileCurrent].temp;
          S.phase = 'preheat'; S.phaseUntil = Date.now() + 3500;
        } else if (m === MODE.HEAT_CYCLE_ABORT) {
          S.state = 9; S.override = 0; S.phase = 'fade'; S.phaseUntil = Date.now() + 2500;
        } else if (m === MODE.IDLE) {
          S.state = 5; S.override = 0; S.phase = null;
        } else if (m === MODE.HEAT_CYCLE_BOOST) {
          S.override = clamp(S.override + 5.5, 0, 20);
        } else if (m === MODE.SLEEP) {
          S.state = 4; S.override = 0; S.phase = null;
        }
        break;
      }
      case P.liveTemp: {
        /* Session-scoped, exactly like `/p/app/thc/temp` on the device: while
         * idle the write is accepted and reads back unchanged. */
        const inSession = S.state === 7 || S.state === 8 || S.state === 9;
        if (inSession) {
          S.targetC = dec(TYPE.FLOAT, data);
          S.liveWrites++;
        }
        break;
      }
      case P.liveTime: {
        const inSession = S.state === 7 || S.state === 8 || S.state === 9;
        if (inSession) S.total = dec(TYPE.FLOAT, data);
        break;
      }
      case P.liveName: break;
      case P.tempOverride:
        /* A negative delta is accepted here because we do not know whether the
         * hardware accepts one. The mockup and this simulator both treat it as
         * valid; hardware must confirm. */
        S.override = clamp(dec(TYPE.FLOAT, data), -20, 20);
        break;
      case P.tempCmd: S.targetC = dec(TYPE.FLOAT, data); break;
      case P.profileCurrent: S.profileCurrent = dec(TYPE.U32, data) & 3; break;
      case P.name: name = dec(TYPE.STRING, data); break;
      case P.lanternCmd: S.lantern = dec(TYPE.U8, data); S.lanternRemaining = S.lantern ? 7200 : 0; break;
      case P.lanternTime: S.lanternRemaining = dec(TYPE.FLOAT, data); break;
      case P.lanternColor: break;
      case P.brightness: S.brightness = new Uint8Array(data.slice(0, 4)); break;
      case P.stealth: S.stealth = dec(TYPE.U8, data); break;
      default: break;
    }
  }

  function reply(seq, err, payload) {
    const body = payload || new Uint8Array(0);
    const out = new Uint8Array(3 + body.length);
    new DataView(out.buffer).setUint16(0, seq, true);
    out[2] = err;
    out.set(body, 3);
    setTimeout(() => { for (const cb of replyCbs) { try { cb(out); } catch (e) { console.error(e); } } }, 6);
  }

  /* ------------------------------------------------------- transport */

  const transport = {
    async write(bytes) {
      const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      if (b.length < 3) return;
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const seq = dv.getUint16(0, true);
      const op = b[2];
      const payload = b.subarray(3);

      switch (op) {
        case OP.GET_ACCESS_SEED:
          reply(seq, 0, seed);
          return;

        case OP.UNLOCK_ACCESS: {
          const token = payload.subarray(0, 16);
          for (const mode of ['key', 'seed']) {
            const want = await authToken(seed, mode === 'key' ? KEYS.lorax : null, mode);
            if (token.length === 16 && want.every((v, i) => v === token[i])) {
              unlocked = true;
              reply(seq, 0);
              return;
            }
          }
          reply(seq, ERR_LOCKED);
          return;
        }

        case OP.GET_LIMITS: {
          const out = new Uint8Array(6);
          const d = new DataView(out.buffer);
          d.setUint16(0, 200, true); d.setUint16(2, 16, true); d.setUint16(4, 8, true);
          reply(seq, 0, out);
          return;
        }

        case OP.READ_SHORT: {
          if (!unlocked) return reply(seq, ERR_LOCKED);
          const path = ascii(payload.subarray(4));
          try {
            reply(seq, 0, readPath(path));
          } catch {
            reply(seq, 0x02, new Uint8Array(0));
          }
          return;
        }

        case OP.WRITE_SHORT: {
          if (!unlocked) return reply(seq, ERR_LOCKED);
          /* payload: [0 u16][flag u8][path][0x00][data…] */
          const rest = payload.subarray(3);
          let z = -1;
          for (let i = 0; i < rest.length; i++) if (rest[i] === 0) { z = i; break; }
          if (z < 0) return reply(seq, 0x02);
          const path = ascii(rest.subarray(0, z));
          try {
            writePath(path, rest.subarray(z + 1));
            /* silent on success — exactly like the device */
          } catch {
            reply(seq, 0x02);
          }
          return;
        }

        default:
          reply(seq, 0x03);
      }
    },

    onReply(cb) { replyCbs.push(cb); },
    onEvent(cb) { eventCbs.push(cb); },
    async disconnect() { clearInterval(timer); timer = null; },
  };

  /* ------------------------------------------------------- heater sim */

  function tick() {
    const now = Date.now();
    const dt = Math.min(0.5, (now - lastTick) / 1000);
    lastTick = now;

    if (S.phase === 'preheat' && now > S.phaseUntil) { S.state = 8; S.phase = 'active'; }
    if (S.phase === 'fade' && now > S.phaseUntil) { S.state = 5; S.phase = null; }

    if (S.state === 8) {
      S.elapsed += dt;
      if (S.elapsed >= S.total) { S.state = 9; S.override = 0; S.phase = 'fade'; S.phaseUntil = now + 2500; }
    }

    const heating = S.state === 7 || S.state === 8 || S.state === 9;
    const setpoint = heating ? S.targetC + S.override : ambientC;
    /* What the chamber can actually settle at: the coil target minus the gap. */
    const settle = heating ? setpoint - gapC : ambientC;

    const err = settle - S.tempC;
    if (err > 0) S.tempC += Math.min(err * lag, riseCPerSec) * dt;
    else S.tempC += Math.max(err * lag, -coolK * (S.tempC - ambientC) * 60) * dt;

    S.uptime += dt;
    if (S.lantern) S.lanternRemaining = Math.max(0, S.lanternRemaining - dt);
  }

  timer = setInterval(tick, tickMs);

  return {
    transport,
    state: S,
    profiles,
    /* test hooks */
    get unlocked() { return unlocked; },
    seed,
    forceState(s) { S.state = s; },
    /* Model a busy link: every Nth state read fails, which the app sees as null. */
    dropStateEvery(n) { stateDropEvery = n | 0; },
    stop() { clearInterval(timer); timer = null; },
  };
}

function ascii(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

function revToInt(rev) {
  const chars = 'ABCDEFGHJKMNPRTUVWXYZ';
  let v = 0;
  for (const ch of rev) v = v * chars.length + chars.indexOf(ch) + 1;
  return v;
}
