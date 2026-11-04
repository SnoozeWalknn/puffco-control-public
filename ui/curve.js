/* Puffco temperature-curve engine — host-driven setpoint shaping.
 *
 * Firmware fact (see protocol/PROTOCOL.md §5): the Peak accepts a live setpoint
 * OFFSET during a heat cycle at `/p/app/tmpo` (Lorax, FLOAT, Celsius) or the
 * `temperatureOverride` characteristic 0x45 (flat GATT). It is a DELTA added to
 * the active profile temperature, not an absolute value — the official app's
 * own boost path writes `currentTarget - profileBaseTemp + boostDelta`.
 *
 * There is no curve mode in firmware. A curve is therefore executed by the host:
 * sample the curve once per tick, convert to a delta, write it, and let the
 * device's closed-loop heater follow. Everything here is pure: the clock, the
 * write guard and the session lifecycle live in the host-side governor.
 *
 * VERIFIED on hardware 2026-11-03 (Peak Pro 3DXL V2, firmware AW, model 13):
 * offset 10 °C moved the device target 501 → 519 °F, 20 °C → 537 °F, and 0 °C
 * returned it to 501 °F exactly. The offset is session-scoped — while idle the
 * same writes store nothing — and the chamber follows seconds later, so a curve
 * is a request the thermal mass may not meet.
 *
 * Units: every internal value is Celsius (the wire unit). Fahrenheit only exists
 * at the edges (curve authoring, display).
 */

export const F_TO_C = 5 / 9;

export function fToC(f) { return (f - 32) * F_TO_C; }
export function cToF(c) { return c * 9 / 5 + 32; }

/* Puffco publishes no temperature limits over the wire (Lorax GET_LIMITS returns
 * transport limits only: maxPayload/maxFiles/maxCommands). Bounds come from the
 * official app's constants: 400–644 °F for the default chamber family. The device
 * clamps profile temperature itself, but an override delta is our responsibility. */
export const LIMITS_C = Object.freeze({
  min: fToC(400),   // 204.44 °C
  max: fToC(644),   // 340.00 °C
});

/* Offset bounds.
 *
 * The official app's boost UI only offers 0–20 °C **upward**, and this file used
 * to clamp there on that basis. That was wrong twice over.
 *
 * Measured 2026-11-03 on firmware AW, all read back exactly and all linear at
 * 1.8 °F per °C:
 *
 *   positive: 25, 30, 40, 60 and 80 °C accepted (80 °C → +144 °F)
 *   negative: −5, −10, −20, −30 and −40 °C accepted (−40 °C → −72 °F), and 0
 *             returned to the exact baseline afterwards
 *
 * So the register is signed and the app's 0…20 is a UI choice, not a limit.
 *
 * 85 up / 45 down are our own ceilings, each one step past the highest verified
 * magnitude: at a 470 °F profile, +85 °C reaches `tcmd` ≈ 644 °F, the app-level
 * maximum, and −45 °C leaves most of the low end expressible.
 *
 * Negative offsets do not make the heater cool — it still cannot remove heat —
 * but they let a falling curve be *commanded* instead of inferred, so the loop
 * stops driving instead of the UI guessing. */
export const DELTA_LIMITS_C = Object.freeze({ min: -45, max: 85 });

/* Steady-state droop, °F.
 *
 * `/p/htr/tcmd` is the *coil* setpoint; `/p/htr/temp` is the chamber. They are
 * different thermal nodes and the chamber settles well below the commanded
 * value: measured gaps of 27–46 °F across a 16 s settle, with heater duty
 * floored near 10–12 % once the loop thinks it has arrived. Setting `tcmd` to
 * the temperature you want gets a chamber at `tcmd − gap`, which is the real
 * reason the chamber used to "stop at 488 °F": 20 °C of offset is only 36 °F,
 * and the gradient ate almost all of it.
 *
 * It is also **temperature-dependent and shrinks as it gets hotter**, so a single
 * number is only ever right in one band. Measured medians: 21-23 °F around
 * 480-500 °F, 27-46 °F around 490-540 °F. 22 is the low-band figure; using the
 * high-band 38 down here overshot by 25 °F. Re-measure before trusting it
 * outside 450-520 °F, and prefer a per-unit calibration once the loop is stable.
 *
 * To hold a chamber temperature, command the coil hotter by this much. */
export const COIL_CHAMBER_GAP_F = 22;

