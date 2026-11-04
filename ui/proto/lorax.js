/* Lorax — the path-addressed protocol every Peak Pro from firmware X onward speaks.
 *
 * Wire format, verified against Puffco's own bundle (2.4.3) and the community
 * community client:
 *
 *   command  → [seq u16 LE][opcode u8][payload…]
 *   reply    ← [seq u16 LE][error u8][payload…]
 *
 * A reply is matched to its command by sequence id alone. There is no length
 * field, no checksum, and no acknowledgement for WRITE_SHORT — the device is
 * silent unless something went wrong, which is exactly why every write here is
 * followed by a read when the value matters.
 *
 * Everything is little-endian. Temperatures are Celsius floats on the wire;
 * Fahrenheit exists only in the UI.
 */

export const OP = Object.freeze({
  GET_ACCESS_SEED: 0,
  UNLOCK_ACCESS: 1,
  GET_LIMITS: 2,
  ACK_EVENTS: 3,
  READ_SHORT: 16,
  WRITE_SHORT: 17,
  STAT_SHORT: 18,
  UNLINK: 19,
  OPEN: 32,
  READ: 33,
  WRITE: 34,
  WATCH: 35,
  UNWATCH: 36,
  STAT: 37,
  CLOSE: 38,
  PRUNE_FILE_HANDLES: 39,
});

export const TYPE = Object.freeze({
  FLOAT: 'float',
  U8: 'u8',
  U16: 'u16',
  U32: 'u32',
  STRING: 'string',
  BUFFER: 'buffer',
});

/* Handshake keys. The seed is per-connection; the key is fixed per generation.
 *
 * The keys belong to the vendor and are not part of this repository. Supply them
 * at runtime, either by loading a local file before this module or by setting the
 * globals yourself:
 *
 *   <script src="handshake.local.js"></script>   (gitignored, optional)
 *   window.__PEAK_KEY_LORAX = '<base64>'
 *
 * The placeholder below is not a key: the device answers a seed challenge and
 * refuses every read until a real one is supplied. Nothing here guesses it.
 */
const KEY_PLACEHOLDER = 'AAAAAAAAAAAAAAAAAAAAAA==';

/* Resolution order: a global set by an optional local script, then a value
 * stored once in this origin, then the placeholder. */
function localKey(name, storageKey) {
  if (typeof window !== 'undefined' && window[name]) return window[name];
  try {
    const v = localStorage.getItem(storageKey);
    if (v) return v;
  } catch { /* storage can be blocked; a placeholder is the safe fallback */ }
  return KEY_PLACEHOLDER;
}

const HANDSHAKE_LORAX = localKey('__PEAK_KEY_LORAX', 'peak.key.lorax');
const HANDSHAKE_FLAT = localKey('__PEAK_KEY_FLAT', 'peak.key.flat');

const REVISION_CHARS = 'ABCDEFGHJKMNPRTUVWXYZ';

export class LoraxError extends Error {
  constructor(message, { code, seq, op } = {}) {
    super(message);
    this.name = 'LoraxError';
    this.code = code;
    this.seq = seq;
    this.op = op;
  }
}

/* ------------------------------------------------------------- codecs */

export function enc(type, value) {
  switch (type) {
    case TYPE.FLOAT: {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setFloat32(0, Number(value), true);
      return b;
    }
    case TYPE.U8: {
      const b = new Uint8Array(1);
      b[0] = Number(value) & 0xff;
      return b;
    }
    case TYPE.U16: {
      const b = new Uint8Array(2);
      new DataView(b.buffer).setUint16(0, Number(value) & 0xffff, true);
      return b;
    }
    case TYPE.U32: {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setUint32(0, Number(value) >>> 0, true);
      return b;
    }
    case TYPE.STRING: {
      const s = String(value);
      const b = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
      return b;
    }
    case TYPE.BUFFER:
      return value instanceof Uint8Array ? value : new Uint8Array(value);
    default:
      throw new Error('unknown type ' + type);
  }
}

export function dec(type, bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  switch (type) {
    case TYPE.FLOAT:
      return b.length >= 4 ? new DataView(b.buffer, b.byteOffset, 4).getFloat32(0, true) : null;
    case TYPE.U8:
      return b.length >= 1 ? b[0] : null;
    case TYPE.U16:
      return b.length >= 2 ? new DataView(b.buffer, b.byteOffset, 2).getUint16(0, true) : null;
    case TYPE.U32:
      return b.length >= 4 ? new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true) : null;
    case TYPE.STRING: {
      let end = b.length;
      while (end > 0 && (b[end - 1] === 0 || b[end - 1] === 0x20)) end--;
      let s = '';
      for (let i = 0; i < end; i++) s += String.fromCharCode(b[i]);
      return s;
    }
    case TYPE.BUFFER:
      return b;
    default:
      throw new Error('unknown type ' + type);
  }
}

