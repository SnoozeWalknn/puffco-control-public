/* Tests for ui/curve.js — run: node ui/test_curve.mjs
 * No device needed. The heater simulation at the end is a first-order lag model,
 * not a claim about the Peak's real thermal response. */
import assert from 'node:assert/strict';
import {
  fToC, cToF, F_TO_C, LIMITS_C, DELTA_LIMITS_C, MODES,
  normalizePoints, evalAt, buildPlan, template, TEMPLATES,
  steepestRateF, MAX_FOLLOW_F_PER_SEC,
  COIL_CHAMBER_GAP_F, PROFILE_TCMD_BIAS_F, SESSION_LIFE_S,
  SESSION_PROFILE_MAX_S, TIMO_MAX_S, timoForSession,
} from './curve.js';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; console.log('FAIL ' + name + '\n  ' + (e && e.message)); }
};
const at = async (name, fn) => {
  try { await fn(); pass++; }
  catch (e) { fail++; console.log('FAIL ' + name + '\n  ' + (e && e.message)); }
};

/* ------------------------------------------------------------ conversions */
t('unit conversion round-trips', () => {
  assert.equal(Math.round(cToF(fToC(600))), 600);
  assert.ok(Math.abs(fToC(400) - 204.444) < 0.01);
});
t('limits bracket the official app constants', () => {
  assert.ok(Math.abs(cToF(LIMITS_C.min) - 400) < 1e-6);
  assert.ok(Math.abs(cToF(LIMITS_C.max) - 644) < 1e-6);
  /* 85, not 20: the device accepted 80 °C on hardware (2026-11-03) and the app's
 * 20 °C is only its boost UI. Reverting this re-breaks every curve above
 * profile+36 °F. */
  /* Negative floor added after hardware proved −5…−40 all store and move tcmd
   * down by 1.8 °F/°C. Reverting the floor turns every falling curve back into a
   * request the UI cannot express. */
  assert.deepEqual([DELTA_LIMITS_C.min, DELTA_LIMITS_C.max], [-45, 85]);
});

/* --------------------------------------------------------------- validation */
t('rejects single point', () => {
  assert.throws(() => normalizePoints([{ t: 0, v: 500 }], 'F'), /at least two/);
});
t('rejects descending time', () => {
  assert.throws(() => normalizePoints([{ t: 10, v: 500 }, { t: 5, v: 520 }], 'F'), /ascending/);
});
t('rejects duplicate time with different temperature', () => {
  assert.throws(() => normalizePoints([{ t: 0, v: 500 }, { t: 5, v: 500 }, { t: 5, v: 520 }], 'F'), /share t=5/);
});
t('rejects NaN', () => {
  assert.throws(() => normalizePoints([{ t: 0, v: NaN }, { t: 5, v: 500 }], 'F'), /finite/);
});
t('rejects bad unit', () => {
  assert.throws(() => normalizePoints([{ t: 0, v: 1 }, { t: 1, v: 2 }], 'K'), /unit must be/);
});
t('converts F authoring to C', () => {
  const p = normalizePoints([{ t: 0, v: 212 }, { t: 10, v: 392 }], 'F');
  assert.ok(Math.abs(p[0].c - 100) < 1e-9 && Math.abs(p[1].c - 200) < 1e-9);
});

/* -------------------------------------------------------------- evaluation */
const pts = normalizePoints([{ t: 0, v: 400 }, { t: 30, v: 600 }, { t: 60, v: 500 }], 'F');