/* How fast the chamber can actually follow a moving target.
 *
 * Measured 2026-11-03 on a Peak Pro 3DXL V2 (firmware AW): a +20 °C step in the
 * offset moved the chamber about 8 °F in 2.5 s — roughly 3 °F/s at first, and
 * decaying from there because the element can only add heat, not remove it.
 * 1 °F/s is the rate it holds comfortably; a curve steeper than that will trail
 * its line rather than follow it. */
export const MAX_FOLLOW_F_PER_SEC = 1.0;

/* Session length, and why it is not one number.
 *
 * The budget is `profile time + timo`, and the two halves have different caps:
 *
 *   profile time (`/u/app/hc/%N/time`)  carries up to 120 s, and an idle write
 *                                       of it only yields half until re-armed
 *   timo (`/p/app/timo`)                adds up to 180 s more, live only
 *
 * Measured 2026-11-03 on firmware AW, all by reading the device's own
 * `stat/tott`:  120 + 0 → 120,  120 + 80 → **200**,  120 + 180 → **300**, and a
 * session set to 300 s was still running at 81 s.
 *
 * So `SESSION_LIFE_S` is the real ceiling, 300, and a curve longer than 120 s is
 * reached by adding `timo` rather than by asking the profile for more. Anything
 * past 300 still has to span sessions. */
export const SESSION_PROFILE_MAX_S = 120;
export const TIMO_MAX_S = 180;
export const SESSION_LIFE_S = SESSION_PROFILE_MAX_S + TIMO_MAX_S;

/* How much `timo` a session of `seconds` needs beyond the profile's own budget.
 * Zero below the profile cap; clamped to what the register accepts. */
export function timoForSession(seconds, profileS = SESSION_PROFILE_MAX_S) {
  return Math.max(0, Math.min(TIMO_MAX_S, seconds - profileS));
}

/* Fixed bias between profile temperature and the commanded coil target.
 *
 * With the profile at 470 °F and the offset at zero, `tcmd` still reads 491 °F:
 * the firmware aims ~21 °F above the stored profile by itself. Compensating it
 * is what lets the offset be treated as an absolute control rather than a
 * relative nudge. Measured 2026-11-03. */
export const PROFILE_TCMD_BIAS_F = 21;

/* Steepest climb in a normalised curve, in °F per second of curve time. */
export function steepestRateF(pts, unit = 'F') {
  let worst = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const dt = pts[i + 1].t - pts[i].t;
    if (dt <= 0) continue;
    const dv = Math.abs(unit === 'F' ? pts[i + 1].c * 9 / 5 + 32 - (pts[i].c * 9 / 5 + 32) : pts[i + 1].c - pts[i].c);
    worst = Math.max(worst, dv / dt);
  }
  return worst;
}

export const MODES = Object.freeze(['step', 'ramp', 'smooth']);

function fail(msg) { const e = new Error(msg); e.invalid = true; throw e; }

/* ---------------------------------------------------------------- validation */

/* Accepts points in either unit and returns a canonical, ascending, Celsius list.
 * Rejects anything ambiguous rather than guessing: a curve that silently drops a
 * point is a curve that heats to the wrong temperature. */
export function normalizePoints(points, unit = 'F') {
  if (!Array.isArray(points) || points.length < 2) fail('a curve needs at least two points');
  const toC = unit === 'C' ? (v => v) : unit === 'F' ? fToC : null;
  if (!toC) fail('unit must be F or C');
  const out = [];
  for (const p of points) {
    if (!p || typeof p.t !== 'number' || typeof p.v !== 'number') fail('each point needs numeric t and v');
    if (!Number.isFinite(p.t) || !Number.isFinite(p.v)) fail('curve values must be finite');
    if (p.t < 0) fail('time cannot be negative');
    const c = toC(p.v);
    const prev = out[out.length - 1];
    if (prev && p.t === prev.t) {
      if (Math.abs(c - prev.c) > 1e-9) fail('two points share t=' + p.t + ' with different temperatures');
      continue;
    }
    if (prev && p.t < prev.t) fail('points must be in ascending time order');
    out.push({ t: p.t, c });
  }
  if (out.length < 2) fail('a curve needs at least two distinct times');
  return out;
}

/* --------------------------------------------------------------- evaluation */

function slopes(pts) {
  const n = pts.length, d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) d.push((pts[i + 1].c - pts[i].c) / (pts[i + 1].t - pts[i].t));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  /* Fritsch–Carlson limiter: the curve passes through every point and cannot
   * overshoot past a local extreme, so a 'smooth' curve never commands a
   * temperature the author never asked for. */
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const tau = 3 / Math.sqrt(s); m[i] = tau * a * d[i]; m[i + 1] = tau * b * d[i]; }
  }
  return m;
}

