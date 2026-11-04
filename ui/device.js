/* Device facade — semantic operations over Lorax paths.
 *
 * Every path here is taken from Puffco's own bundle (2.4.3) and cross-checked
 * against an independently written community client. Types come from the bundle's
 * PATH_CONFIG table. Nothing in this file invents an address.
 *
 * Paths marked HIDDEN are readable but never surfaced by the official app —
 * they are the reason this app can show power, resistance and duty.
 */

import { TYPE, Lorax, revisionIndex } from './proto/lorax.js';

export const P = Object.freeze({
  /* identity */
  fwVersion: '/p/sys/fw/ver',
  fwGit: '/p/sys/fw/gith',
  model: '/p/sys/hw/mdcd',
  serial: '/p/sys/hw/ser',
  hw: '/p/sys/hw/ver',
  name: '/u/sys/name',
  birthday: '/u/sys/bday',
  uptime: '/p/sys/uptm',

  /* session */
  mode: '/p/app/mc',
  state: '/p/app/stat/id',
  elapsed: '/p/app/stat/elap',
  total: '/p/app/stat/tott',
  temp: '/p/htr/temp',
  tempCmd: '/p/htr/tcmd',
  tempOverride: '/p/app/tmpo',
  timeOverride: '/p/app/timo',
  chamber: '/p/htr/chmt',
  /* the LIVE session target; the hc/%N paths are the stored shelf */
  liveTemp: '/p/app/thc/temp',
  liveTime: '/p/app/thc/time',
  liveName: '/p/app/thc/name',

  /* heater telemetry (HIDDEN in the official app) */
  power: '/p/htr/pwr',
  duty: '/p/htr/duty',
  volts: '/p/htr/vavg',
  amps: '/p/htr/iavg',
  resistance: '/p/htr/res',

  /* profiles — %N is the slot index */
  profileCurrent: '/p/app/hcs',
  profileName: '/u/app/hc/%N/name',
  profileTemp: '/u/app/hc/%N/temp',
  profileTime: '/u/app/hc/%N/time',
  profileColor: '/u/app/hc/%N/colr',
  profileSpeed: '/u/app/hc/%N/scpd',
  profileBoostTemp: '/u/app/hc/%N/btmp',
  profileBoostTime: '/u/app/hc/%N/btim',
  profileThreshold: '/u/app/hc/%N/thrt',

  /* mood lights */
  lanternCmd: '/p/app/ltrn/cmd',
  lanternColor: '/p/app/ltrn/colr',
  lanternTime: '/p/app/ltrn/time',
  lanternSpeed: '/p/app/ltrn/scpd',
  lanternRemaining: '/p/app/ltrn/remt',
  brightness: '/u/app/ui/lbrt',
  stealth: '/u/app/ui/stlm',

  /* battery */
  soc: '/p/bat/soc',
  chargeState: '/p/bat/chg/stat',
  chargeEta: '/p/bat/chg/etf',
  batteryVolts: '/p/bat/volt',
  batteryAmps: '/p/bat/curr',
  batteryTemp: '/p/bat/temp',

  /* counters */
  totalDabs: '/p/app/odom/0/nc',
  totalTime: '/p/app/odom/0/tm',
  tripDabs: '/p/app/odom/1/nc',
  tripTime: '/p/app/odom/1/tm',
  dabsPerDay: '/p/app/info/dpd',
  dabsRemaining: '/p/app/info/drem',
});

export const MODE = Object.freeze({
  MASTER_OFF: 0, SLEEP: 1, IDLE: 2, TEMP_SELECT_BEGIN: 3, TEMP_SELECT_STOP: 4,
  SHOW_BATTERY: 5, SHOW_VERSION: 6, HEAT_CYCLE_START: 7, HEAT_CYCLE_ABORT: 8,
  HEAT_CYCLE_BOOST: 9, FACTORY_TEST: 10, BONDING: 11,
});

export const STATE = Object.freeze({
  0: 'init', 1: 'version', 2: 'battery', 3: 'off', 4: 'sleep', 5: 'idle',
  6: 'temp-select', 7: 'preheat', 8: 'active', 9: 'fade', 10: 'version',
  11: 'battery', 12: 'factory-test', 13: 'bonding',
});

export const IN_SESSION = new Set([7, 8, 9]);

/* Charge-state names. 4 is "not on the dock" — NOT a BLE disconnect, which is
 * why it is worded that way here; the old label read as a link fault. */
export const CHARGE = Object.freeze({
  0: 'bulk', 1: 'top-up', 2: 'full', 3: 'over-temp', 4: 'on battery',
});

/* Chamber codes, taken from Puffco's own app bundle — NOT the community library,
 * which has 2 and 4 the wrong way round. The bundle is authoritative:
 *   NONE 0, CLASSIC 1, XL 2, PERFORMANCE 3
 * A 3DXL reports 2. The library's "HERBAL = 2 / XL = 4" is a mistake, and it
 * made this app label a 3DXL as a herbal chamber. */
