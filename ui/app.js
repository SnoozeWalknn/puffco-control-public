/* App — state, routing, and the glue between the device and the screens.
 *
 * One rule runs through all of it: nothing in the UI claims something the
 * device did not report. Every number on screen came from a read; every write
 * is a single Lorax command whose result the next poll reflects. Where the
 * hardware cannot do something, the screen says so instead of hiding it.
 */

import { Device, P, STATE, CHARGE, CHAMBER, LANTERN_MODE, IN_SESSION } from './device.js';
import { TYPE } from './proto/lorax.js';
import { supported, pickDevice, BleTransport, BluetoothUnavailable, BridgeTransport, bridgeAvailable,
         bridgeMixedContent, BRIDGE_URL } from './ble.js';
import { createFakeLorax } from './fake_lorax.js';
import { adaptDevice } from './governor-adapter.js';
import './curves-data.js';      // defines window.interpolateCurveTarget
import './curve-governor.js';   // defines window.CurveGovernor

import {
  buildPlan, template, TEMPLATES, cToF, fToC, F_TO_C,
  LIMITS_C, DELTA_LIMITS_C, normalizePoints, steepestRateF, MAX_FOLLOW_F_PER_SEC,
} from './curve.js';

/* The governor reads these two globals; the app is the natural owner. */
window.puffSafetySettings = Object.assign(
  { dedicatedCurveSlot: false, flashWearThrottling: true },
  window.puffSafetySettings || {});
window.showToast = (msg) => toast(msg);

/* --------------------------------------------------------------- state */

const S = {
  dev: null,
  fake: null,
  transport: null,
  unit: localStorage.getItem('puffco.unit') || 'F',
  screen: 'connect',
  status: null,
  heater: null,
  counters: null,
  battery: null,
  profiles: [],
  selected: 0,
  tempF: Number(localStorage.getItem('puffco.tempF') || 515),
  lenS: Number(localStorage.getItem('puffco.lenS') || 60),
  curve: {
    name: 'Hill',
    mode: 'smooth',
    enabled: true,
    /* Rebuilt from the active profile temperature on connect — a curve authored
     * against some other profile opens with a warning it did not earn. */
    points: [],
    length: 90,
    authored: false,
  },
  runner: null,
  history: [],          // {t, c} chamber samples
  sessionTrace: [],     // {t, c} for the session screen
  curveProgress: null,
  lantern: { on: false, r: 124, g: 92, b: 255, mode: LANTERN_MODE.BREATHING, hours: 2, remaining: 0 },
  brightness: [210, 154, 255, 86],
  pollTimer: null,
  lastPollAt: 0,
  rec: [],              // {t, state, chamberC, …} — on by default, see record()
  recStart: Date.now(),
};
window.__S = S;

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const F = c => (c == null ? null : Math.round(cToF(c)));
const C = f => fToC(f);

function unitTemp(c) { return c == null ? null : (S.unit === 'F' ? Math.round(cToF(c)) : Math.round(c)); }
function unitSuffix() { return S.unit === 'F' ? '°F' : '°C'; }
/* A temperature DIFFERENCE converts by the ratio only. cToF(5.5) = 41.9 is a
 * temperature, not a delta — 5.5 °C of boost is 9.9 °F of boost. */
function deltaOut(c) { return Math.round(S.unit === 'F' ? c / F_TO_C : c); }

/* --------------------------------------------------------------- toast */

let toastTimer = null;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast on' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast' + (kind ? ' ' + kind : ''); }, 2600);
}

/* -------------------------------------------------------------- router */

function go(name) {
  if (name === S.screen) return;
  S.screen = name;
  $$('.scr').forEach(s => s.classList.toggle('on', s.id === 'sc-' + name));
  $$('.tab').forEach(t => t.classList.toggle('on', t.dataset.go === name));
  $('#tabs').hidden = !S.dev;
  /* Every screen re-renders on entry. Without this, Profiles / Mood / Peak
   * kept whatever they were drawn with at connect time — the battery reading
   * and profile temperatures would freeze for the life of the session. */
  if (name === 'heat') { renderHeat(); renderLive(); drawHeat(); }
  if (name === 'curves') renderCurves();
  if (name === 'profiles') renderProfiles();
  if (name === 'mood') renderMood();
  if (name === 'peak') renderPeak();
  if (name === 'session') { renderLive(); drawSession(); }
}

/* ------------------------------------------------------------- device */

async function connectDemo() {
  try {
    $('#cxSub').textContent = 'Starting simulator';
    const fake = createFakeLorax({ firmware: 'AG', name: 'Peak Pro 3DXL (sim)' });
    S.fake = fake;
    S.transport = fake.transport;
    await attach();
  } catch (e) {
    toast('Simulator failed: ' + e.message, 'err');
  }
}

async function connectReal() {
  try {
    /* ?bridge=1 routes through tools/bridge.py instead of Web Bluetooth. Same
     * transport interface, so the protocol layer and the UI are untouched. */
    if (bridgeAvailable()) {
      /* Say why it cannot work, rather than waiting for a socket that the
       * browser has already refused. */
      if (bridgeMixedContent()) {
        /* Fatal configuration problem, not a transient one: put the fix on the
         * connect screen where it stays readable, and keep the detail in the
         * toast. */
        $('#cxSub').textContent = 'HTTPS page cannot reach a ws:// bridge — open the tunnel URL instead';
        throw new Error(
          'This page is served over HTTPS, so the browser blocks ws:// to ' + BRIDGE_URL + '. '
          + 'Run tools/tunnel.py --addr <MAC> --lan and open the URL it prints; that serves the '
          + 'app and the bridge from one http origin.');
      }
      $('#cxSub').textContent = 'Connecting to the bridge';
      const transport = new BridgeTransport();
      await transport.connect();
      transport.onLost(() => {
        if (S.dev) { stopPolling(); toast('The bridge link dropped.', 'err'); S.dev = null; go('connect'); }
      });
      S.transport = transport;
      await attach();
      return;
    }

    if (!supported()) throw new BluetoothUnavailable(
      'This browser has no Web Bluetooth. Chrome, Edge or Bluefy on iOS — Safari cannot.');
    $('#cxSub').textContent = 'Choose your Peak';
    const device = await pickDevice();
    $('#cxSub').textContent = 'Connecting to ' + (device.name || 'device');
    const transport = new BleTransport(device);
    transport.onLost(() => {
      if (S.dev) { stopPolling(); toast('The link dropped.', 'err'); S.dev = null; go('connect'); }
    });
    await transport.connect();
    S.transport = transport;
    await attach();
  } catch (e) {
    if (e && e.name === 'NotFoundError') { $('#cxSub').textContent = 'Searching'; return; }
    /* A message that already explains itself stays on the screen. */
    if (!/^HTTPS page/.test($('#cxSub').textContent)) $('#cxSub').textContent = 'Not connected';
    toast(e.message || String(e), 'err');
  }
}

async function attach() {
  const onStep = step => {
    const map = {
      limits: 'Reading limits', version: 'Reading version', seed: 'Handshake',
      identity: 'Reading identity', 'unlock:lorax handshake': 'Unlocking', 'unlock:seed-only': 'Unlocking',
    };
    $('#cxSub').textContent = map[step] || step;
  };

  const dev = await Device.open(S.transport, { timeout: 4000, onStep });
  S.dev = dev;

  const info = dev.info;
  toast(`Connected · ${info.firmware || '?'} · ${dev.l.authMode || 'unlocked'}`, 'ok');
  $('#cxSub').textContent = `${info.firmware || '?'} · ${dev.l.authMode || 'unlocked'}`;

  await refreshAll();
  if (!S.curve.authored) rebuildCurve(S.curve.name);
  startPolling();
  go('heat');
}