/* Commanded chamber temperature (Celsius) at t seconds. */
export function evalAt(pts, mode, t) {
  if (mode !== 'step' && mode !== 'ramp' && mode !== 'smooth') fail('unknown mode ' + mode);
  if (t <= pts[0].t) return pts[0].c;
  const last = pts[pts.length - 1];
  if (t >= last.t) return last.c;

  let i = 0;
  while (i < pts.length - 2 && pts[i + 1].t <= t) i++;
  const p0 = pts[i], p1 = pts[i + 1];
  if (mode === 'step') return p0.c;
  if (mode === 'ramp') return p0.c + (p1.c - p0.c) * ((t - p0.t) / (p1.t - p0.t));

  const h = p1.t - p0.t, u = (t - p0.t) / h;
  const m = slopes(pts);
  const h00 = 2 * u ** 3 - 3 * u ** 2 + 1, h10 = u ** 3 - 2 * u ** 2 + u;
  const h01 = -2 * u ** 3 + 3 * u ** 2, h11 = u ** 3 - u ** 2;
  return h00 * p0.c + h10 * h * m[i] + h01 * p1.c + h11 * h * m[i + 1];
}

/* --------------------------------------------------------------- plan build */

/* Wire delta, in Celsius, that lands the chamber on `chamberC`.
 *
 * deltaC = (chamberC − profileC) + (gapF − biasF) * 5/9
 *
 * The 32 °F cancels because both sides are differences. */
export function deltaForChamber(chamberC, profileC, gapF = COIL_CHAMBER_GAP_F, biasF = PROFILE_TCMD_BIAS_F) {
  return (chamberC - profileC) + (gapF - biasF) * F_TO_C;
}

/* Highest chamber temperature a given offset ceiling can reach off `profileC`.
 * Used to tell "the device cannot get there" apart from "our own clamp bit". */
export function chamberReachC(profileC, maxDeltaC, gapF = COIL_CHAMBER_GAP_F, biasF = PROFILE_TCMD_BIAS_F) {
  return profileC + maxDeltaC - (gapF - biasF) * F_TO_C;
}

/* Turns a curve into the exact sequence of writes the runner will emit.
 *
 * The curve is expressed as *chamber* temperature, because that is the number a
 * person actually cares about. The device, however, does not take a chamber
 * temperature: `/p/app/tmpo` offsets `/p/htr/tcmd`, which is the **coil**
 * setpoint, and the chamber settles `gap` degrees under it while the firmware
 * aims `bias` degrees above the stored profile on its own. So the wire delta is
 *
 *     deltaC = (chamberC + gap − profileC + bias) / 1.8
 *
 * expressed in Celsius, because the register is Celsius and the relation between
 * it and `tcmd` is 1.8 °F per unit. Getting this wrong is what made the chamber
 * stop at 488 °F: a naive `chamber − profile` loses both terms and undershoots
 * by `gap − bias`, about 17 °F, every tick.
 *
 * Slew limiting exists because a curve's own slope can exceed what the heater
 * should be asked for in one step; clamping the command rate keeps every write a
 * small correction rather than a shock to the control loop.
 *
 * A falling segment is flagged 'decay-limited' when the curve drops faster than
 * the chamber can physically cool: the heater can only stop, so real temperature
 * will sit above the commanded line. Reporting it beats silently lying. */