export const CHAMBER = Object.freeze({
  0: 'None', 1: 'Classic', 2: '3DXL', 3: 'Performance',
});

export const LANTERN_MODE = Object.freeze({
  PRESERVE: 0, STATIC: 1, BREATHING: 5, RISING: 6, CIRCLING: 7, CIRCLING_SLOW: 0x15,
});

const slot = (path, n) => path.replace('%N', String(n));

/* Wraps a Lorax client with the handful of operations the UI needs.
 * Reads are individually fallible: a path that a given firmware does not
 * implement returns null instead of failing the whole poll. */
export class Device {
  constructor(lorax) {
    this.l = lorax;
    this.info = lorax.info || {};
    this.lastFrame = Date.now();
    this.polling = false;
  }

  static async open(transport, opts) {
    const l = new Lorax(transport, opts);
    const info = await l.start(opts);
    return new Device(l);
  }

  get firmware() { return this.info.firmware || '?'; }
  get isNewerThanAG() { return revisionIndex(this.info.firmware) >= revisionIndex('AG'); }

  async get(path, type) {
    try {
      const v = await this.l.read(path, type);
      this.lastFrame = Date.now();
      return v;
    } catch { return null; }
  }

  async set(path, type, value) {
    await this.l.write(path, type, value);
    this.lastFrame = Date.now();
  }

  /* --------------------------------------------------------- status */

  /* Fast poll: only the fields that change second to second. Four reads instead
   * of eight, which is what the graph actually needs. */
  async statusFast() {
    const [state, temp, cmd, elapsed] = await Promise.all([
      this.get(P.state, TYPE.U8),
      this.get(P.temp, TYPE.FLOAT),
      this.get(P.tempCmd, TYPE.FLOAT),
      this.get(P.elapsed, TYPE.FLOAT),
    ]);
    return {
      state, stateName: STATE[state] || 'unknown',
      inSession: IN_SESSION.has(state),
      tempC: temp, targetC: cmd, elapsed,
      at: Date.now(),
    };
  }

  /* Slow poll: everything that changes over seconds or minutes. Battery and
   * charge state do not need reading 2.5 times a second. */
  async statusSlow() {
    const [total, soc, charge, eta] = await Promise.all([
      this.get(P.total, TYPE.FLOAT),
      this.get(P.soc, TYPE.FLOAT),
      this.get(P.chargeState, TYPE.U8),
      this.get(P.chargeEta, TYPE.FLOAT),
    ]);
    return {
      total, soc,
      chargeState: charge,
      chargeName: CHARGE[charge] || 'unknown',
      chargeEta: eta,
      at: Date.now(),
    };
  }

  async status() {
    const [state, temp, cmd, elapsed, total, soc, charge, eta] = await Promise.all([
      this.get(P.state, TYPE.U8),
      this.get(P.temp, TYPE.FLOAT),
      this.get(P.tempCmd, TYPE.FLOAT),
      this.get(P.elapsed, TYPE.FLOAT),
      this.get(P.total, TYPE.FLOAT),
      this.get(P.soc, TYPE.FLOAT),
      this.get(P.chargeState, TYPE.U8),
      this.get(P.chargeEta, TYPE.FLOAT),
    ]);
    return {
      state, stateName: STATE[state] || 'unknown',
      inSession: IN_SESSION.has(state),
      tempC: temp, targetC: cmd,
      elapsed, total,
      soc, chargeState: charge, chargeName: CHARGE[charge] || 'unknown', chargeEta: eta,
      at: Date.now(),
    };
  }

  async heater() {
    const [power, duty, volts, amps, resistance] = await Promise.all([
      this.get(P.power, TYPE.FLOAT),
      this.get(P.duty, TYPE.FLOAT),
      this.get(P.volts, TYPE.FLOAT),
      this.get(P.amps, TYPE.FLOAT),
      this.get(P.resistance, TYPE.FLOAT),
    ]);
    return { power, duty, volts, amps, resistance };
  }

  async counters() {
    const [totalDabs, tripDabs, totalTime, tripTime, perDay, remaining] = await Promise.all([
      this.get(P.totalDabs, TYPE.U32),
      this.get(P.tripDabs, TYPE.U32),
      this.get(P.totalTime, TYPE.FLOAT),
      this.get(P.tripTime, TYPE.FLOAT),
      this.get(P.dabsPerDay, TYPE.FLOAT),
      this.get(P.dabsRemaining, TYPE.U8),
    ]);
    return { totalDabs, tripDabs, totalTime, tripTime, perDay, remaining };
  }

  /* -------------------------------------------------------- session */