t('step holds the previous point', () => {
  assert.equal(evalAt(pts, 'step', 0), pts[0].c);
  assert.equal(evalAt(pts, 'step', 29.9), pts[0].c);
  assert.equal(evalAt(pts, 'step', 30), pts[1].c);
  assert.equal(evalAt(pts, 'step', 60), pts[2].c);
});
t('ramp is linear between points', () => {
  const mid = evalAt(pts, 'ramp', 15);
  assert.ok(Math.abs(mid - (pts[0].c + pts[1].c) / 2) < 1e-9);
});
t('every mode passes through control points', () => {
  for (const m of MODES) {
    assert.ok(Math.abs(evalAt(pts, m, 0) - pts[0].c) < 1e-9, m + ' start');
    assert.ok(Math.abs(evalAt(pts, m, 30) - pts[1].c) < 1e-9, m + ' peak');
    assert.ok(Math.abs(evalAt(pts, m, 60) - pts[2].c) < 1e-9, m + ' end');
  }
});
t('smooth never overshoots the control points', () => {
  for (let s = 0; s <= 60; s += 0.25) {
    const v = evalAt(pts, 'smooth', s);
    assert.ok(v <= pts[1].c + 1e-9 && v >= Math.min(pts[0].c, pts[2].c) - 1e-9, 'at ' + s + ' got ' + v);
  }
});
t('clamps before start and after end', () => {
  assert.equal(evalAt(pts, 'ramp', -5), pts[0].c);
  assert.equal(evalAt(pts, 'ramp', 999), pts[2].c);
});

/* -------------------------------------------------------------------- plan */
const profileC = fToC(500);
const plan = buildPlan(
  { points: [{ t: 0, v: 480 }, { t: 10, v: 620 }, { t: 40, v: 620 }, { t: 70, v: 500 }], mode: 'smooth' },
  { profileC, unit: 'F', tickSec: 1, maxSlewCPerSec: 3, maxDecayCPerSec: 1.5 },
);

t('plan is chronological and bounded', () => {
  let prev = -1;
  for (const s of plan.steps) {
    assert.ok(s.t >= prev, 'time must not go backwards');
    prev = s.t;
    assert.ok(s.deltaC >= DELTA_LIMITS_C.min && s.deltaC <= DELTA_LIMITS_C.max, 'delta ' + s.deltaC);
    assert.ok(s.cmdC >= LIMITS_C.min - 1e-9 && s.cmdC <= LIMITS_C.max + 1e-9, 'cmd ' + s.cmdC);
  }
});
t('plan covers the whole curve duration', () => {
  assert.equal(plan.duration, 70);
  assert.ok(plan.steps[plan.steps.length - 1].t <= 70);
  assert.ok(plan.steps.length > 1);
});
t('deadband suppresses duplicate writes', () => {
  const flat = buildPlan({ points: [{ t: 0, v: 500 }, { t: 60, v: 500 }], mode: 'step' }, { profileC, tickSec: 1 });
  assert.equal(flat.steps.length, 1, 'a flat curve writes once, got ' + flat.steps.length);
});
t('slew limiting is enforced', () => {
  const jump = buildPlan({ points: [{ t: 0, v: 420 }, { t: 1, v: 640 }], mode: 'step' }, { profileC, tickSec: 1, maxSlewCPerSec: 3 });
  for (let i = 1; i < jump.steps.length; i++) {
    const d = jump.steps[i].cmdC - jump.steps[i - 1].cmdC;
    assert.ok(d <= 3 + 1e-9, 'step of ' + d + ' C exceeded the slew cap');
  }
  assert.ok(jump.warnings.includes('slew-limited'));
});
t('a hard drop is flagged decay-limited', () => {
  const drop = buildPlan({ points: [{ t: 0, v: 640 }, { t: 2, v: 420 }], mode: 'step' }, { profileC, tickSec: 1, maxSlewCPerSec: 60, maxDecayCPerSec: 1.5 });
  assert.ok(drop.warnings.includes('decay-limited'), 'warnings: ' + drop.warnings);
});
t('out-of-range targets are clamped and reported', () => {
  const hot = buildPlan({ points: [{ t: 0, v: 700 }, { t: 10, v: 700 }], mode: 'step' }, { profileC, tickSec: 1 });
  assert.ok(hot.warnings.includes('clamped-to-limits'));
  assert.ok(Math.abs(hot.steps[0].cmdC - LIMITS_C.max) < 1e-9);
});
t('a target below the profile yields a negative delta', () => {
  const p = buildPlan({ points: [{ t: 0, v: 440 }, { t: 5, v: 440 }], mode: 'step' },
    { profileC: fToC(470), tickSec: 1 });
  assert.ok(p.steps[0].deltaC < 0, 'got ' + p.steps[0].deltaC);
  assert.ok(!p.warnings.includes('delta-clamped'), 'a small negative must not clamp: ' + p.warnings);
});

