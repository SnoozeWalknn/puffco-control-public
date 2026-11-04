/* End-to-end proof of the curve loop without hardware.
 *   ~/.local/opt/node/bin/node ui/demo_curve.mjs [template] [speed]
 *
 * Runs the REAL CurveRunner against a simulated heater, compressed in time, and
 * prints commanded vs actual. The heater model is a first-order lag with a rise
 * cap and passive cooling — plausible, not measured. Its job is to prove the
 * runner emits the right deltas at the right moments and stops safely. */
import { buildPlan, template, CurveRunner, cToF, fToC } from './curve.js';

const name = process.argv[2] || 'ascent';
const speed = Number(process.argv[3] || 20);

const BASE_F = 500;
const HOLD = 60;
const profileC = fToC(BASE_F);

const plan = buildPlan(template(name, { base: BASE_F, span: 30, hold: HOLD }),
  { profileC, tickSec: 1, maxSlewCPerSec: 3, maxDecayCPerSec: 1.5 });

/* ---- simulated chamber ------------------------------------------------- */
let actual = profileC;
let cmd = profileC;
const RISE_C_PER_S = 9, LAG = 0.55, COOL_C_PER_S = 1.1;
let lastSim = Date.now();
const trace = [];
const samples = [];

const byT = new Map(plan.steps.map(s => [s.t, s]));
const sessionStart = Date.now();
const scale = speed;                       // curve seconds per wall second
const now = () => sessionStart + (Date.now() - sessionStart) * scale;

function stepSim() {
  const wall = Date.now(), dt = (wall - lastSim) / 1000 * scale;
  lastSim = wall;
  const t = Math.floor((now() - sessionStart) / 1000);
  const s = byT.get(t);
  if (s) cmd = s.cmdC;
  const err = cmd - actual;
  actual += err > 0 ? Math.min(err * LAG, RISE_C_PER_S) * dt : Math.max(err * LAG, -COOL_C_PER_S) * dt;
  trace.push({ t, cmd, actual });
  if (t % 5 === 0 && samples[samples.length - 1]?.t !== t) samples.push({ t, cmd, actual });
}

/* ---- runner ------------------------------------------------------------ */
const runner = new CurveRunner({
  plan,
  now,
  tickMs: 20,
  staleMs: 5000,
  write: d => {
    /* The device holds the profile temperature plus this offset. */
    cmd = profileC + d;
    return Promise.resolve();
  },
  state: () => ({ inHeatCycle: true, lastFrameAgeMs: 0 }),
  onEvent: e => { if (e.type === 'stop') console.log(`\nrunner stopped: ${e.reason}`); },
});

console.log(`curve: ${name}  (${plan.duration}s of curve at ${speed}×)`);
console.log(`profile ${BASE_F}°F   points ${plan.points.length}   writes ${plan.steps.length}` +
  (plan.warnings.length ? `   warnings: ${plan.warnings.join(', ')}` : '   warnings: none'));
console.log('');

runner.start();
const sim = setInterval(stepSim, 20);

const done = new Promise(res => {
  const check = setInterval(() => {
    if (runner.stopped) { clearInterval(check); clearInterval(sim); setTimeout(res, 200); }
  }, 20);
});

await done;

/* ---- report ------------------------------------------------------------ */
const fmt = v => cToF(v).toFixed(0).padStart(4);
console.log('  t   commanded   actual   Δ');
for (const s of samples) {
  const d = cToF(s.actual) - cToF(s.cmd);
  const bar = ' '.repeat(Math.max(0, Math.round((cToF(s.actual) - 460) / 4))) + '#';
  console.log(`${String(s.t).padStart(3)}s  ${fmt(s.cmd)}°F    ${fmt(s.actual)}°F  ${(d >= 0 ? '+' : '') + d.toFixed(0).padStart(3)}   ${bar}`);
}
const worst = Math.max(...trace.map(x => Math.abs(cToF(x.cmd) - cToF(x.actual))));
const deltas = plan.steps.map(s => s.deltaC);
console.log(`\nworst tracking error ${worst.toFixed(1)}°F   ` +
  `delta range ${deltas[0].toFixed(1)}…${Math.max(...deltas).toFixed(1)}°C   ` +
  `writes ${runner.writes}   stop ${runner.stopped}`);
