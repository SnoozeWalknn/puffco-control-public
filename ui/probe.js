/* Device probe — answers the six open questions against real hardware.
 *
 * This is a diagnostic, not the app. It uses the same protocol layer the app
 * will use, so a clean run here proves that layer, and a failure points at the
 * protocol rather than the UI.
 *
 * Safety: writes only /p/app/tmpo (and restores 0), only inside the offset
 * test. Never touches heater tuning, factory reset, or the OTA service. The
 * heating test is behind an explicit button and aborts on its own.
 */

import { Lorax, TYPE, OP, dec, enc, revisionString } from './proto/lorax.js';
import { supported, pickDevice, BleTransport, listServices, LORAX } from './ble.js';
import { createFakeLorax } from './fake_lorax.js';
import { buildPlan, template, cToF, fToC } from './curve.js';

const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const R = {};          // collected results, keyed
let lorax = null;
let transport = null;

/* ------------------------------------------------------------------ log */

function log(msg, cls = '') {
  const el = $('#log');
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function hd(msg) { log(msg, 'hd'); }

/* --------------------------------------------------------------- render */

function setRow(key, label, value, cls = '') {
  R[key] = { label, value, cls };
  renderRows();
}

function renderRows() {
  $('#rows').innerHTML = Object.entries(R).map(([, r]) =>
    `<div class="row"><span class="k">${r.label}</span><span class="v ${r.cls}">${r.value}</span></div>`
  ).join('') || '<div class="row"><span class="k">nothing yet</span></div>';
}

function verdict(kind, text) {
  const v = $('#verdict');
  v.className = 'verdict on ' + kind;
  v.textContent = text;
}

/* ------------------------------------------------------------- helpers */

async function readRaw(path) {
  return lorax.readRaw(path);
}

async function readTyped(path, type) {
  try { return dec(type, await readRaw(path)); }
  catch { return null; }
}

/* Write a value, then read it back. The read-back is the whole point: a silent
 * write proves nothing, because WRITE_SHORT never acknowledges. */
async function writeEcho(value) {
  await lorax.write('/p/app/tmpo', TYPE.FLOAT, value);
  await sleep(60);
  const back = await readTyped('/p/app/tmpo', TYPE.FLOAT);
  return back;
}

const f1 = v => (v == null ? '—' : (Math.round(v * 100) / 100).toString());

/* ----------------------------------------------------------------- main */

async function probe() {
  const btn = $('#go');
  btn.disabled = true;
  $('#rows').innerHTML = '';
  Object.keys(R).forEach(k => delete R[k]);

  try {
    /* ?sim=1 runs the whole probe against the simulator, so the harness itself
     * can be checked before pointing it at hardware. It bypasses the Web
     * Bluetooth check, which headless browsers fail. */
    const sim = new URLSearchParams(location.search).get('sim') === '1';

    if (!sim && !supported()) {
      verdict('no', 'This browser has no Web Bluetooth. Use Chrome, Edge, or Bluefy on iOS.');
      btn.disabled = false;
      return;
    }

    /* ---- 1. connect ------------------------------------------------ */
    hd('1 · connect');
    if (sim) {
      const fake = createFakeLorax({ firmware: 'AG', name: 'Peak Pro 3DXL (sim)' });
      transport = fake.transport;
      log('SIMULATOR — no hardware involved', 'er');
    } else {
      const device = await pickDevice();
      log('picked: ' + (device.name || '(no name)') + '  id ' + (device.id || '?'));

      transport = new BleTransport(device);
      await transport.connect();
      log('gatt connected, notifications on', 'ok');

      /* Dump what the device actually exposes. If the Lorax service is missing
       * here, the unit speaks the older flat protocol and the rest of the probe
       * cannot work — worth knowing before it fails at the handshake. */
      try {
        const svcs = await listServices(device);
        log('services exposed:', 'dm');
        for (const svc of svcs) log('  ' + svc.uuid + '  (' + svc.characteristics.length + ' chars)', 'dm');
        const hasLorax = svcs.some(x => x.uuid === LORAX.SERVICE);
        setRow('lorax', 'Lorax service', hasLorax ? 'present' : 'ABSENT', hasLorax ? 'pass' : 'fail');
        if (!hasLorax) {
          const flat = svcs.some(x => x.uuid === '06caf9c0-74d3-454f-9be9-e30cd999c17a');
          verdict('part', flat
            ? 'This unit speaks the older flat GATT protocol, not Lorax. The app would need the other driver.'
            : 'None of the known Puffco services are present. That is probably a different device, or it needs pairing mode again.');
        }
      } catch (e) {
        log('service dump failed: ' + (e && e.message || e), 'dm');
      }
    }

    lorax = new Lorax(transport, { timeout: 5000 });

    /* ---- 2. auth --------------------------------------------------- */
    hd('2 · handshake');
    let authMode = null;
    try {
      authMode = await lorax.authenticate({
        onStep: s => log('  ' + s, 'dm'),
      });
      log('unlocked via: ' + authMode, 'ok');
      setRow('auth', 'Handshake', authMode, 'pass');
    } catch (e) {
      log('auth failed: ' + e.message, 'er');
      setRow('auth', 'Handshake', 'FAILED — ' + e.message, 'fail');
      verdict('no', 'The device refused every unlock variant. Nothing else can be tested.');
      btn.disabled = false;
      return;
    }

    /* ---- 3. identity ----------------------------------------------- */
    hd('3 · identity');
    const fwInt = await readTyped('/p/sys/fw/ver', TYPE.U32);
    const fw = revisionString(fwInt);
    const model = await readTyped('/p/sys/hw/mdcd', TYPE.U32);
    const serial = await readTyped('/p/sys/hw/ser', TYPE.STRING);
    const name = await readTyped('/u/sys/name', TYPE.STRING);
    const chamber = await readTyped('/p/htr/chmt', TYPE.U8);
    const hw = await readTyped('/p/sys/hw/ver', TYPE.STRING);

    setRow('fw', 'Firmware', `${fw} (raw ${fwInt})`);
    setRow('hw', 'Hardware', hw || '—');
    setRow('model', 'Model code', model == null ? '—' : model);
    setRow('serial', 'Serial', serial ? '••••' + String(serial).slice(-4) : '—');
    setRow('name', 'Device name', name || '—');
    setRow('chamber', 'Chamber type', chamber == null ? '—' : chamber);
    log(`fw ${fw} · hw ${hw} · chamber ${chamber}`, 'ok');

    /* ---- 4. offset semantics (the core question) ------------------- */
    hd('4 · setpoint offset semantics');

    let baseline = await readTyped('/p/app/tmpo', TYPE.FLOAT);
    log('baseline /p/app/tmpo = ' + f1(baseline), 'dm');

    /* Restore zero first so the test starts from a known state. */
    const zero = await writeEcho(0);
    log('write 0  → read ' + f1(zero), zero === 0 ? 'ok' : 'dm');

    const plus1 = await writeEcho(1);
    log('write +1 → read ' + f1(plus1));
    const minus1 = await writeEcho(-1);
    log('write -1 → read ' + f1(minus1));
    const plus25 = await writeEcho(25);
    log('write +25 → read ' + f1(plus25));
    const minus25 = await writeEcho(-25);
    log('write -25 → read ' + f1(minus25));
    const restored = await writeEcho(0);
    log('restored to 0 → read ' + f1(restored), 'dm');

    /* Interpretation. A value that echoes back unchanged means the path accepts
     * it. A value that comes back clamped tells us the device enforces the
     * bound itself. A value that comes back as the baseline means the path did
     * not store anything — inconclusive outside a session, not a "no". */
    const negAccepted = minus1 != null && minus1 < -0.01;
    const negClamped = minus1 != null && Math.abs(minus1) < 0.01 && plus1 != null && Math.abs(plus1 - 1) < 0.01;
    const plusAccepted = plus1 != null && Math.abs(plus1 - 1) < 0.01;
    const posClampedAt = plus25 != null && Math.abs(plus25 - 20) < 0.5;

    if (negAccepted) {
      setRow('neg', 'Negative delta', `accepted (${f1(minus1)} °C)`, 'pass');
      verdict('yes', 'Curves in both directions. The device accepts a negative setpoint offset.');
    } else if (negClamped && plusAccepted) {
      setRow('neg', 'Negative delta', 'clamped to 0', 'fail');
      verdict('part', 'Curves can only rise above the profile temperature. A descending curve will flatten at the profile.');
    } else if (!plusAccepted) {
      setRow('neg', 'Negative delta', 'unconfirmed — path did not store a value', 'unk');
      verdict('part', 'The offset did not echo outside a session. Run the live test to check it during heating.');
    } else {
      setRow('neg', 'Negative delta', 'unconfirmed', 'unk');
    }

    setRow('pos', 'Positive delta', plusAccepted ? `accepted (${f1(plus1)} °C)` : `echo ${f1(plus1)}`, plusAccepted ? 'pass' : 'unk');
    setRow('cap', 'Upper clamp', plus25 == null ? '—' : (posClampedAt ? 'clamped at 20 °C' : `echoed ${f1(plus25)} °C`), posClampedAt ? 'pass' : 'unk');

    /* ---- 5. profile depth ----------------------------------------- */
    hd('5 · profile slots');
    const slots = [0, 1, 2, 3, 4, 5, 6, 7, 12, 24];
    const found = [];
    for (const n of slots) {
      try {
        const nm = await readTyped(`/u/app/hc/${n}/name`, TYPE.STRING);
        const t = await readTyped(`/u/app/hc/${n}/temp`, TYPE.FLOAT);
        if (nm != null && nm.length > 0 && t != null) found.push(n);
        log(`  slot ${String(n).padStart(2)}: ${nm ? '"' + nm + '"' : '—'} ${t != null ? Math.round(cToF(t)) + '°F' : ''}`, nm ? '' : 'dm');
      } catch {
        log(`  slot ${String(n).padStart(2)}: no such slot`, 'dm');
      }
    }
    setRow('slots', 'Profile slots', `${found.length} respond (${found.join(', ')})`,
      found.length > 4 ? 'pass' : '');
    log('slots responding: ' + found.join(', '), 'ok');

    /* ---- 6. read rate --------------------------------------------- */
    hd('6 · poll rate');
    const t0 = performance.now();
    let n = 0;
    for (let i = 0; i < 15; i++) {
      try { await readRaw('/p/htr/temp'); n++; } catch { break; }
    }
    const perRead = (performance.now() - t0) / Math.max(1, n);
    setRow('rate', 'Read latency', `${Math.round(perRead)} ms / read (${n} reads)`,
      perRead < 250 ? 'pass' : '');
    log(`~${Math.round(perRead)} ms per read`, 'ok');

    /* ---- 7. counters --------------------------------------------- */
    const total = await readTyped('/p/app/odom/0/nc', TYPE.U32);
    const trip = await readTyped('/p/app/odom/1/nc', TYPE.U32);
    const remaining = await readTyped('/p/app/info/drem', TYPE.U8);
    const pwr = await readTyped('/p/htr/pwr', TYPE.FLOAT);
    const res = await readTyped('/p/htr/res', TYPE.FLOAT);
    setRow('odom', 'Counters', `${total ?? '—'} total · ${trip ?? '—'} trip · ~${remaining ?? '—'} left`);
    setRow('hidden', 'Hidden telemetry', `${f1(pwr)} W · ${res == null ? '—' : f1(res)} Ω`,
      pwr != null && res != null ? 'pass' : 'unk');

    hd('done — read-only phase complete');
    log('Live curve test is available below.', 'ok');
    $('#live').disabled = false;
    $('#copy').disabled = false;

  } catch (e) {
    log('error: ' + (e && e.message || e), 'er');
    verdict('no', 'Stopped: ' + (e && e.message || e));
  } finally {
    btn.disabled = false;
  }
}

/* ----------------------------------------------------------- live curve */

async function liveTest() {
  if (!lorax) return;
  const btn = $('#live');
  btn.disabled = true;

  try {
    hd('7 · live curve test');

    /* Start a session at the current profile temperature. */
    const profileC = await readTyped('/u/app/hc/0/temp', TYPE.FLOAT);
    const profileTime = await readTyped('/u/app/hc/0/time', TYPE.FLOAT);
    log(`profile 0: ${Math.round(cToF(profileC))} °F for ${Math.round(profileTime || 60)} s`);

    /* Long enough that the 25 s test cannot run out of session. */
    if (profileTime == null || profileTime < 40) {
      await lorax.write('/u/app/hc/0/time', TYPE.FLOAT, 90);
      log('extended slot 0 to 90 s for the test', 'dm');
    }

    await lorax.write('/p/app/mc', TYPE.U8, 7);   /* HEAT_CYCLE_START */
    log('session start sent');

    /* Wait for the device to actually enter a heat cycle. */
    let state = null;
    for (let i = 0; i < 40; i++) {
      state = await readTyped('/p/app/stat/id', TYPE.U8);
      if (state === 7 || state === 8) break;
      await sleep(150);
    }
    log('state = ' + state + (state === 7 || state === 8 ? ' (heating)' : ' (did not start)'),
      state === 7 || state === 8 ? 'ok' : 'er');
    if (state !== 7 && state !== 8) {
      await lorax.write('/p/app/mc', TYPE.U8, 8);
      btn.disabled = false;
      return;
    }

    /* The measurement has to isolate the OFFSET, not the preheat. Heating from
     * cold to the profile temperature produces a huge rise on its own, so wait
     * until the chamber has settled near that temperature — then a positive
     * offset should push it above the settled point. Measuring from cold
     * reports the heater warming up and calls it a curve. */
    const targetF = cToF(profileC);
    log(`waiting for the chamber to settle near ${Math.round(targetF)} °F…`, 'dm');

    let settledC = null;
    const waitStart = Date.now();
    let lastShown = -1;
    while (Date.now() - waitStart < 150000) {
      const c = await readTyped('/p/htr/temp', TYPE.FLOAT);
      const st = await readTyped('/p/app/stat/id', TYPE.U8);
      if (st !== 7 && st !== 8) { log('session ended while waiting', 'er'); break; }
      if (c != null) {
        const f = cToF(c);
        if (Math.abs(f - targetF) <= 12) { settledC = c; break; }
        const secs = Math.floor((Date.now() - waitStart) / 1000);
        if (secs % 10 === 0 && secs !== lastShown) {
          lastShown = secs;
          log(`  ${Math.round(f)} °F (${Math.round(f - targetF)} from target)`, 'dm');
        }
      }
      await sleep(500);
    }

    if (settledC == null) {
      log('chamber did not settle within 150 s — measuring anyway', 'dm');
      settledC = await readTyped('/p/htr/temp', TYPE.FLOAT);
    }
    const settledF = cToF(settledC);
    log(`settled at ${Math.round(settledF)} °F`, 'ok');
    setRow('settled', 'Settled temperature', `${Math.round(settledF)} °F`);

    /* The curve: 0 → +20 °F over 20 s. Well inside the offset cap. */
    const curve = template('ascent', { base: settledF, span: 20, hold: 20, unit: 'F' });
    const plan = buildPlan(curve, { profileC, unit: 'F', tickSec: 1, maxSlewCPerSec: 3 });
    log(`curve: ${plan.steps.length} writes over ${plan.duration} s`, 'dm');

    const samples = [];
    const started = Date.now();
    let stepIdx = 0;

    while (Date.now() - started < plan.duration * 1000 + 500) {
      const t = (Date.now() - started) / 1000;
      while (stepIdx < plan.steps.length && plan.steps[stepIdx].t <= t) {
        const step = plan.steps[stepIdx++];
        try { await lorax.write('/p/app/tmpo', TYPE.FLOAT, step.deltaC); } catch {}
      }
      const tempC = await readTyped('/p/htr/temp', TYPE.FLOAT);
      const echo = await readTyped('/p/app/tmpo', TYPE.FLOAT);
      if (tempC != null) samples.push({ t, tempC, echo });
      await sleep(200);
    }

    /* Clear and abort. */
    await lorax.write('/p/app/tmpo', TYPE.FLOAT, 0);
    await lorax.write('/p/app/mc', TYPE.U8, 8);
    await sleep(120);
    await lorax.write('/p/app/mc', TYPE.U8, 2);
    log('offset cleared, session aborted', 'ok');

    if (samples.length) {
      const peakF = Math.max(...samples.map(s => cToF(s.tempC)));
      const rose = peakF - settledF;
      const echoMax = Math.max(...samples.map(s => Math.abs(s.echo || 0)));

      log('');
      log('   t   chamber   offset', 'dm');
      for (const s of samples.filter((_, i) => i % 5 === 0)) {
        log(`  ${String(Math.round(s.t)).padStart(2)}s  ${String(Math.round(cToF(s.tempC))).padStart(5)}°F  ${String(f1(s.echo)).padStart(6)}`);
      }

      setRow('rise', 'Rise above settled', `+${Math.round(rose)} °F`, rose > 5 ? 'pass' : 'unk');
      setRow('echo', 'Peak offset stored', `${f1(echoMax)} °C`, echoMax > 0.1 ? 'pass' : 'fail');

      if (rose >= 8 && echoMax > 0.1) {
        verdict('yes', `Curve mode works. The chamber rose ${Math.round(rose)} °F above its settled temperature while following a host-driven setpoint offset.`);
      } else if (rose >= 3 && echoMax > 0.1) {
        verdict('part', `The offset is stored and moved the chamber ${Math.round(rose)} °F. It works, but the thermal response lags the command — expect curves to trail their line.`);
      } else if (echoMax > 0.1) {
        verdict('part', 'The device stores the offset but the chamber did not move measurably in 20 s. Try a longer run, or a chamber with more headroom below its target.');
      } else {
        verdict('no', 'The offset was not stored during a session, so a curve has nothing to drive.');
      }
    }

    $('#copy').disabled = false;

  } catch (e) {
    log('live test error: ' + (e && e.message || e), 'er');
    try { await lorax.write('/p/app/tmpo', TYPE.FLOAT, 0); } catch {}
    try { await lorax.write('/p/app/mc', TYPE.U8, 8); } catch {}
  } finally {
    btn.disabled = false;
  }
}

/* ----------------------------------------------------------------- copy */

function copyResults() {
  const lines = [
    'Peak Pro probe — ' + new Date().toISOString(),
    '',
    ...Object.values(R).map(r => `${r.label}: ${r.value}`),
    '',
    'log:',
    $('#log').textContent,
  ];
  navigator.clipboard.writeText(lines.join('\n')).then(
    () => { $('#copy').textContent = 'Copied'; setTimeout(() => { $('#copy').textContent = 'Copy results'; }, 1600); },
    () => { $('#copy').textContent = 'Copy failed'; },
  );
}

$('#go').addEventListener('click', probe);
$('#live').addEventListener('click', liveTest);
$('#copy').addEventListener('click', copyResults);
renderRows();