/* Firmware revision integer → the letter pair Puffco prints ("AW", "AG+" is the
 * plus-variant of AG and is reported separately by the app, not by the device). */
export function revisionString(rev) {
  if (!rev || rev <= 0) return 'X*';
  let i = rev - 1, out = '';
  while (i >= 0) {
    out = REVISION_CHARS[i % REVISION_CHARS.length] + out;
    i = Math.floor(i / REVISION_CHARS.length) - 1;
  }
  return out;
}

export function revisionIndex(rev) {
  if (!rev) return -1;
  let v = 0;
  for (const ch of rev) {
    const i = REVISION_CHARS.indexOf(ch);
    if (i < 0) return -1;
    v = v * REVISION_CHARS.length + i + 1;
  }
  return v;
}

/* --------------------------------------------------------------- auth */

function b64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256(bytes) {
  if (!globalThis.crypto || !globalThis.crypto.subtle) {
    throw new Error('Web Crypto unavailable — this page must be served over https:// or localhost');
  }
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return new Uint8Array(d);
}

/* sha256(key[16] ‖ seed[16])[:16]. `mode` picks which 16 bytes go first:
 *  - 'key'  → handshake key then seed (the documented handshake)
 *  - 'seed' → zeroes then seed (the variant Puffco also ships)
 */
export async function authToken(seed, keyB64, mode = 'key') {
  const key = keyB64 ? b64ToBytes(keyB64) : new Uint8Array(16);
  const buf = new Uint8Array(32);
  if (mode === 'key') {
    buf.set(key.subarray(0, 16), 0);
    buf.set(seed.subarray(0, 16), 16);
  } else {
    buf.set(seed.subarray(0, 16), 16);
  }
  const hash = await sha256(buf);
  return hash.subarray(0, 16);
}

export const KEYS = Object.freeze({ lorax: HANDSHAKE_LORAX, flat: HANDSHAKE_FLAT });

/* ------------------------------------------------------------ client */

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* A Lorax session over any transport exposing:
 *   write(bytes) → Promise,  onReply(cb),  onEvent(cb),  disconnect()
 *
 * All I/O is serialised: Lorax has no flow control, and two commands in flight
 * on one sequence space is how a reply lands on the wrong transaction. */
export class Lorax {
  constructor(transport, { timeout = 4000, maxPayload = 200 } = {}) {
    this.t = transport;
    this.timeout = timeout;
    this.maxPayload = maxPayload;
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
    this.listeners = new Set();
    this.queue = Promise.resolve();
    this.ready = false;
    this.info = {};

    this.t.onReply(b => this._onReply(b));
    if (this.t.onEvent) this.t.onEvent(e => this._onEvent(e));
  }

  onEvent(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }

  _emit(ev) { for (const cb of this.listeners) { try { cb(ev); } catch (e) { console.error(e); } } }

  _nextSeq() {
    this.seq = (this.seq + 1) % 65535;
    if (this.seq === 0) this.seq = 1;
    return this.seq;
  }

  _onReply(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (b.length < 3) return;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const seq = dv.getUint16(0, true);
    const err = b[2];
    const tx = this.pending.get(seq);
    if (!tx) return;
    this.pending.delete(seq);
    clearTimeout(tx.timer);
    if (err) tx.reject(new LoraxError(`device error 0x${err.toString(16)} for ${tx.label}`, { code: err, seq, op: tx.op }));
    else tx.resolve(b.subarray(3));
  }

  _onEvent(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.events.push(b);
    this._emit({ type: 'event', bytes: b });
  }