t('delta is clamped to the offset envelope', () => {
  /* profile at 204 °C, curve asking for 340 °C → delta would be 136 °C */
  const wide = buildPlan({ points: [{ t: 0, v: 644 }, { t: 10, v: 644 }], mode: 'step' },
    { profileC: fToC(400), tickSec: 1, maxSlewCPerSec: 999 });
  assert.ok(wide.warnings.includes('unreachable-target'),
    'a 644 F target off a 400 F profile is out of reach, not merely clamped: ' + wide.warnings.join(','));
  assert.ok(wide.steps.every(s => s.deltaC <= DELTA_LIMITS_C.max + 1e-9));
});
t('delta carries gap and bias, not just the raw difference', () => {
  /* Chamber 520 F off a 500 F profile. The raw difference is 20 F, but the coil
   * must aim 38 F over the chamber while the firmware already aims 21 F over the
   * profile, so the wire delta is (20 + 38 - 21) F = 37 F, in Celsius. */
  const p = buildPlan({ points: [{ t: 0, v: 520 }, { t: 5, v: 520 }], mode: 'step' },
    { profileC: fToC(500), tickSec: 1 });
  const want = (20 + COIL_CHAMBER_GAP_F - PROFILE_TCMD_BIAS_F) * F_TO_C;
  assert.ok(Math.abs(p.steps[0].deltaC - want) < 1e-9, 'got ' + p.steps[0].deltaC + ' want ' + want);
});

t('a flat curve at the profile still asks for the gap', () => {
  /* The naive model emitted delta 0 here, which undershoots by gap - bias. */
  const p = buildPlan({ points: [{ t: 0, v: 500 }, { t: 5, v: 500 }], mode: 'step' },
    { profileC: fToC(500), tickSec: 1 });
  assert.ok(p.steps[0].deltaC > 0, 'delta must be positive, got ' + p.steps[0].deltaC);
  const want = (COIL_CHAMBER_GAP_F - PROFILE_TCMD_BIAS_F) * F_TO_C;
  assert.ok(Math.abs(p.steps[0].deltaC - want) < 1e-9);
});

t('gap=0 bias=0 reproduces the raw difference', () => {
  const p = buildPlan({ points: [{ t: 0, v: 520 }, { t: 5, v: 520 }], mode: 'step' },
    { profileC: fToC(500), tickSec: 1, gapF: 0, biasF: 0 });
  assert.ok(Math.abs(p.steps[0].deltaC - 20 * F_TO_C) < 1e-9);
});

t('a curve longer than a session is split and flagged', () => {
  const p = buildPlan({ points: [{ t: 0, v: 480 }, { t: SESSION_LIFE_S * 2, v: 480 }], mode: 'step' },
    { profileC: fToC(460), tickSec: 5 });
  assert.ok(p.segments >= 2, 'segments ' + p.segments);
  assert.ok(p.warnings.includes('longer-than-session'));
  assert.ok(p.warnings.includes('session-split'));
});

t('a curve inside one session is not split', () => {
  const p = buildPlan({ points: [{ t: 0, v: 480 }, { t: SESSION_LIFE_S - 5, v: 480 }], mode: 'step' },
    { profileC: fToC(460), tickSec: 5 });
  assert.equal(p.segments, 1);
  assert.ok(!p.warnings.includes('session-split'));
});