export function buildPlan(curve, opts = {}) {
  const {
    profileC,
    unit = 'F',
    tickSec = 1,
    maxSlewCPerSec = 3,
    deadbandC = 0.5,
    maxDecayCPerSec = 1.5,
    limits = LIMITS_C,
    deltaLimits = DELTA_LIMITS_C,
    gapF = COIL_CHAMBER_GAP_F,
    biasF = PROFILE_TCMD_BIAS_F,
    sessionLifeS = SESSION_LIFE_S,
  } = opts;
  if (typeof profileC !== 'number' || !Number.isFinite(profileC)) fail('profileC is required (the active profile temperature)');
  if (!(tickSec > 0)) fail('tickSec must be positive');
  if (!(maxSlewCPerSec > 0)) fail('maxSlewCPerSec must be positive');
  if (limits.min > limits.max) fail('limits are inverted');
  if (!Number.isFinite(gapF) || !Number.isFinite(biasF)) fail('gapF and biasF must be finite');

  const pts = normalizePoints(curve.points, unit);
  const mode = curve.mode || 'smooth';
  const duration = pts[pts.length - 1].t;
  const warnings = new Set();
  const steps = [];

  let cmd = Math.min(Math.max(pts[0].c, limits.min), limits.max);
  if (cmd !== pts[0].c) warnings.add('clamped-to-limits');
  let lastWritten = null;

  for (let t = 0; t <= duration + 1e-9; t += tickSec) {
    const want = evalAt(pts, mode, t);

    if (want > limits.max || want < limits.min) warnings.add('clamped-to-limits');
    let target = Math.min(Math.max(want, limits.min), limits.max);

    const dv = target - cmd;
    const cap = maxSlewCPerSec * tickSec;
    if (Math.abs(dv) > cap) {
      target = cmd + Math.sign(dv) * cap;
      warnings.add('slew-limited');
      if (dv < 0) warnings.add('decay-limited');
    }
    if (dv < -maxDecayCPerSec * tickSec) warnings.add('decay-limited');
    cmd = target;

    let delta = deltaForChamber(cmd, profileC, gapF, biasF);
    if (delta > deltaLimits.max) {
      if (chamberReachC(profileC, deltaLimits.max, gapF, biasF) < cmd) warnings.add('unreachable-target');
      else warnings.add('delta-clamped');
      delta = deltaLimits.max;
    }
    if (delta < deltaLimits.min) {
      warnings.add('delta-clamped');
      delta = deltaLimits.min;
    }

    /* Only emit a write when the wire value actually changes. The device holds
     * its setpoint between writes, so a silent tick is a no-op, not a gap. */
    if (lastWritten === null || Math.abs(delta - lastWritten) >= deadbandC) {
      steps.push({ t: Math.round(t * 1000) / 1000, cmdC: cmd, deltaC: delta, seg: Math.floor(t / sessionLifeS) });
      lastWritten = delta;
    }
  }

  /* Segments come from the clock, not from the emitted steps: a flat curve emits
   * a single write and would otherwise look like one short session. */
  const segments = Math.max(1, Math.ceil(duration / sessionLifeS - 1e-9));
  if (segments > 1) { warnings.add('longer-than-session'); warnings.add('session-split'); }

  return { steps, warnings: [...warnings], duration, profileC, points: pts, mode, segments, sessionLifeS };
}

/* ---------------------------------------------------------------- templates */

/* The Dr Dabber "dynamic heating modes" are firmware behaviours. These reproduce
 * their shape as setpoint curves, which is the closest a host can get on a device
 * that only exposes a setpoint offset. */
/* Every shape here starts at or above the profile temperature, because the
 * offset is 0 … +20 °C — it cannot command below the profile.
 *
 * A "valley" shape (dip below, then return) was removed for that reason: it
 * needs a negative offset, which the firmware does not accept. Offering it would
 * have drawn a curve the device could never run. */
export const TEMPLATES = Object.freeze({
  steady:  { mode: 'step',   label: 'Steady — flat hold' },
  ascent:  { mode: 'ramp',   label: 'Ascent — ramps up through the hit' },
  descent: { mode: 'ramp',   label: 'Descent — starts hot, eases down to the profile' },
  hill:    { mode: 'smooth', label: 'Hill — rise then fall back' },
  steep:   { mode: 'smooth', label: 'Steep — fast rise, then hold high' },
});

/* Builds a template in the given display unit around a base temperature.
 * `span` is the total excursion in that unit; `hold` is the session length. */
export function template(name, { base, span = 30, hold = 60, unit = 'F' } = {}) {
  const t = TEMPLATES[name];
  if (!t) fail('unknown template ' + name);
  const up = span;
  const pts = {
    steady:  [{ t: 0, v: base }, { t: hold, v: base }],
    ascent:  [{ t: 0, v: base }, { t: hold, v: base + up }],
    descent: [{ t: 0, v: base + up }, { t: hold, v: base }],
    hill:    [{ t: 0, v: base }, { t: hold * 0.55, v: base + up }, { t: hold, v: base }],
    steep:   [{ t: 0, v: base }, { t: Math.min(8, hold / 4), v: base + up }, { t: hold, v: base + up }],
  }[name];
  return { name, points: pts, mode: t.mode, unit };
}

/* The runner lived here. A curve is now executed by the host-side governor
 * (ui/curve-governor.js) driving the live session target; this module is
 * pure planning and evaluation only. */