  /* One command, one reply, one at a time. */
  _command(op, payload, { label = '', expectReply = true } = {}) {
    const run = async () => {
      const seq = this._nextSeq();
      const cmd = new Uint8Array(3 + (payload ? payload.length : 0));
      new DataView(cmd.buffer).setUint16(0, seq, true);
      cmd[2] = op;
      if (payload) cmd.set(payload, 3);

      const reply = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(seq);
          reject(new LoraxError(`no reply for ${label || 'op ' + op} (${this.timeout} ms)`, { seq, op }));
        }, this.timeout);
        this.pending.set(seq, { resolve, reject, timer, label, op });
      });

      try {
        await this.t.write(cmd);
      } catch (e) {
        this.pending.delete(seq);
        throw e;
      }
      if (!expectReply) {
        /* WRITE_SHORT is fire-and-forget: the device only replies on error, and
         * a late error still lands in _onReply against a cleared slot. Wait a
         * beat so an immediate rejection is not missed, then move on. */
        await sleep(30);
        const p = this.pending.get(seq);
        if (p) { this.pending.delete(seq); clearTimeout(p.timer); return new Uint8Array(0); }
        return new Uint8Array(0);
      }
      return reply;
    };

    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  /* ---------------------------------------------------------- short I/O */

  async readRaw(path) {
    const p = new Uint8Array(4 + path.length);
    const dv = new DataView(p.buffer);
    dv.setUint16(0, 0, true);
    dv.setUint16(2, this.maxPayload, true);
    for (let i = 0; i < path.length; i++) p[4 + i] = path.charCodeAt(i) & 0xff;
    return this._command(OP.READ_SHORT, p, { label: 'read ' + path });
  }

  async writeRaw(path, data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const p = new Uint8Array(3 + path.length + 1 + bytes.length);
    const dv = new DataView(p.buffer);
    dv.setUint16(0, 0, true);
    /* The 4th byte is a write flag the app sets only for the device name; every
     * other path is written with 0. Copied from the official client verbatim. */
    p[2] = path.endsWith('/name') ? 4 : 0;
    for (let i = 0; i < path.length; i++) p[3 + i] = path.charCodeAt(i) & 0xff;
    p[3 + path.length] = 0;
    p.set(bytes, 4 + path.length);
    return this._command(OP.WRITE_SHORT, p, { label: 'write ' + path, expectReply: false });
  }

  async read(path, type) {
    const raw = await this.readRaw(path);
    return dec(type, raw);
  }

  async write(path, type, value) {
    return this.writeRaw(path, enc(type, value));
  }

  /* ------------------------------------------------------------- setup */

  async version() {
    const raw = await this.readRaw('/p/app/ver');
    return dec(TYPE.U32, raw);
  }

  async limits() {
    const raw = await this._command(OP.GET_LIMITS, null, { label: 'getLimits' });
    if (raw.length < 6) return { maxPayload: 200, maxFiles: 0, maxCommands: 0 };
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    return { maxPayload: dv.getUint16(0, true), maxFiles: dv.getUint16(2, true), maxCommands: dv.getUint16(4, true) };
  }

  /* Seed → token → unlock. Firmware X refuses reads and writes until this lands,
   * so it runs before anything else and its result is verified by a real read.
   *
   * Two token shapes exist; which one a given firmware wants is not documented.
   * We try the handshake key first, then the seed-only form, and accept only
   * when a subsequent read returns data — never on the absence of an error. */
  async authenticate({ onStep = () => {} } = {}) {
    onStep('seed');
    const seedRaw = await this._command(OP.GET_ACCESS_SEED, null, { label: 'getAccessSeed' });
    if (seedRaw.length < 16) throw new LoraxError('device returned a short access seed');
    const seed = seedRaw.subarray(0, 16);

    const attempts = [
      { mode: 'key', key: KEYS.lorax, label: 'lorax handshake' },
      { mode: 'seed', key: null, label: 'seed-only' },
    ];

    for (const a of attempts) {
      onStep('unlock:' + a.label);
      try {
        const token = await authToken(seed, a.key, a.mode);
        await this._command(OP.UNLOCK_ACCESS, token, { label: 'unlock ' + a.label });
      } catch {
        continue; /* a rejected token is expected on the wrong variant */
      }
      try {
        const probe = await this.readRaw('/p/bat/soc');
        if (probe.length > 0) { this.authMode = a.label; return a.label; }
      } catch { /* fall through to the next attempt */ }
    }
    throw new LoraxError('the device refused every unlock variant');
  }

  /* Full bring-up. Throws with a human message at the first thing that fails. */
  async start({ onStep = () => {} } = {}) {
    onStep('limits');
    try {
      const lim = await this.limits();
      if (lim.maxPayload >= 20 && lim.maxPayload <= 4096) this.maxPayload = lim.maxPayload;
    } catch { /* limits are optional; the default payload works */ }

    onStep('version');
    let ver = null;
    try { ver = await this.version(); } catch { /* not fatal */ }
    this.info.version = ver;

    const mode = await this.authenticate({ onStep });
    this.authMode = mode;

    onStep('identity');
    const read = async (path, type) => {
      try { return await this.read(path, type); } catch { return null; }
    };
    this.info.firmware = revisionString(await read('/p/sys/fw/ver', TYPE.U32));
    this.info.serial = await read('/p/sys/hw/ser', TYPE.STRING);
    this.info.model = await read('/p/sys/hw/mdcd', TYPE.U32);
    this.info.hw = await read('/p/sys/hw/ver', TYPE.STRING);
    this.info.name = await read('/u/sys/name', TYPE.STRING);
    this.info.chamber = await read('/p/htr/chmt', TYPE.U8);
    this.info.uptime = await read('/p/sys/uptm', TYPE.FLOAT);

    this.ready = true;
    return this.info;
  }
}