t('the measured coil/chamber model is carried in the code', () => {
  /* These three came from firmware AW on 2026-11-03 and the curve design is
   * meaningless without them: the chamber sits COIL_CHAMBER_GAP_F under the
   * commanded coil, the firmware aims PROFILE_TCMD_BIAS_F above the profile on
   * its own, and a session only sustains ~SESSION_LIFE_S of active phase. */
  assert.ok(COIL_CHAMBER_GAP_F >= 15 && COIL_CHAMBER_GAP_F <= 40, 'gap ' + COIL_CHAMBER_GAP_F);
  assert.ok(PROFILE_TCMD_BIAS_F > 10 && PROFILE_TCMD_BIAS_F < 40, 'bias ' + PROFILE_TCMD_BIAS_F);
  /* 120 measured, and only when the duration is re-armed during the cycle; an
   * idle write gets 60. Anything below 120 under-splits curves. */
  assert.equal(SESSION_LIFE_S, 300);
  assert.equal(SESSION_PROFILE_MAX_S, 120);
  assert.equal(TIMO_MAX_S, 180);
});

t('timo is asked for only above the profile cap', () => {
  /* Measured: 120 profile + 80 timo = 200 s on the device, 120 + 180 = 300.
   * A 200 s session must therefore ask for exactly 80 s of timo. */
  assert.equal(timoForSession(200), 80);
  assert.equal(timoForSession(300), 180);
  assert.equal(timoForSession(90), 0);
  assert.equal(timoForSession(500), 180);
});

t('the offset ceiling clears the profile range it has to serve', () => {
  /* 85 C = 153 F of addition. With the 400-644 F app range, the offset must be
   * able to carry a low profile to the top, or high curves are unreachable. */
  const reachF = DELTA_LIMITS_C.max * 1.8;
  assert.ok(reachF >= LIMITS_C.max - LIMITS_C.min, reachF + ' F of reach');
});

/* --------------------------------------------------------------- templates */
t('every template starts at or above its base', () => {
  /* The offset is 0 … +20 °C: it cannot command below the profile, so a shape
   * that dips under the base would be unrunnable on hardware. */
  for (const name of Object.keys(TEMPLATES)) {
    const c = template(name, { base: 500, span: 30, hold: 60, unit: 'F' });
    const low = Math.min(...c.points.map(p => p.v));
    assert.ok(low >= 500 - 1e-9, `${name} dips to ${low} °F, below its 500 °F base`);
  }
});

t('valley is gone', () => {
  assert.ok(!('valley' in TEMPLATES), 'valley needs a negative offset and must not be offered');
});

t('steepestRateF measures the climb rate', () => {
  /* 30 °F over 60 s is 0.5 °F/s. */
  const gentle = normalizePoints(template('ascent', { base: 500, span: 30, hold: 60, unit: 'F' }).points, 'F');
  assert.ok(Math.abs(steepestRateF(gentle, 'F') - 0.5) < 1e-6, 'got ' + steepestRateF(gentle, 'F'));

  /* The same span over 10 s is 3 °F/s — three times the followable rate. */
  const steep = normalizePoints(template('ascent', { base: 500, span: 30, hold: 10, unit: 'F' }).points, 'F');
  assert.ok(steepestRateF(steep, 'F') > MAX_FOLLOW_F_PER_SEC * 1.5);
});