  async startSession() { await this.set(P.mode, TYPE.U8, MODE.HEAT_CYCLE_START); }
  async abortSession() {
    await this.set(P.mode, TYPE.U8, MODE.HEAT_CYCLE_ABORT);
    await this.set(P.mode, TYPE.U8, MODE.IDLE);
  }
  async boost() { await this.set(P.mode, TYPE.U8, MODE.HEAT_CYCLE_BOOST); }

  /* The curve primitive: a Celsius DELTA added to the active profile
   * temperature. The official app's own boost button writes
   * `currentTarget - profileBaseTemp + boostDelta`, which is what fixes the
   * semantics as a delta rather than an absolute setpoint. */
  async setOverride(deltaC) { await this.set(P.tempOverride, TYPE.FLOAT, deltaC); }
  /* Retargets a running session. Verified on hardware: tcmd follows within a
   * tick, and unlike the profile paths this is not refused while a cycle is up. */
  async setLiveTemp(celsius) { await this.set(P.liveTemp, TYPE.FLOAT, celsius); }
  async getLiveTemp() { return this.get(P.liveTemp, TYPE.FLOAT); }
  async getOverride() { return this.get(P.tempOverride, TYPE.FLOAT); }

  /* ------------------------------------------------------- profiles */

  async readProfile(n) {
    const [name, temp, time, boostTemp, boostTime, color] = await Promise.all([
      this.get(slot(P.profileName, n), TYPE.STRING),
      this.get(slot(P.profileTemp, n), TYPE.FLOAT),
      this.get(slot(P.profileTime, n), TYPE.FLOAT),
      this.get(slot(P.profileBoostTemp, n), TYPE.FLOAT),
      this.get(slot(P.profileBoostTime, n), TYPE.FLOAT),
      this.get(slot(P.profileColor, n), TYPE.BUFFER),
    ]);
    return { slot: n, name, tempC: temp, timeS: time, boostTempC: boostTemp, boostTimeS: boostTime, color };
  }

  async readProfiles(count = 4) {
    const out = [];
    for (let n = 0; n < count; n++) out.push(await this.readProfile(n));
    return out;
  }

  async currentProfile() { return this.get(P.profileCurrent, TYPE.U32); }

  async writeProfile(n, { name, tempC, timeS, boostTempC, boostTimeS }) {
    if (name != null) await this.set(slot(P.profileName, n), TYPE.STRING, name);
    if (tempC != null) await this.set(slot(P.profileTemp, n), TYPE.FLOAT, tempC);
    if (timeS != null) await this.set(slot(P.profileTime, n), TYPE.FLOAT, timeS);
    if (boostTempC != null) await this.set(slot(P.profileBoostTemp, n), TYPE.FLOAT, boostTempC);
    if (boostTimeS != null) await this.set(slot(P.profileBoostTime, n), TYPE.FLOAT, boostTimeS);
  }

  /* ----------------------------------------------------- mood lights */

  async setLantern(on) { await this.set(P.lanternCmd, TYPE.U8, on ? 1 : 0); }
  async setLanternTime(seconds) { await this.set(P.lanternTime, TYPE.FLOAT, seconds); }
  async lanternRemaining() { return this.get(P.lanternRemaining, TYPE.FLOAT); }

  /* Colour buffer: [r,g,b, mode, speed, 0,0,0] — the same 8-byte shape the
   * community client writes and the app's lantern editor produces. */
  async setLanternColor(r, g, b, mode = LANTERN_MODE.STATIC, speed = 0) {
    const buf = new Uint8Array([r & 255, g & 255, b & 255, mode & 255, speed & 255, 0, 0, 0]);
    await this.set(P.lanternColor, TYPE.BUFFER, buf);
  }

  /* Four brightness segments: ring, under-glass, main, battery. */
  async setBrightness(ring, glass, main, battery) {
    const buf = new Uint8Array([ring, glass, main, battery].map(v => Math.max(0, Math.min(255, v | 0))));
    await this.set(P.brightness, TYPE.BUFFER, buf);
  }

  async brightness() { return this.get(P.brightness, TYPE.BUFFER); }

  /* ---------------------------------------------------------- device */

  async setStealth(on) { await this.set(P.stealth, TYPE.U8, on ? 1 : 0); }
  async setName(name) { await this.set(P.name, TYPE.STRING, name); }
  async battery() {
    const [soc, state, eta, volts, amps, temp] = await Promise.all([
      this.get(P.soc, TYPE.FLOAT),
      this.get(P.chargeState, TYPE.U8),
      this.get(P.chargeEta, TYPE.FLOAT),
      this.get(P.batteryVolts, TYPE.FLOAT),
      this.get(P.batteryAmps, TYPE.FLOAT),
      this.get(P.batteryTemp, TYPE.FLOAT),
    ]);
    return { soc, state, name: CHARGE[state] || 'unknown', eta, volts, amps, tempC: temp };
  }

  /* A single cheap read used as a liveness probe by the curve runner. */
  async alive() { return this.get(P.state, TYPE.U8) != null; }
}
