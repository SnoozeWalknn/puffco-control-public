/* Adapts the app's Device to the curve governor's client interface.
 *
 * The governor wants a handful of named methods (setLiveTarget, readHeaterTarget,
 * writeTemperature, startSession …). The app already owns a Device with the same
 * capabilities, reached over whichever transport is active. This presents one as
 * the other so the governor drives the existing connection rather than opening a
 * second.
 *
 * Telemetry freshness matters more than it looks. `Device.get()` turns any read
 * failure into `null`, and the governor used to read that as "the device stopped
 * heating" and abort its own run. Every value here therefore carries the time it
 * was observed, and `operating_state` distinguishes UNKNOWN from IDLE.
 */

import { cToF, fToC, COIL_CHAMBER_GAP_F } from './curve.js';
import { IN_SESSION } from './device.js';
import { TYPE } from './proto/lorax.js';

/* A reading older than this is not evidence of anything. The app polls at 400 ms
 * in session, so this tolerates several missed polls before going stale. */
export const STALE_MS = 2000;

export function adaptDevice(dev) {
  const ok = async fn => { try { await fn(); return true; } catch { return false; } };

  /* Last observation, with its timestamp. Written only by noteChamber/noteState. */
  const seen = { state: null, stateAt: 0, tempC: null, tempAt: 0 };

  const ageOf = at => (at ? performance.now() - at : Infinity);

  return {
    get isConnected() { return !!dev; },

    /* The coil runs hotter than the chamber. Measured on this unit: chamber
     * 426 °F at tcmd 450 °F. The governor adds this to a chamber target before
     * writing, so the curve tracks the chamber instead of the coil. */
    chamberGapF: COIL_CHAMBER_GAP_F,

    telemetry: {
      /* Chamber in °F, as the governor expects. */
      get live_temp_f() {
        return seen.tempC == null || ageOf(seen.tempAt) > STALE_MS ? 0 : cToF(seen.tempC);
      },
      get temp_age_ms() { return ageOf(seen.tempAt); },
      get state_age_ms() { return ageOf(seen.stateAt); },

      /* 'UNKNOWN' is a distinct answer from 'IDLE'. The governor treats only an
       * explicit idle state as evidence that the session ended. */
      get operating_state() {
        if (seen.state == null || ageOf(seen.stateAt) > STALE_MS) return 'UNKNOWN';
        if (seen.state === 8) return 'HEAT_ACTIVE';
        if (seen.state === 7) return 'HEAT_PREHEAT';
        if (seen.state === 9) return 'COOLDOWN';
        if (seen.state === 5) return 'IDLE';
        if (seen.state === 4) return 'OFF';
        return String(seen.state);
      },

      /* Derived, never assigned: a getter with no setter throws on assignment in
       * a module, which is how this used to break the poll loop. */
      get is_heating() {
        if (seen.state == null || ageOf(seen.stateAt) > STALE_MS) return null;
        return IN_SESSION.has(seen.state);
      },

      active_profile: 0,
      profiles: [],
      target_temp_f: 0,
      firmware_version: null,
    },

    addDisconnectListener(fn) { dev.onLost = fn; },
    removeDisconnectListener() { dev.onLost = null; },

    /** App calls this whenever it has a fresh chamber reading. */
    noteChamber(celsius) {
      if (typeof celsius !== 'number' || !Number.isFinite(celsius)) return;
      seen.tempC = celsius;
      seen.tempAt = performance.now();
    },

    /** App calls this whenever it has a fresh device state. */
    noteState(n) {
      if (typeof n !== 'number' || !Number.isFinite(n)) return;  // a failed read is not a state
      seen.state = n;
      seen.stateAt = performance.now();
      dev.lastState = n;
    },

    async readPath() { return new Uint8Array(0); },

    /** Move the running session's target. Returns false rather than throwing so
     *  the governor can demote to the offset. */
    async setLiveTarget(tempF) {
      try { await dev.setLiveTemp(fToC(tempF)); return true; }
      catch (e) { console.warn('[adapter] setLiveTemp failed:', e.message); return false; }
    },

    /** The heater's real target — the governor's ground truth. */
    async readHeaterTarget() {
      /* dev.get swallows errors to null; go through the protocol layer so a
       * failure is distinguishable from a zero reading. */
      try {
        const c = await dev.l.read('/p/htr/tcmd', TYPE.FLOAT);
        if (typeof c !== 'number' || c <= 0) return null;
        return cToF(c);
      } catch (e) { console.warn('[adapter] tcmd:', e.message); return null; }
    },

    async readLiveBase() {
      try { const c = await dev.getLiveTemp(); return c == null ? null : cToF(c); }
      catch { return null; }
    },

    async readOverride() {
      try { const c = await dev.getOverride(); return c == null ? null : c / (5 / 9); }
      catch { return null; }
    },

    async setOverride(dF) { return ok(() => dev.setOverride(dF * (5 / 9))); },

    async writeTemperature(tempF, slot = 0) {
      await dev.set(`/u/app/hc/${slot}/temp`, 'float', fToC(tempF));
      return true;
    },
    async writeDuration(seconds, slot = 0) {
      await dev.set(`/u/app/hc/${slot}/time`, 'float', seconds);
      return true;
    },
    async setProfile(slot) { return ok(() => dev.set('/p/app/hcs', 'u8', slot)); },

    /* The app starts the session and then hands over, so the governor must not
     * start a second one: on hardware that resets the cycle clock and, when the
     * slot differs, leaves the curve running on the wrong profile. */
    async startSession() {
      if (seen.state != null && IN_SESSION.has(seen.state)) return true;
      return ok(() => dev.startSession());
    },
    async stopSession() { return ok(() => dev.abortSession()); },

    /* Byte-for-byte profile backup, so a run restores what was actually in the
     * slot instead of writing guessed defaults over it. */
    async backupProfileRaw(slot) {
      const [temp, time, name] = await Promise.all([
        dev.get(`/u/app/hc/${slot}/temp`, TYPE.FLOAT),
        dev.get(`/u/app/hc/${slot}/time`, TYPE.FLOAT),
        dev.get(`/u/app/hc/${slot}/name`, TYPE.STRING),
      ]);
      return { temp, time, name };
    },
    async restoreProfileRaw(slot, raw) {
      if (!raw) return false;
      let wrote = false;
      if (typeof raw.temp === 'number') { await dev.set(`/u/app/hc/${slot}/temp`, 'float', raw.temp); wrote = true; }
      if (typeof raw.time === 'number') { await dev.set(`/u/app/hc/${slot}/time`, 'float', raw.time); wrote = true; }
      if (typeof raw.name === 'string' && raw.name) { await dev.set(`/u/app/hc/${slot}/name`, 'string', raw.name); wrote = true; }
      return wrote;
    },
  };
}