async function refreshAll() {
  if (!S.dev) return;
  S.status = await S.dev.status();
  S.heater = await S.dev.heater();
  S.counters = await S.dev.counters();
  S.battery = await S.dev.battery();
  S.profiles = await S.dev.readProfiles(4);
  S.selected = (await S.dev.currentProfile()) ?? 0;
  const b = await S.dev.brightness();
  if (b && b.length >= 4) S.brightness = [b[0], b[1], b[2], b[3]];
  S.stealth = await S.dev.get(P.stealth, TYPE.U8);
  renderAll();
}

/* Polling cadence.
 *
 * Two rates, because the fields have very different natural frequencies:
 *   fast — state, temperature, target, elapsed: what the graph draws
 *   slow — battery, charge, counters, heater telemetry: minutes-scale data
 *
 * The old single rate read all eight status fields plus five heater fields on
 * every tick — 13 BLE transactions, 2.5 times a second in a session. Each one
 * wakes the radio, and the device cannot sleep while the link is busy. Splitting
 * them cuts the fast path to four reads and moves the rest to a 5 s tick.
 *
 * Polling also stops entirely when the page is hidden: a backgrounded tab has
 * nothing to draw, and a Peak left connected drains for no reason.
 */
const FAST_MS = 400;        // session: the graph needs this
const FAST_IDLE_MS = 5000;  // idle: nothing changes in 2 s, let alone 5
const SLOW_MS = 5000;       // battery, counters, heater

function startPolling() {
  stopPolling();
  let lastSlow = 0;
  let failures = 0;
  S.pollTicks = 0;
  S.pollReads = 0;

  const tick = async () => {
    if (!S.dev) return;
    if (document.hidden) {
      S.pollTimer = setTimeout(tick, 2000);
      return;
    }
    S.pollTicks++;
    try {
      const fast = await S.dev.statusFast();
      S.pollReads += 4;
      /* A failed read comes back null. Spreading it over the last good status
       * would report "idle" for one tick — enough to end a curve and to drop the
       * poll rate to the idle interval — so keep the last known value instead. */
      S.status = { ...(S.status || {}) };
      for (const [k, v] of Object.entries(fast)) if (v != null) S.status[k] = v;
      S.status.stateName = STATE[S.status.state] || 'unknown';
      S.status.inSession = IN_SESSION.has(S.status.state);
      S.status.at = fast.at;
      if (fast.tempC != null) pushHistory(fast.tempC);
      /* Feed the governor, if one is running, from the same poll. A failed read
       * arrives as null and is dropped by the adapter rather than reported as a
       * state — that distinction is what keeps a curve from aborting itself. */
      if (S.curveAdapter) {
        if (fast.tempC != null) S.curveAdapter.noteChamber(fast.tempC);
        if (fast.state != null) S.curveAdapter.noteState(fast.state);
      }

      const now = Date.now();
      if (now - lastSlow > SLOW_MS) {
        lastSlow = now;
        const slow = await S.dev.statusSlow();
        for (const [k, v] of Object.entries(slow)) if (v != null) S.status[k] = v;
        if (S.status.inSession) { S.heater = await S.dev.heater(); S.pollReads += 5; }
      }
      failures = 0;
      renderLive();
    } catch (e) {
      failures++;
      if (failures === 3) toast('The link is struggling.', 'err');
    }
    if (!S.dev) return;
    const interval = S.status && S.status.inSession ? FAST_MS : FAST_IDLE_MS;
    S.pollTimer = setTimeout(tick, interval);
  };
  tick();
}

function stopPolling() {
  clearTimeout(S.pollTimer);
  S.pollTimer = null;
}

/* ------------------------------------------------------------ recorder
 *
 * A Peak takes one BLE connection, so no second process can read the device
 * while the browser owns the link — `tools/snapshot.py` cannot observe a run
 * that the app is driving. This records the same columns from inside the page,
 * every poll, so a run can be inspected before/during/after without competing
 * for the link.
 *
 * window.__rec()      → the rows as CSV text
 * window.__recSave()  → downloads that CSV
 * window.__recReset() → clears it
 */
function record(c) {
  if (!S.rec) return;
  const st = S.status || {};
  const h = S.heater || {};
  S.rec.push({
    t: Date.now() - S.recStart,
    state: st.state,
    inSession: st.inSession ? 1 : 0,
    chamberC: c,
    chamberF: cToF(c),
    tcmdF: Number.isFinite(st.targetC) ? cToF(st.targetC) : null,
    duty: Number.isFinite(h.duty) ? h.duty : null,
    watts: Number.isFinite(h.power) ? h.power : null,
    curveS: S.curveProgress ? Number((S.curveProgress.elapsed || 0).toFixed(1)) : null,
    /* What the curve asked the chamber for, so the residual against the chamber
     * reading is computable from the CSV alone. */
    curveTargetF: S.curveProgress && S.curveProgress.targetF != null
      ? Number(S.curveProgress.targetF.toFixed(1)) : null,
  });
}

const REC_COLS = ['t', 'state', 'inSession', 'chamberC', 'chamberF', 'tcmdF', 'duty', 'watts', 'curveS', 'curveTargetF'];

window.__rec = () => {
  const rows = [REC_COLS.join(',')];
  for (const r of S.rec || []) rows.push(REC_COLS.map(k => (r[k] == null ? '' : r[k])).join(','));
  return rows.join('\n');
};