t('templates build valid curves in both units', () => {
  for (const name of Object.keys(TEMPLATES)) {
    for (const unit of ['F', 'C']) {
      const base = unit === 'F' ? 500 : 260;
      const c = template(name, { base, span: unit === 'F' ? 30 : 17, hold: 60, unit });
      const p = normalizePoints(c.points, unit);
      assert.equal(p.length, c.points.length, name + '/' + unit);
    }
  }
});
t('ascent ends above its base', () => {
  const c = template('ascent', { base: 500, span: 30, hold: 60 });
  const p = normalizePoints(c.points, 'F');
  assert.ok(p[p.length - 1].c > p[0].c);
  assert.ok(Math.abs(cToF(p[p.length - 1].c) - 530) < 1e-6);
});
t('descent starts hot and ends at base', () => {
  const c = template('descent', { base: 500, span: 30, hold: 60 });
  const p = normalizePoints(c.points, 'F');
  assert.ok(Math.abs(cToF(p[0].c) - 530) < 1e-6);
  assert.ok(Math.abs(cToF(p[p.length - 1].c) - 500) < 1e-6);
});
t('steep reaches its peak early', () => {
  const c = template('steep', { base: 500, span: 30, hold: 60 });
  const p = normalizePoints(c.points, 'F');
  assert.ok(p[1].t <= 8, 'peak at ' + p[1].t);
});

/* -------------------------------------------------------------- simulation */
/* First-order lag heater: actual temperature approaches the setpoint at a rate
 * capped by the element, and cools passively when the setpoint drops. This is a
 * plausibility model for the runner loop, not a measured thermal model. */
function simulate(plan, { startC, riseCPerSec = 9, lag = 0.55, coolCPerSec = 1.1 } = {}) {
  let actual = startC, cmd = startC;
  const trace = [];
  const byT = new Map(plan.steps.map(s => [s.t, s]));
  const dur = plan.duration;
  for (let t = 0; t <= dur; t += 1) {
    const s = byT.get(t);
    if (s) cmd = s.cmdC;
    const err = cmd - actual;
    const step = err > 0 ? Math.min(err * lag, riseCPerSec) : Math.max(err * lag, -coolCPerSec);
    actual += step;
    trace.push({ t, cmd, actual });
  }
  return trace;
}

t('simulation: ascent curve is tracked within a sane band', () => {
  const p = buildPlan(template('ascent', { base: 500, span: 30, hold: 60 }),
    { profileC: fToC(500), tickSec: 1, maxSlewCPerSec: 3 });
  const tr = simulate(p, { startC: fToC(500) });
  const tail = tr.filter(x => x.t >= 30);
  const worst = Math.max(...tail.map(x => Math.abs(x.cmd - x.actual)));
  assert.ok(worst < 12, 'worst tracking error ' + worst.toFixed(1) + ' C');
  assert.ok(tr[tr.length - 1].actual > tr[0].actual, 'chamber must end hotter than it started');
});

t('simulation: a descent cannot outrun passive cooling', () => {
  /* 30 °F down in 8 s is far faster than the chamber can shed heat, so the
   * command line drops away from the real temperature — exactly the case the
   * 'decay-limited' warning exists to surface. */
  const p = buildPlan(template('descent', { base: 500, span: 30, hold: 8 }),
    { profileC: fToC(500), tickSec: 1, maxSlewCPerSec: 60, maxDecayCPerSec: 1.5 });
  const tr = simulate(p, { startC: fToC(530) });
  const lag = tr[tr.length - 1].actual - tr[tr.length - 1].cmd;
  assert.ok(lag > 0, 'actual must sit above the falling command (got ' + lag.toFixed(1) + ')');
  assert.ok(p.warnings.includes('decay-limited'), 'warnings: ' + p.warnings);
});

t('simulation: no commanded value ever leaves the limit band', () => {
  for (const name of Object.keys(TEMPLATES)) {
    const p = buildPlan(template(name, { base: 630, span: 40, hold: 45 }),
      { profileC: fToC(630), tickSec: 1, maxSlewCPerSec: 3 });
    for (const s of p.steps) {
      assert.ok(s.cmdC <= LIMITS_C.max + 1e-9 && s.cmdC >= LIMITS_C.min - 1e-9, name + ' at t=' + s.t);
      assert.ok(s.deltaC <= DELTA_LIMITS_C.max + 1e-9, name + ' delta at t=' + s.t);
    }
  }
});

console.log(`\ncurve: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