window.__recSave = () => {
  const blob = new Blob([window.__rec()], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `peak-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return (S.rec || []).length;
};

window.__recReset = () => { S.rec = []; S.recStart = Date.now(); return 0; };

function pushHistory(c) {
  const now = Date.now();
  S.history.push({ t: now, c });
  record(c);
  const cut = now - 5 * 60 * 1000;
  while (S.history.length && S.history[0].t < cut) S.history.shift();

  if (S.status && S.status.inSession) {
    /* The device's own target is /p/htr/tcmd — what it is actually aiming at,
     * after the offset is applied. Sampling it turns the session chart from
     * "what we asked for" into "what it was aiming at vs what it reached". */
    S.sessionTrace.push({ t: now, c, cmd: S.status.targetC });
    const sCut = now - 3 * 60 * 1000;
    while (S.sessionTrace.length && S.sessionTrace[0].t < sCut) S.sessionTrace.shift();
  } else if (S.sessionTrace.length && !S.status?.inSession) {
    S.sessionTrace = [];
  }
}

/* ------------------------------------------------------------ canvases */

function fitCanvas(cv) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  /* CSS fixes the box (width:100%, explicit height), so these are the truth.
   * The bitmap follows; the element never does. */
  const w = Math.max(1, Math.round(cv.clientWidth || cv.getBoundingClientRect().width || 320));
  const h = Math.max(1, Math.round(cv.clientHeight || cv.getBoundingClientRect().height || 150));
  const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
  if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/* Monotone cubic, identical to the plan builder's — the drawn line and the
 * commanded line are the same function, so the graph cannot disagree with what
 * the device is told. */
function monotone(pts) {
  const n = pts.length, d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) d.push((pts[i + 1].v - pts[i].v) / (pts[i + 1].t - pts[i].t));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const tau = 3 / Math.sqrt(s); m[i] = tau * a * d[i]; m[i + 1] = tau * b * d[i]; }
  }
  return m;
}

function evalCurve(pts, mode, t) {
  if (t <= pts[0].t) return pts[0].v;
  if (t >= pts[pts.length - 1].t) return pts[pts.length - 1].v;
  let i = 0;
  while (i < pts.length - 2 && pts[i + 1].t <= t) i++;
  const p0 = pts[i], p1 = pts[i + 1];
  if (mode === 'step') return p0.v;
  if (mode === 'ramp') return p0.v + (p1.v - p0.v) * ((t - p0.t) / (p1.t - p0.t));
  const h = p1.t - p0.t, u = (t - p0.t) / h, m = monotone(pts);
  const h00 = 2 * u ** 3 - 3 * u ** 2 + 1, h10 = u ** 3 - 2 * u ** 2 + u;
  const h01 = -2 * u ** 3 + 3 * u ** 2, h11 = u ** 3 - u ** 2;
  return h00 * p0.v + h10 * h * m[i] + h01 * p1.v + h11 * h * m[i + 1];
}

/* --------------------------------------------------------------- heat */

function drawHeat() {
  const cv = $('#hxPlot');
  if (!cv || !cv.clientWidth) return;
  const { ctx, w, h } = fitCanvas(cv);
  const PL = 26, PR = 8, PT = 8, PB = 6;
  const samples = S.history;
  const target = S.status ? S.status.targetC : C(S.tempF);

  if (!samples.length) {
    ctx.fillStyle = 'rgba(255,255,255,.22)';
    ctx.font = '11px ' + getComputedStyle(document.body).fontFamily;
    ctx.fillText('waiting for a reading', PL, h / 2);
    return;
  }

  /* Window follows the data (20 s … 5 min) instead of forcing a fixed 60 s,
   * so a freshly connected device fills the card rather than drawing a sliver
   * at the right edge. Gaps are still gaps: x is real time. */
  const now = samples[samples.length - 1].t;
  const span = Math.max(20000, Math.min(300000, now - samples[0].t));
  const t0 = now - span;

  let lo = Infinity, hi = -Infinity;
  for (const s of samples) { lo = Math.min(lo, s.c); hi = Math.max(hi, s.c); }
  let loF = Math.floor(cToF(lo) / 5) * 5;
  let hiF = Math.ceil(cToF(hi) / 5) * 5;
  /* Only stretch the axis to the target when the target is near the data. A
   * cold chamber at 72 °F with a 480 °F target would otherwise compress every
   * real sample into a flat strip at the bottom of the card. */
  if (target != null) {
    const tF = cToF(target);
    const spanF = Math.max(20, hiF - loF);
    if (tF <= hiF + spanF * 1.2) hiF = Math.max(hiF, Math.ceil(tF / 5) * 5);
  }
  const minSpan = 20;
  if (hiF - loF < minSpan) { const mid = (hiF + loF) / 2; loF = mid - minSpan / 2; hiF = mid + minSpan / 2; }

  const X = t => PL + ((t - t0) / span) * (w - PL - PR);
  const Y = c => PT + (1 - (cToF(c) - loF) / (hiF - loF)) * (h - PT - PB);

  /* gridlines + labels */
  ctx.strokeStyle = 'rgba(255,255,255,.045)';
  ctx.fillStyle = 'rgba(255,255,255,.28)';
  ctx.font = '8px ' + getComputedStyle(document.body).fontFamily;
  ctx.lineWidth = 1;
  const labelStep = niceStep(hiF - loF, 4);
  for (let f = Math.ceil(loF / labelStep) * labelStep; f <= hiF; f += labelStep) {
    const y = Y(C(f));
    ctx.beginPath(); ctx.moveTo(PL, y); ctx.lineTo(w - PR, y); ctx.stroke();
    ctx.fillText(f + '°', 0, y + 3);
  }

  /* target line — only when it actually falls inside the plotted range */
  if (target != null && cToF(target) >= loF - 1 && cToF(target) <= hiF + 1) {
    const y = Y(target);
    ctx.strokeStyle = 'rgba(255,178,122,.45)';
    ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(PL, y); ctx.lineTo(w - PR, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,178,122,.85)';
    const labelY = y - 6 < PT + 9 ? y + 11 : y - 6;
    ctx.fillText('target ' + unitTemp(target) + '°', PL + 3, labelY);
  }

  /* Area fill only once there is a real span: one flat sample drawn as a
   * filled block reads as data that is not there. */
  const lastX = X(samples[samples.length - 1].t);
  const spread = samples[samples.length - 1].t - samples[0].t;
  if (spread > 3000 && new Set(samples.map(s => Math.round(cToF(s.c)))).size > 1) {
    const grad = ctx.createLinearGradient(0, PT, 0, h - PB);
    grad.addColorStop(0, 'rgba(255,122,69,.26)');
    grad.addColorStop(1, 'rgba(255,122,69,0)');
    ctx.beginPath();
    ctx.moveTo(X(samples[0].t), Y(samples[0].c));
    for (const s of samples) ctx.lineTo(X(s.t), Y(s.c));
    ctx.lineTo(lastX, h - PB); ctx.lineTo(X(samples[0].t), h - PB); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();
  }

  const lineGrad = ctx.createLinearGradient(PL, 0, w - PR, 0);
  lineGrad.addColorStop(0, '#a78bfa');
  lineGrad.addColorStop(.42, '#ff7a45');
  lineGrad.addColorStop(1, '#ffd7ab');
  ctx.beginPath();
  ctx.moveTo(X(samples[0].t), Y(samples[0].c));
  for (const s of samples) ctx.lineTo(X(s.t), Y(s.c));
  ctx.strokeStyle = lineGrad; ctx.lineWidth = 2.3; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.stroke();

  /* newest dot */
  const last = samples[samples.length - 1];
  const g = ctx.createRadialGradient(lastX, Y(last.c), 0, lastX, Y(last.c), 11);
  g.addColorStop(0, 'rgba(255,215,171,.65)');
  g.addColorStop(1, 'rgba(255,215,171,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(lastX, Y(last.c), 11, 0, 7); ctx.fill();
  ctx.fillStyle = '#fff2e0'; ctx.beginPath(); ctx.arc(lastX, Y(last.c), 3, 0, 7); ctx.fill();

  $('#hxSpan').textContent = span >= 120000 ? Math.round(span / 60000) + ' min' : Math.round(span / 1000) + ' s';
  $('#hxAxisL').textContent = '−' + (span >= 120000 ? Math.round(span / 60000) + ' min' : Math.round(span / 1000) + ' s');
}

/* ------------------------------------------------------------ session */

function drawSession() {
  const cv = $('#ssPlot');
  if (!cv || !cv.clientWidth) return;
  const { ctx, w, h } = fitCanvas(cv);
  const PL = 26, PR = 8, PT = 8, PB = 6;
  const samples = S.sessionTrace;
  const st = S.status;

  if (!samples.length) {
    ctx.fillStyle = 'rgba(255,255,255,.22)';
    ctx.font = '11px ' + getComputedStyle(document.body).fontFamily;
    ctx.fillText('no session data yet', PL, h / 2);
    return;
  }

  /* The window is as long as the data, capped at two minutes: a session that
   * started 20 s ago draws across the whole card instead of a sliver at the
   * right edge. */
  const now = samples[samples.length - 1].t;
  const span = Math.max(20000, Math.min(120000, now - samples[0].t));
  const t0 = now - span;
  $('#ssAxisL').textContent = '−' + (span >= 60000 ? Math.round(span / 60000) + ' min' : Math.round(span / 1000) + ' s');

  /* The scale has to hold both lines, or the commanded trace leaves the card
   * exactly when the gap between them is the interesting part. */
  let lo = Infinity, hi = -Infinity;
  for (const s of samples) {
    lo = Math.min(lo, s.c); hi = Math.max(hi, s.c);
    if (s.cmd != null) { lo = Math.min(lo, s.cmd); hi = Math.max(hi, s.cmd); }
  }
  const target = st ? st.targetC : null;
  if (target != null) { lo = Math.min(lo, target); hi = Math.max(hi, target); }
  let loF = Math.floor(cToF(lo) / 5) * 5, hiF = Math.ceil(cToF(hi) / 5) * 5;
  if (hiF - loF < 20) { const mid = (hiF + loF) / 2; loF = mid - 10; hiF = mid + 10; }
  /* Pad the top so a target above the chamber still has room for its label. */
  hiF += (hiF - loF) * 0.12;

  const X = t => PL + ((t - t0) / span) * (w - PL - PR);
  const clampY = y => Math.max(PT, Math.min(h - PB, y));
  const Y = c => clampY(PT + (1 - (cToF(c) - loF) / (hiF - loF)) * (h - PT - PB));

  ctx.strokeStyle = 'rgba(255,255,255,.045)';
  ctx.fillStyle = 'rgba(255,255,255,.28)';
  ctx.font = '8px ' + getComputedStyle(document.body).fontFamily;
  /* Four gridlines regardless of the range: a fixed step crams 40 labels into a
   * cold-start session, where the scale spans 70→520 °F. */
  const stepF = niceStep(hiF - loF, 4);
  for (let f = Math.ceil(loF / stepF) * stepF; f <= hiF; f += stepF) {
    const y = Y(C(f));
    ctx.beginPath(); ctx.moveTo(PL, y); ctx.lineTo(w - PR, y); ctx.stroke();
    ctx.fillText(f + '°', 0, y + 3);
  }

  /* chamber trace */
  const grad = ctx.createLinearGradient(0, PT, 0, h - PB);
  grad.addColorStop(0, 'rgba(255,122,69,.3)');
  grad.addColorStop(1, 'rgba(255,122,69,0)');
  const lastX = X(samples[samples.length - 1].t);
  ctx.beginPath();
  ctx.moveTo(X(samples[0].t), Y(samples[0].c));
  for (const s of samples) ctx.lineTo(X(s.t), Y(s.c));
  ctx.lineTo(lastX, h - PB);
  ctx.lineTo(X(samples[0].t), h - PB);
  ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  ctx.beginPath();
  ctx.moveTo(X(samples[0].t), Y(samples[0].c));
  for (const s of samples) ctx.lineTo(X(s.t), Y(s.c));
  ctx.strokeStyle = '#ff7a45'; ctx.lineWidth = 2.1; ctx.lineJoin = 'round'; ctx.stroke();

  const last = samples[samples.length - 1];
  ctx.fillStyle = '#ffd7ab';
  ctx.beginPath(); ctx.arc(lastX, Y(last.c), 3, 0, 7); ctx.fill();

  /* Commanded: the device's own target temperature, sampled from /p/htr/tcmd.
   * This is measured, not inferred — it is the number the firmware was actually
   * aiming at, offset included. Drawing it against the chamber is the whole
   * point of the chart: the gap between the two is the thermal lag. */
  const cmdPts = samples.filter(s => s.cmd != null);
  if (cmdPts.length > 1) {
    ctx.beginPath();
    cmdPts.forEach((s, i) => {
      const x = X(s.t), y = Y(s.cmd);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = 'rgba(201,186,255,.9)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /* Lag readout: how far behind the chamber is right now. */
  const lastWithCmd = [...samples].reverse().find(s => s.cmd != null);
  if (lastWithCmd) {
    const lagF = cToF(lastWithCmd.c) - cToF(lastWithCmd.cmd);
    $('#ssLag').textContent = `${lagF >= 0 ? '+' : ''}${Math.round(lagF)} °F`;
    $('#ssLag').style.color = Math.abs(lagF) < 4 ? 'var(--ok)' : 'var(--warn)';
  }
}

/* ------------------------------------------------------------- curves */

function drawCurves() {
  const cv = $('#cvPlot');
  if (!cv || !cv.clientWidth) return;
  const { ctx, w, h } = fitCanvas(cv);
  const PL = 28, PR = 8, PT = 8, PB = 19;

  /* normalizePoints yields {t, c} in Celsius. The editor works in °F, so keep a
   * second list in the display unit — evalCurve reads `.v`, and feeding it `.c`
   * produced NaN points that silently collapsed the path. */
  if (!S.curve.points.length) rebuildCurve(S.curve.name);
  const cpts = normalizePoints(S.curve.points, 'F');
  const pts = cpts.map(p => ({ t: p.t, v: cToF(p.c) }));
  const dur = pts[pts.length - 1].t;
  let loF = Infinity, hiF = -Infinity;
  for (const p of pts) { loF = Math.min(loF, p.v); hiF = Math.max(hiF, p.v); }
  loF = Math.floor((loF - 10) / 20) * 20;
  hiF = Math.ceil((hiF + 10) / 20) * 20;

  const X = t => PL + (t / dur) * (w - PL - PR);
  const Y = f => PT + (1 - (f - loF) / (hiF - loF)) * (h - PT - PB);

  ctx.strokeStyle = 'rgba(255,255,255,.045)';
  ctx.fillStyle = 'rgba(255,255,255,.28)';
  ctx.font = '8px ' + getComputedStyle(document.body).fontFamily;
  for (let f = loF; f <= hiF; f += 20) {
    const y = Y(f);
    ctx.beginPath(); ctx.moveTo(PL, y); ctx.lineTo(w - PR, y); ctx.stroke();
    ctx.fillText(f + '°', 0, y + 3);
  }
  const ticks = 4;
  ctx.textAlign = 'center';
  for (let i = 0; i <= ticks; i++) {
    const t = (dur / ticks) * i;
    ctx.fillText(Math.round(t) + 's', X(t), h - 4);
  }
  ctx.textAlign = 'left';

  /* commanded */
  ctx.beginPath();
  for (let t = 0; t <= dur; t += Math.max(0.25, dur / 400)) {
    const x = X(t), y = Y(evalCurve(pts, S.curve.mode, t));
    t === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  const areaGrad = ctx.createLinearGradient(0, PT, 0, h - PB);
  areaGrad.addColorStop(0, 'rgba(167,139,250,.3)');
  areaGrad.addColorStop(1, 'rgba(167,139,250,0)');
  const cmdPath = new Path2D();
  for (let t = 0; t <= dur; t += Math.max(0.25, dur / 400)) {
    const x = X(t), y = Y(evalCurve(pts, S.curve.mode, t));
    t === 0 ? cmdPath.moveTo(x, y) : cmdPath.lineTo(x, y);
  }
  const fillPath = new Path2D(cmdPath);
  fillPath.lineTo(X(dur), h - PB);
  fillPath.lineTo(X(0), h - PB);
  fillPath.closePath();
  ctx.fillStyle = areaGrad;
  ctx.fill(fillPath);

  /* cooling floor — first-order model, same constants as the demo */
  const AMBIENT = 72, K = 0.0052;
  let actual = null, worst = 0, worstAt = 0;
  const physPath = new Path2D();
  for (let t = 0; t <= dur; t += Math.max(0.25, dur / 400)) {
    const wantF = evalCurve(pts, S.curve.mode, t);
    if (actual === null) actual = wantF;
    else actual = wantF > actual ? wantF : actual - K * (actual - AMBIENT) * Math.max(0.25, dur / 400);
    const lag = actual - wantF;
    if (lag > worst) { worst = lag; worstAt = t; }
    const x = X(t), y = Y(actual);
    t === 0 ? physPath.moveTo(x, y) : physPath.lineTo(x, y);
  }
  ctx.strokeStyle = worst >= 3 ? 'rgba(255,122,69,.9)' : 'rgba(255,122,69,.35)';
  ctx.lineWidth = 1.6; ctx.setLineDash([5, 4]);
  ctx.stroke(physPath);
  ctx.setLineDash([]);

  ctx.strokeStyle = '#c9baff';
  ctx.lineWidth = 2.2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.stroke(cmdPath);

  /* knobs */
  for (const p of pts) {
    const x = X(p.t), y = Y(p.v);
    ctx.beginPath(); ctx.arc(x, y, 5, 0, 7);
    ctx.fillStyle = '#0a0910'; ctx.fill();
    ctx.strokeStyle = '#c9baff'; ctx.lineWidth = 2.1; ctx.stroke();
  }

  /* warning, computed from the model rather than asserted */
  const bar = $('#cvWarn'), txt = $('#cvWarnTxt'), ic = $('#cvWarnIc');
  /* The offset is a headroom above the profile temperature: 0 … +20 °C.
   * A curve that dips BELOW the profile needs a negative offset, which the
   * official app never sends and this app therefore refuses. Both limits are
   * reported separately, because they mean different things to the user. */
  const baseF = Math.round(S.tempF);
  const curveLo = Math.round(Math.min(...pts.map(p => p.v)));
  const curveHi = Math.round(Math.max(...pts.map(p => p.v)));
  const roomF = Math.round(DELTA_LIMITS_C.max / F_TO_C);   /* 20 °C of headroom = 36 °F */
  const belowBy = baseF - curveLo;
  const aboveBy = curveHi - baseF;

  let planWrites = 0;
  try {
    planWrites = buildPlan({ points: S.curve.points, mode: S.curve.mode },
      { profileC: C(S.tempF), unit: 'F', tickSec: 1, maxSlewCPerSec: 3 }).steps.length;
  } catch { planWrites = 0; }

  const legend = $('#cvLegendPhys');
  if (legend) {
    legend.style.opacity = worst >= 3 ? '1' : '.45';
    legend.lastChild.textContent = worst >= 3 ? ' what the coil can reach' : ' coil tracks the line';
  }

  const set = (ok, icon, html) => {
    bar.classList.toggle('ok', ok);
    ic.textContent = icon;
    txt.innerHTML = html;
  };

  const rate = steepestRateF(cpts, 'F');

  if (belowBy > 1) {
    set(false, '▲',
      `<b>${belowBy} °F of this curve sits below the profile.</b> The offset only goes up from the profile temperature, so the dip will be clipped flat. Raise the profile to ${curveLo} °F or keep the curve above it.`);
  } else if (rate > MAX_FOLLOW_F_PER_SEC * 1.5) {
    /* Measured on hardware: the chamber follows ~1 °F/s comfortably. A steeper
     * curve is not impossible, it just trails — say how far behind it will be. */
    const need = Math.ceil((hiF - loF) / MAX_FOLLOW_F_PER_SEC);
    set(false, '▲',
      `<b>Too steep to follow.</b> This climbs at ${rate.toFixed(1)} °F/s; the chamber holds about ${MAX_FOLLOW_F_PER_SEC} °F/s, so it will trail the line. Stretch it to ${need} s or flatten the span.`);
  } else if (aboveBy > roomF + 1) {
    set(false, '▲',
      `<b>Needs ${aboveBy} °F above the profile.</b> The offset tops out at ${roomF} °F, so the top will be clipped. Raise the profile to ${curveHi - roomF} °F or lower the peak.`);
  } else if (worst >= 3) {
    set(false, '▲',
      `<b>Cooling-limited from ${Math.round(worstAt)} s.</b> The chamber cannot shed heat that fast, so the real temperature sits up to ${Math.round(worst)} °F above the line.`);
  } else {
    set(true, '✓',
      `<b>Within reach.</b> ${baseF} °F profile, ${curveLo}–${curveHi} °F curve, ${planWrites} writes over ${Math.round(dur)} s.`);
  }

  $('#cvSub').textContent = `${S.curve.name} · ${dur} s`;
  $('#cvLen').innerHTML = `${dur}<u>s</u>`;
}

/* -------------------------------------------------------------- render */

function renderAll() {
  renderHeader();
  renderHeat();
  renderCurves();
  renderProfiles();
  renderMood();
  renderPeak();
}

function renderHeader() {
  const st = S.status;
  if (!st) return;
  const ohm = S.heater?.resistance;
  const ohmTxt = Number.isFinite(ohm) ? ohm.toFixed(1) + ' Ω' : '—';
  $('#hxSub').textContent = `${st.stateName} · ${ohmTxt} · ${st.soc != null ? Math.round(st.soc) + '%' : '—'}`;
  $('#hxPillTxt').textContent = st.inSession ? 'Active' : 'Ready';
  $('#hxPill').querySelector('.dot').className = 'dot' + (st.inSession ? ' ember' : '');
}

function renderLive() {
  const st = S.status;
  if (!st) return;
  const t = unitTemp(st.tempC);
  $('#hxNow').innerHTML = (t == null ? '--' : t) + `<sup>${unitSuffix()}</sup>`;
  const prev = S.history.length > 6 ? S.history[S.history.length - 6].c : null;
  if (st.tempC != null && prev != null) {
    const rate = (cToF(st.tempC) - cToF(prev)) * 60 / 2;
    const dir = Math.abs(rate) < 1 ? 'holding' : (rate > 0 ? 'heating +' : 'cooling −');
    $('#hxTrend').textContent = Math.abs(rate) < 1 ? 'holding' : `${dir}${Math.abs(Math.round(rate))} °F/min`;
  } else if (st.tempC != null) {
    $('#hxTrend').textContent = st.inSession ? 'heating' : 'idle';
  }
  $('#hxTemp').innerHTML = `${unitTemp(C(S.tempF))}<u>${unitSuffix()}</u>`;
  $('#hxLen').innerHTML = `${S.lenS}<u>s</u>`;

  if (st.inSession) {
    const left = Math.max(0, Math.round((st.total || 0) - (st.elapsed || 0)));
    const m = Math.floor((st.elapsed || 0) / 60), s = Math.floor((st.elapsed || 0) % 60);
    $('#ssPillTxt').textContent = `${m}:${String(s).padStart(2, '0')}`;
    $('#ssLeft').textContent = left + ' s';
    $('#ssNow').innerHTML = (t == null ? '--' : t) + `<sup>${unitSuffix()}</sup>`;
    $('#ssTarget').textContent = st.targetC != null ? `target ${unitTemp(st.targetC)}${unitSuffix()}` : '—';
    if (S.heater) {
      $('#ssPower').textContent = Number.isFinite(S.heater.power) ? Math.round(S.heater.power) + ' W' : '—';
    }
    if (S.screen === 'session') drawSession();
    $('#ssStart').textContent = `${unitTemp(C(S.tempF))}${unitSuffix()} · ${S.lenS} s`;
    if (S.governor) {
      $('#ssWrites').textContent = `${S.curveProgress?.elapsed?.toFixed(0) ?? 0}/${S.curveProgress?.duration ?? 0} s · governed`;
    } else {
      $('#ssWrites').textContent = 'none';
    }
    const peak = S.sessionTrace.length ? Math.max(...S.sessionTrace.map(x => x.c)) : null;
    $('#ssPeak').textContent = peak != null ? `${unitTemp(peak)}${unitSuffix()}` : '—';

    if (S.curveProgress) {
      const p = S.curveProgress;
      const pct = clamp((p.elapsed / p.duration) * 100, 0, 100);
      $('#ssCurveBar').style.width = pct + '%';
      $('#ssCurveT').textContent = `${Math.round(p.elapsed)} / ${Math.round(p.duration)} s`;
    }
  }
  if (S.screen === 'heat') drawHeat();
}

function renderHeat() {
  /* Last session is read from the device's own trip counter, not invented. */
  const last = JSON.parse(localStorage.getItem('puffco.last') || 'null');
  const body = $('#hxLastBody');
  if (body) {
    if (last) {
      $('#hxLastWhen').textContent = ago(last.at);
      body.innerHTML = `<span><b style="color:var(--fg);font-weight:500">${last.temp}${unitSuffix()}</b> target</span>
        <span><b style="color:var(--fg);font-weight:500">${last.held}s</b> held</span>
        <span><b style="color:var(--violet2);font-weight:500">${last.curve || 'no curve'}</b></span>`;
    } else {
      $('#hxLastWhen').textContent = 'none yet';
      body.innerHTML = '<span style="opacity:.6">Start a session to record one</span>';
    }
  }

  $('#hxChips').innerHTML = S.profiles.slice(0, 4).map((p, i) => {
    const on = i === S.selected;
    const dot = ['#ff7a45', '#5ad68e', '#a78bfa', '#ffd166'][i % 4];
    return `<button class="chip${on ? ' on' : ''}" data-preset="${i}">
      <div class="d" style="background:${dot};box-shadow:0 0 7px ${dot}"></div>
      <b>${p.tempC != null ? Math.round(S.unit === 'F' ? cToF(p.tempC) : p.tempC) + '°' : '—'}</b>
      <i>${(p.name || 'Slot ' + (i + 1)).slice(0, 9)}</i>
    </button>`;
  }).join('');
}

function renderCurves() {
  const names = Object.keys(TEMPLATES);
  $('#cvModes').innerHTML = names.map(n =>
    `<div class="mode${S.curve.name.toLowerCase() === n ? ' on' : ''}" data-template="${n}">${n[0].toUpperCase() + n.slice(1)}</div>`
  ).join('');
  const saved = JSON.parse(localStorage.getItem('puffco.curves') || '[]');
  $('#cvSaved').innerHTML = saved.length
    ? saved.map((c, i) => `<div class="mode${c.name === S.curve.name ? ' on' : ''}" data-saved="${i}">${c.name}</div>`).join('')
    : '<div class="mode" style="opacity:.5">none yet</div>';
  drawCurves();
}

function renderProfiles() {
  const cur = S.profiles[S.selected];
  $('#pfSub').textContent = `${S.profiles.filter(p => p.name).length} of 4 slots`;
  $('#pfGrid').innerHTML = S.profiles.map((p, i) => {
    const dot = ['#ff7a45', '#5ad68e', '#a78bfa', '#ffd166'][i % 4];
    const on = i === S.selected;
    if (!p.name) return `<button class="pcard empty" data-profile="${i}">+</button>`;
    return `<button class="pcard${on ? ' on' : ''}" data-profile="${i}">
      <div class="sw" style="background:${dot};box-shadow:0 0 8px ${dot}"></div>
      <div class="nm">${p.name}</div>
      <div class="tp">${unitTemp(p.tempC)}<span>${unitSuffix()}</span></div>
      <div class="tm">${fmtDur(p.timeS)}${p.boostTempC ? ' · boost +' + deltaOut(p.boostTempC) + '°' : ''}</div>
    </button>`;
  }).join('');

  const sel = S.profiles[S.selected];
  if (sel) {
    $('#pfTemp').textContent = sel.tempC != null ? `${unitTemp(sel.tempC)} ${unitSuffix()}` : '—';
    $('#pfTime').textContent = sel.timeS != null ? fmtDur(sel.timeS) : '—';
    $('#pfBoost').textContent = sel.boostTempC != null
      ? `+${deltaOut(sel.boostTempC)}° · ${Math.round(sel.boostTimeS || 0)} s`
      : '—';
    $('#pfCurve').textContent = S.curve.enabled ? `${S.curve.name} · ${S.curve.length} s` : 'none';
  }

  $('#pfCurrent').innerHTML = cur
    ? `<div style="display:flex;align-items:center;gap:11px">
         <div class="devicon" style="background:rgba(255,122,69,.14)"><svg viewBox="0 0 24 24"><path d="M9.4 6.5h5.2l2.2 9.6a3 3 0 0 1-2.9 3.7h-3.8a3 3 0 0 1-2.9-3.7Z"/><path d="M11 6.5V3.6a1 1 0 0 1 2 0v2.9"/><path d="M7.6 19.8h8.8"/></svg></div>
         <div><div style="font-size:11.5px;font-weight:600">${cur.name}</div>
         <div style="font-size:9.5px;color:var(--mut2);margin-top:2px">Slot ${S.selected + 1} · cycle on device</div></div>
       </div>`
    : '<div style="font-size:11.5px;color:var(--mut2)">No profile selected</div>';
}

function renderMood() {
  const L = S.lantern;
  $('#mdPillTxt').textContent = L.on ? 'On' : 'Off';
  $('#mdPill').querySelector('.dot').className = 'dot' + (L.on ? ' violet' : ' off');
  $('#mdOrb').style.background = `radial-gradient(circle at 33% 25%,
    rgba(255,255,255,.92) 0%, rgb(${L.r + 60},${L.g + 60},${Math.min(255, L.b + 60)}) 17%,
    rgb(${L.r},${L.g},${L.b}) 50%, rgba(${L.r >> 1},${L.g >> 1},${L.b >> 1},1) 82%, #1b0f4e 100%)`;
  $('#mdOrb').style.opacity = L.on ? '1' : '.35';
  $('#mdToggle').textContent = L.on
    ? (L.remaining ? `Turn off · ${fmtClock(L.remaining)} left` : 'Turn off')
    : 'Turn on';

  const colors = [[124, 92, 255], [255, 77, 109], [255, 159, 28], [46, 196, 182], [247, 247, 250], null];
  $('#mdColors').innerHTML = colors.map((c, i) => {
    const bg = c ? `rgb(${c[0]},${c[1]},${c[2]})` : 'conic-gradient(#ff4d6d,#ffd166,#2ec4b6,#7c5cff,#ff4d6d)';
    const on = c && c[0] === L.r && c[1] === L.g && c[2] === L.b;
    return `<button class="sw2${on ? ' on' : ''}" data-color="${i}" style="background:${bg}" aria-label="colour ${i + 1}"></button>`;
  }).join('');

  const labels = ['Ring', 'Under glass', 'Main', 'Battery'];
  $('#mdBri').innerHTML = labels.map((lab, i) => `
    <div class="lrow"><div class="lb">${lab}</div>
      <div class="slider" data-bri="${i}"><b style="width:${(S.brightness[i] / 255) * 100}%"></b><i style="left:calc(${(S.brightness[i] / 255) * 100}% - 6px)"></i></div>
      <div style="width:22px;text-align:right;font-size:9.5px;color:var(--dim)" class="mono">${S.brightness[i]}</div>
    </div>`).join('');

  const pats = [['Static', LANTERN_MODE.STATIC], ['Breathing', LANTERN_MODE.BREATHING], ['Rising', LANTERN_MODE.RISING],
    ['Circling', LANTERN_MODE.CIRCLING], ['Slow', LANTERN_MODE.CIRCLING_SLOW], ['Preserve', LANTERN_MODE.PRESERVE]];
  $('#mdPatterns').innerHTML = pats.map(([n, v]) =>
    `<div class="mode${L.mode === v ? ' on' : ''}" data-pattern="${v}">${n}</div>`).join('');
  $('#mdTime').innerHTML = `${L.hours}<u>h</u>`;
  const patName = { [LANTERN_MODE.STATIC]: 'Static', [LANTERN_MODE.BREATHING]: 'Breathing',
    [LANTERN_MODE.RISING]: 'Rising', [LANTERN_MODE.CIRCLING]: 'Circling',
    [LANTERN_MODE.CIRCLING_SLOW]: 'Slow circle', [LANTERN_MODE.PRESERVE]: 'Preserve' }[L.mode] || '—';
  $('#mdRemaining').textContent = L.on && L.remaining ? fmtClock(L.remaining) : '—';
  /* The pattern is already highlighted in the chip row above; this row carries
   * the one thing the chips cannot show. */
  $('#mdPattern').textContent = patName === 'Breathing' || patName === 'Rising' || patName === 'Circling' ? 'default' : '—';
}

function renderPeak() {
  const st = S.status, h = S.heater, c = S.counters, b = S.battery;
  if (!st) return;
  const info = S.dev?.info || {};
  $('#pkSub').textContent = `${info.firmware || '?'} · ${S.dev?.l.authMode || ''}`;
  $('#pkSoc').innerHTML = `${b?.soc != null ? Math.round(b.soc) : '--'}<span>%</span>`;
  $('#pkBar').style.width = (b?.soc != null ? clamp(b.soc, 0, 100) : 0) + '%';
  const charging = b && (b.state === 0 || b.state === 1);
  $('#pkCharge').textContent = !b || b.name === 'unknown'
    ? '—'
    : charging
      ? `${b.name} · full in ${Math.round((b.eta || 0) / 60)} min`
      : b.name;
  $('#pkTotal').textContent = c?.totalDabs ?? '—';
  $('#pkTrip').textContent = c?.tripDabs ?? '—';
  $('#pkPerDay').textContent = c?.perDay != null ? c.perDay.toFixed(1) : '—';
  $('#pkRemaining').textContent = c?.remaining != null ? '~' + c.remaining : '—';
  $('#pkPower').textContent = Number.isFinite(h?.power) ? Math.round(h.power) + ' W' : '—';
  $('#pkOhm').textContent = Number.isFinite(h?.resistance) ? h.resistance.toFixed(1) + ' Ω' : '—';
  const chamberName = CHAMBER[info.chamber] || (info.chamber == null ? null : 'type ' + info.chamber);
  $('#pkDuty').textContent = (Number.isFinite(h?.duty) ? Math.round(h.duty) + ' %' : '—') + (chamberName ? ' · ' + chamberName : '');
  $('#pkFw').textContent = info.firmware || '—';
  $('#pkSerial').textContent = info.serial ? '••••' + String(info.serial).slice(-4) : '—';
  const stealthTxt = S.stealth == null ? '—' : (S.stealth ? 'on' : 'off');
  $('#pkUptime').textContent = (info.uptime != null ? fmtClock(info.uptime) : '—') + ' · ' + stealthTxt;
  $$('[data-unit]').forEach(el => el.classList.toggle('on', el.dataset.unit === S.unit));
}

/* ---------------------------------------------------------------- util */

/* Internal plan flags mean nothing to a user; say what they do. */
function plainWarn(w) {
  return {
    'delta-clamped': 'clipped at offset limit',
    'slew-limited': 'rate-limited',
    'decay-limited': 'cooling-limited',
    'clamped-to-limits': 'clipped to range',
  }[w] || w;
}

/* Smallest 1/2/5×10ⁿ step that fits the range into `want` labels or fewer. */
function niceStep(range, want) {
  if (!(range > 0)) return 10;
  const raw = range / want;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return Math.max(5, mult * mag);
}

function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  return h < 24 ? h + ' h ago' : Math.round(h / 24) + ' d ago';
}

function fmtDur(s) {
  if (s == null) return '—';
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return m ? `${m}:${String(r).padStart(2, '0')}` : `${r}s`;
}
function fmtClock(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

/* ------------------------------------------------------------- actions */

async function setTemp(deltaF) {
  S.tempF = clamp(S.tempF + deltaF, 400, 644);
  localStorage.setItem('puffco.tempF', String(S.tempF));
  renderLive();
  if (S.dev && !S.status?.inSession) {
    try { await S.dev.set(P.tempCmd, TYPE.FLOAT, C(S.tempF)); } catch { /* reported by next poll */ }
  }
}

async function setLen(delta) {
  S.lenS = clamp(S.lenS + delta, 15, 120);
  localStorage.setItem('puffco.lenS', String(S.lenS));
  renderLive();
  if (S.dev && !S.status?.inSession) {
    try { await S.dev.writeProfile(S.selected, { timeS: S.lenS }); } catch {}
  }
}

async function startSession() {
  if (!S.dev) return;
  try {
    await S.dev.writeProfile(S.selected, { tempC: C(S.tempF), timeS: S.lenS });
    if (S.profiles[S.selected]) {
      S.profiles[S.selected].tempC = C(S.tempF);
      S.profiles[S.selected].timeS = S.lenS;
    }
    await S.dev.startSession();
    S.sessionTrace = [];
    toast('Session started', 'ok');
    go('session');
    if (S.curve.enabled) waitForHeatCycle().then(ok => { if (ok) startCurveRun(); });
  } catch (e) { toast('Could not start: ' + e.message, 'err'); }
}

/* The device does not enter a heat cycle the instant the command lands — it
 * reports PREHEAT a moment later. Starting the curve before that would see
 * "not in session" on its first tick and abort itself. */
async function waitForHeatCycle(tries = 12, gap = 250) {
  for (let i = 0; i < tries; i++) {
    const st = await S.dev.status();
    if (st.inSession) { S.status = st; return true; }
    await new Promise(r => setTimeout(r, gap));
  }
  toast('The device never entered a heat cycle.', 'err');
  return false;
}

async function abortSession() {
  try {
    if (S.governor) S.governor.stop();
    S.governor = null; S.curveAdapter = null; S.curveProgress = null;
    await S.dev.abortSession();
    toast('Session aborted');
    go('heat');
  } catch (e) { toast('Abort failed: ' + e.message, 'err'); }
}

function startCurveRun() {
  if (!S.dev) return;

  /* The governor takes the curve as keyframes in seconds/°F and drives the
   * session's live target. The plan above still runs first so an out-of-range
   * shape is refused before anything heats. */
  const profileF = S.tempF;
  const totalS = Math.round(S.curve.length || 90);
  /* Template points carry {t, v} already in °F; authored ones carry {t, c} in
   * Celsius. Accept both rather than assuming one. */
  const pts = S.curve.points;
  const toF = p => (p.v != null ? p.v : cToF(p.c));
  const last = pts.length ? pts[pts.length - 1].t || 1 : 1;
  const keyframes = pts.map(p => ({
    time_s: (p.t / last) * totalS,
    temp_f: toF(p),
  })).filter(k => Number.isFinite(k.time_s) && Number.isFinite(k.temp_f));

  const startedAt = Date.now();
  S.curveProgress = { elapsed: 0, duration: totalS, startedAt };
  $('#ssCurveCard').hidden = false;
  $('#ssCurveNote').innerHTML = `<span>peak ${Math.round(Math.max(...keyframes.map(k => k.temp_f)))}°</span><span>governed</span>`;

  const adapter = adaptDevice(S.dev);
  const governor = new window.CurveGovernor(adapter);
  S.governor = governor;
  S.curveAdapter = adapter;

  governor.addCurveListener(ev => {
    if (ev.elapsed_s != null && S.curveProgress) S.curveProgress.elapsed = ev.elapsed_s;
    /* The chamber target the curve is asking for right now — the value the
     * governor converts into a coil setpoint. */
    if (ev.target_temp_f != null && S.curveProgress) S.curveProgress.targetF = ev.target_temp_f;
    if (ev.live_temp_f) adapter.noteChamber((ev.live_temp_f - 32) / 1.8);
    if (!ev.is_active && ev.status) {
      localStorage.setItem('puffco.last', JSON.stringify({
        at: Date.now(), temp: Math.round(profileF),
        held: Math.round((Date.now() - startedAt) / 1000),
        curve: S.curve.name,
      }));
      if (ev.status === 'completed') toast('Curve finished', 'ok');
      else if (ev.status !== 'stopped') toast('Curve stopped: ' + (ev.error || ev.status));
      S.curveProgress = null; S.governor = null; S.curveAdapter = null;
      $('#ssCurveCard').hidden = true;
    }
  });

  governor.run({ id: S.curve.name, name: S.curve.name, duration_s: totalS, keyframes })
    .catch(e => { toast('Curve failed: ' + e.message, 'err'); S.governor = null; $('#ssCurveCard').hidden = true; });
}

/* --------------------------------------------------------------- wiring */

function wire() {
  $$('[data-go]').forEach(el => el.addEventListener('click', () => go(el.dataset.go)));
  $$('.tab').forEach(t => t.addEventListener('click', () => go(t.dataset.go)));

  $('#cxGo').addEventListener('click', connectReal);
  $('#cxDemo').addEventListener('click', connectDemo);

  $$('[data-temp]').forEach(b => b.addEventListener('click', () => {
    setTemp(Number(b.dataset.temp));
    if (!S.curve.authored) { rebuildCurve(S.curve.name); renderCurves(); }
  }));
  $$('[data-len]').forEach(b => b.addEventListener('click', () => setLen(Number(b.dataset.len))));
  $$('[data-clen]').forEach(b => b.addEventListener('click', () => {
    S.curve.length = clamp(S.curve.length + Number(b.dataset.clen), 20, 180);
    resampleCurve();
    renderCurves();
  }));
  $$('[data-mtime]').forEach(b => b.addEventListener('click', () => {
    S.lantern.hours = clamp(S.lantern.hours + Number(b.dataset.mtime), 1, 8);
    renderMood();
  }));

  $('#hxStart').addEventListener('click', startSession);
  $('#ssAbort').addEventListener('click', abortSession);
  $('#ssBoost').addEventListener('click', async () => {
    try { await S.dev.boost(); toast('Boost sent'); } catch (e) { toast(e.message, 'err'); }
  });

  $('#hxChips').addEventListener('click', async e => {
    const b = e.target.closest('[data-preset]');
    if (!b) return;
    const i = Number(b.dataset.preset);
    S.selected = i;
    const p = S.profiles[i];
    if (p?.tempC != null) S.tempF = Math.round(cToF(p.tempC));
    if (p?.timeS != null) S.lenS = Math.round(p.timeS);
    renderHeat(); renderLive();
    try { await S.dev.set(P.profileCurrent, TYPE.U32, i); } catch {}
  });

  $('#cvModes').addEventListener('click', e => {
    const b = e.target.closest('[data-template]');
    if (!b) return;
    const name = b.dataset.template;
    rebuildCurve(name);
    S.curve.authored = true;
    renderCurves();
  });

  $('#cvSaved').addEventListener('click', e => {
    const b = e.target.closest('[data-saved]');
    if (!b) return;
    const saved = JSON.parse(localStorage.getItem('puffco.curves') || '[]');
    const c = saved[Number(b.dataset.saved)];
    if (!c) return;
    S.curve = { ...c };
    renderCurves();
    toast('Loaded ' + c.name);
  });

  $('#cvSave').addEventListener('click', () => {
    const saved = JSON.parse(localStorage.getItem('puffco.curves') || '[]');
    const name = S.curve.name + ' ' + S.curve.length;
    const i = saved.findIndex(c => c.name === name);
    const entry = { ...S.curve, name };
    if (i >= 0) saved[i] = entry; else saved.push(entry);
    localStorage.setItem('puffco.curves', JSON.stringify(saved));
    renderCurves();
    toast('Saved ' + name, 'ok');
  });

  $('#cvRun').addEventListener('click', () => { S.curveProgress = { pending: true }; startSession(); });

  $('#pfGrid').addEventListener('click', async e => {
    const b = e.target.closest('[data-profile]');
    if (!b) return;
    S.selected = Number(b.dataset.profile);
    renderProfiles(); renderHeat();
    try { await S.dev.set(P.profileCurrent, TYPE.U32, S.selected); } catch {}
  });

  $('#pfWrite').addEventListener('click', async () => {
    try {
      await S.dev.writeProfile(S.selected, { tempC: C(S.tempF), timeS: S.lenS });
      S.profiles = await S.dev.readProfiles(4);
      renderProfiles(); renderHeat();
      toast('Written to slot ' + (S.selected + 1), 'ok');
    } catch (e) { toast(e.message, 'err'); }
  });

  $('#mdColors').addEventListener('click', async e => {
    const b = e.target.closest('[data-color]');
    if (!b) return;
    const map = [[124, 92, 255], [255, 77, 109], [255, 159, 28], [46, 196, 182], [247, 247, 250], null];
    const c = map[Number(b.dataset.color)];
    if (!c) return;
    S.lantern.r = c[0]; S.lantern.g = c[1]; S.lantern.b = c[2];
    renderMood();
    try { await S.dev.setLanternColor(c[0], c[1], c[2], S.lantern.mode); } catch (e) { toast(e.message, 'err'); }
  });

  $('#mdPatterns').addEventListener('click', async e => {
    const b = e.target.closest('[data-pattern]');
    if (!b) return;
    S.lantern.mode = Number(b.dataset.pattern);
    renderMood();
    try { await S.dev.setLanternColor(S.lantern.r, S.lantern.g, S.lantern.b, S.lantern.mode); } catch {}
  });

  $('#mdBri').addEventListener('click', async e => {
    const s = e.target.closest('[data-bri]');
    if (!s) return;
    const i = Number(s.dataset.bri);
    const r = s.getBoundingClientRect();
    const pct = clamp((e.clientX - r.left) / r.width, 0, 1);
    S.brightness[i] = Math.round(pct * 255);
    renderMood();
    try { await S.dev.setBrightness(...S.brightness); } catch (e) { toast(e.message, 'err'); }
  });

  $('#mdToggle').addEventListener('click', async () => {
    S.lantern.on = !S.lantern.on;
    renderMood();
    try {
      if (S.lantern.on) {
        await S.dev.setLanternTime(S.lantern.hours * 3600);
        await S.dev.setLantern(true);
        S.lantern.remaining = S.lantern.hours * 3600;
      } else {
        await S.dev.setLantern(false);
        S.lantern.remaining = 0;
      }
      renderMood();
    } catch (e) { toast(e.message, 'err'); }
  });

  $$('[data-unit]').forEach(el => el.addEventListener('click', () => {
    S.unit = el.dataset.unit;
    localStorage.setItem('puffco.unit', S.unit);
    renderAll(); renderLive();
  }));

  $('#pkDisconnectTop').addEventListener('click', async () => {
    stopPolling();
    if (S.governor) S.governor.stop();
    S.governor = null; S.curveAdapter = null;
    try { if (S.transport) await S.transport.disconnect(); } catch {}
    if (S.fake) { S.fake.stop(); S.fake = null; }
    S.dev = null; S.transport = null;
    S.history = []; S.sessionTrace = [];
    go('connect');
    $('#tabs').hidden = true;
  });

  /* A hidden tab should not keep the radio busy. Resume immediately on return. */
  document.addEventListener('visibilitychange', () => {
    if (!S.dev) return;
    if (document.hidden) {
      stopPolling();
    } else {
      startPolling();
    }
  });

  window.addEventListener('resize', () => {
    if (S.screen === 'heat') drawHeat();
    if (S.screen === 'curves') drawCurves();
    if (S.screen === 'session') drawSession();
  });
}

/* Build a template around the profile the device is actually on, so the curve
 * starts inside the offset window instead of warning on open. */
function rebuildCurve(name) {
  /* The display name is capitalised; the template keys are lowercase. */
  const key = String(name).toLowerCase();
  const t = template(key, { base: S.tempF, span: 30, hold: S.curve.length, unit: 'F' });
  S.curve.name = key[0].toUpperCase() + key.slice(1);
  S.curve.mode = t.mode;
  S.curve.points = t.points;
  S.curve.authored = false;
}

function resampleCurve() {
  /* Re-space the existing shape over the new length, preserving its character
   * rather than snapping back to a template. */
  const pts = S.curve.points;
  const oldDur = pts[pts.length - 1].t || 1;
  const scale = S.curve.length / oldDur;
  S.curve.points = pts.map(p => ({ t: Math.round(p.t * scale), v: p.v }));
}

/* Read-only snapshot for the test harness. It reports the simulator's state and
 * the app's view of it side by side, which is how the e2e test proves the screen
 * and the device agree. */
window.__puffco = () => {
  const fake = S.fake;
  const st = S.status || {};
  return {
    connected: !!S.dev,
    screen: S.screen,
    inSession: !!st.inSession,
    state: st.state,
    tempC: st.tempC,
    targetC: st.targetC,
    override: fake ? fake.state.override : null,
    /* Live session target and how many times it was written — the path a curve
     * actually drives. `curveWrites` was the old offset path and no longer moves. */
    liveTargetC: fake ? fake.state.targetC : null,
    liveWrites: fake ? fake.state.liveWrites : null,
    dropState(n) { if (fake) fake.dropStateEvery(n); },
    profileTempC: C(S.tempF),
    startC: 22,
    profileCurrent: fake ? fake.state.profileCurrent : null,
    lantern: fake ? fake.state.lantern : null,
    firmware: S.dev?.info?.firmware || null,
    authMode: S.dev?.l.authMode || null,
    curveRunning: !!S.governor,
    curveProgress: S.curveProgress ? Math.round(S.curveProgress.elapsed || 0) : 0,
    curveDuration: S.curveProgress ? Math.round(S.curveProgress.duration || 0) : 0,
    curveTargetF: S.curveProgress && S.curveProgress.targetF != null
      ? Math.round(S.curveProgress.targetF * 10) / 10 : null,
    soc: st.soc == null ? null : st.soc,
    pollTicks: S.pollTicks || 0,
    pollReads: S.pollReads || 0,
  };
};

/* Tell the user which transport this page will use, before they tap. */
if (bridgeAvailable()) {
  $('#cxGo').textContent = 'Connect via bridge';
  $('#cxDemo').textContent = 'Try the simulator';
  $('#cxSub').textContent = 'Bridge mode';
}

wire();
go('connect');
