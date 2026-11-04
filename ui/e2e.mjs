/* End-to-end proof in a real browser against the simulator.
 *   ~/.local/opt/node/bin/node ui/e2e.mjs
 *
 * Clicks through the actual app: connect → heat → start → curve runs → abort,
 * then reads the DOM and the simulator's internal state to check that what the
 * screen says matches what the "device" was told.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* Browser resolution, in order: CHROME_PATH, the bundled build Playwright
 * expects, then any installed Chromium. The last one matters because a
 * system-wide Playwright may be pinned to a build that is not the one in the
 * cache. */
function resolveChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const bundled = chromium.executablePath();
  if (fs.existsSync(bundled)) return bundled;
  const root = path.join(os.homedir(), '.cache/ms-playwright');
  if (fs.existsSync(root)) {
    for (const dir of fs.readdirSync(root).filter(d => d.startsWith('chromium-')).sort().reverse()) {
      for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
        const p = path.join(root, dir, sub);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  throw new Error('no Chromium found — set CHROME_PATH');
}

const CHROME = resolveChrome();
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:8791/app.html';
const OUT = new URL('./shots/', import.meta.url).pathname;

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL ' + name + (detail ? '\n  ' + detail : '')); }
};

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--font-render-hinting=none'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e));
/* handshake.local.js is gitignored and absent on a fresh clone; its 404 is
 * expected and is not a page fault. */
page.on('console', m => {
  if (m.type() === 'error' && !/handshake\.local\.js/.test(m.text())) errors.push('console: ' + m.text());
});

await page.goto(APP_URL);
await page.waitForTimeout(500);

/* ---------------------------------------------------------- connect */

check('connect screen is shown first', await page.isVisible('#sc-connect'));
check('tab bar is hidden before connecting', await page.isHidden('#tabs'));

await page.click('#cxDemo');
await page.waitForTimeout(1800);

check('connected: heat screen visible', await page.isVisible('#sc-heat'));
check('tab bar appears after connect', await page.isVisible('#tabs'));

const hxNow = await page.textContent('#hxNow');
check('chamber reading is populated', /\d+/.test(hxNow), 'got: ' + hxNow);

const sub = await page.textContent('#hxSub');
check('header shows state, resistance and battery', /Ω/.test(sub) && /%/.test(sub), 'got: ' + sub);
const cxSub = await page.textContent('#cxSub');
check('connect screen reported firmware + auth mode', /AG/.test(cxSub) && /handshake|seed/.test(cxSub), 'got: ' + cxSub);

const chips = await page.$$('#hxChips .chip');
check('four preset chips render', chips.length === 4, 'got ' + chips.length);

/* -------------------------------------------------------- steppers */

const before = await page.textContent('#hxTemp');
await page.click('[data-temp="1"]');
await page.waitForTimeout(250);
const after = await page.textContent('#hxTemp');
check('temperature stepper changes the value', before !== after, `${before} -> ${after}`);

await page.click('[data-len="5"]');
await page.waitForTimeout(200);
const len = await page.textContent('#hxLen');
check('length stepper changes the value', len.includes('65'), 'got ' + len);

/* ------------------------------------------------------------ curve */

await page.click('.tab[data-go="curves"]');
await page.waitForTimeout(400);
check('curves screen visible', await page.isVisible('#sc-curves'));

const modes = await page.$$('#cvModes .mode');
check('five curve templates (valley removed — needs a negative offset)',
  modes.length === 5, 'got ' + modes.length);
const labels = await page.$$eval('#cvModes .mode', els => els.map(e => e.textContent.trim()));
check('no valley offered', !labels.some(l => /valley/i.test(l)), labels.join(','));

/* The banner must report a measured lag, not a canned sentence. */
await page.click('[data-template="descent"]');
await page.waitForTimeout(400);
const warnTxt = await page.textContent('#cvWarnTxt');
check('warning names a real constraint', /°F/.test(warnTxt) && /(Within reach|below the profile|offset tops out|Cooling-limited)/.test(warnTxt), 'got: ' + warnTxt);

/* Shrink the curve so the same 30 °F span becomes a fast ramp — the shape that
 * actually needs several writes per second. */
for (let i = 0; i < 6; i++) await page.click('[data-clen="-10"]');
await page.waitForTimeout(300);
const lenTxt = await page.textContent('#cvLen');
check('curve length stepper reaches 30 s', /30/.test(lenTxt), 'got: ' + lenTxt);

/* back to a climb for the session */
await page.click('[data-template="ascent"]');
await page.waitForTimeout(400);
const warnCls2 = await page.getAttribute('#cvWarn', 'class');
check('a 30 s ascent is within reach', warnCls2.includes('ok'), 'class: ' + warnCls2);

/* ---------------------------------------------------------- session */

await page.click('.tab[data-go="heat"]');
await page.waitForTimeout(300);
await page.click('#hxStart');
await page.waitForTimeout(2200);

check('session screen opens on start', await page.isVisible('#sc-session'));
const ssNow = await page.textContent('#ssNow');
check('session shows a chamber reading', /\d+/.test(ssNow), 'got: ' + ssNow);

const snapshot = () => page.evaluate(() => (window.__puffco ? window.__puffco() : null));

/* Wait for the governor to enter the curve timeline (elapsed_s moves). */
async function waitForProgress(min, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const d = await snapshot();
    if (d && d.curveProgress >= min) return d;
    await page.waitForTimeout(300);
  }
  return null;
}

const running = await waitForProgress(4);
check('curve reaches the timeline', running != null,
  running ? '' : 'never passed 4 s of curve time');

/* A 4 s telemetry blackout: every state read fails, which the app reports as
 * null. The pre-fix governor read that as "the session ended" and stopped the
 * run. This is the regression, and it is checked on the run itself. */
await page.evaluate(() => { const d = window.__puffco(); if (d) d.dropState(1); });
await page.waitForTimeout(4000);
await page.evaluate(() => { const d = window.__puffco(); if (d) d.dropState(0); });
await page.waitForTimeout(1500);

const devState = await snapshot();
check('debug hook is exposed for assertions', devState != null);

if (devState) {
  check('simulator is in a session state', devState.inSession === true, JSON.stringify(devState));
  check('curve survives a 4 s telemetry blackout', devState.curveRunning === true,
    'curveRunning=' + devState.curveRunning + ' progress=' + devState.curveProgress);
  check('curve wrote the live session target', devState.liveWrites >= 3, 'liveWrites=' + devState.liveWrites);
  check('curve is making progress', devState.curveProgress > 0, 'progress=' + devState.curveProgress);
  check('device temperature is rising', devState.tempC > devState.startC, `${devState.startC} -> ${devState.tempC}`);

  /* The heater's target is the live base plus the offset. The two are sampled
   * at different times, so allow one curve step of drift rather than an exact
   * match — the curve moves the base ~2 °C per write. */
  const impliedTarget = devState.liveTargetC + devState.override;
  check('heater target equals live base plus offset',
    Math.abs(impliedTarget - devState.targetC) < 3.5,
    `live ${devState.liveTargetC} + offset ${devState.override} = ${impliedTarget}, device says ${devState.targetC}`);
  /* The live base is an absolute °C setpoint, not a delta: a delta would sit
   * near zero, and a Fahrenheit number would read ~250. */
  check('live target is an absolute setpoint in Celsius',
    devState.liveTargetC > 100 && devState.liveTargetC < 400,
    'liveTargetC=' + devState.liveTargetC);

  /* The coil setpoint must sit ABOVE the chamber target by the gradient. Writing
   * the chamber target straight through made the curve track the coil and land
   * ~22 F low on hardware. */
  if (devState.curveTargetF != null) {
    const coilF = devState.liveTargetC * 9 / 5 + 32;
    const gap = coilF - devState.curveTargetF;
    check('coil setpoint leads the chamber target by the gradient',
      gap > 12 && gap < 40,
      `coil ${coilF.toFixed(1)} F, curve wants ${devState.curveTargetF} F, gap ${gap.toFixed(1)} F`);
  } else {
    check('coil setpoint leads the chamber target by the gradient', false, 'no curve target reported');
  }
}

const curveCard = await page.isVisible('#ssCurveCard');
check('curve progress card is shown', curveCard);

await page.screenshot({ path: OUT + '/session.png' });

/* ------------------------------------------------------------ abort */

await page.click('#ssAbort');
await page.waitForTimeout(1200);
check('abort returns to heat', await page.isVisible('#sc-heat'));

const afterAbort = await page.evaluate(() => (window.__puffco ? window.__puffco() : null));
if (afterAbort) {
  check('abort left no curve running', afterAbort.curveRunning === false, 'curveRunning=' + afterAbort.curveRunning);
  check('abort leaves the session', afterAbort.inSession === false, JSON.stringify(afterAbort));
}

/* ---------------------------------------------------------- profiles */

await page.click('.tab[data-go="profiles"]');
await page.waitForTimeout(500);
const pcards = await page.$$('#pfGrid .pcard');
check('four profile cards', pcards.length === 4, 'got ' + pcards.length);
const pfSub = await page.textContent('#pfSub');
check('profile header reports slots', /slot/i.test(pfSub), 'got: ' + pfSub);

await page.click('[data-profile="2"]');
await page.waitForTimeout(400);
const selected = await page.evaluate(() => window.__puffco().profileCurrent);
check('selecting a profile writes the device slot', selected === 2, 'got ' + selected);

/* A tab must show current data, not what it was drawn with at connect time.
 *
 * The staleness path: starting a session writes the profile temperature, and
 * nothing on the Profiles screen is touched afterwards. If tab entry does not
 * re-render, the card keeps the temperature from connect time. */
/* Back to slot 0: the previous check selected slot 2, and the session writes
 * to whichever slot is selected. */
await page.click('[data-profile="0"]');
await page.waitForTimeout(400);

const heatTemp = (await page.textContent('#hxTemp')).trim();
await page.click('.tab[data-go="heat"]');
await page.waitForTimeout(200);
for (let i = 0; i < 7; i++) await page.click('[data-temp="1"]');
await page.waitForTimeout(300);
const raised = (await page.textContent('#hxTemp')).trim();
check('raising the temperature actually changed it', raised !== heatTemp, `${heatTemp} -> ${raised}`);

await page.click('#hxStart');
await page.waitForTimeout(2200);
await page.click('#ssAbort');
await page.waitForTimeout(900);

await page.click('.tab[data-go="profiles"]');
await page.waitForTimeout(500);
const cardTxt = (await page.textContent('#pfGrid .pcard')).replace(/\s+/g, ' ');
const wanted = raised.replace('°F', '');
check('profile card shows the temperature the session wrote', cardTxt.includes(wanted),
  `wanted ${wanted}, card reads: ${cardTxt.trim()}`);

/* ------------------------------------------------------------- mood */

await page.click('.tab[data-go="mood"]');
await page.waitForTimeout(400);
const sw = await page.$$('#mdColors .sw2');
check('six colour swatches', sw.length === 6, 'got ' + sw.length);

await page.click('[data-color="1"]');
await page.waitForTimeout(300);
const orbBg = await page.evaluate(() => document.querySelector('#mdOrb').style.background);
check('picking a colour updates the orb', /rgb\(255, 77, 109\)/.test(orbBg), orbBg.slice(0, 80));

await page.click('#mdToggle');
await page.waitForTimeout(400);
const lanternOn = await page.evaluate(() => window.__puffco().lantern);
check('lantern turns on', lanternOn === 1, 'lantern=' + lanternOn);

/* ------------------------------------------------------------- peak */

await page.click('.tab[data-go="peak"]');
await page.waitForTimeout(600);
const fw = await page.textContent('#pkFw');
check('firmware shown on Peak', /AG/.test(fw), 'got: ' + fw);
const soc = await page.textContent('#pkSoc');
check('battery percentage shown', /72/.test(soc), 'got: ' + soc);
const ohm = await page.textContent('#pkOhm');
check('coil resistance shown (hidden by the official app)', /4\.1/.test(ohm), 'got: ' + ohm);



/* ------------------------------------------------------------ units */

await page.click('[data-unit="C"]');
await page.waitForTimeout(300);
await page.click('.tab[data-go="heat"]');
await page.waitForTimeout(400);
const heatC = await page.textContent('#hxTemp');
check('celsius switch changes the readout', /°C/.test(heatC), 'got: ' + heatC);

/* ------------------------------------------------------- no overflow */

const overflow = await page.evaluate(() => [...document.querySelectorAll('.scr')]
  .filter(s => s.classList.contains('on'))
  .map(s => s.scrollHeight - s.clientHeight));
check('active screen does not overflow', overflow.every(v => v <= 2), JSON.stringify(overflow));

/* The recorder is what makes a run inspectable without a second process: a
 * Peak takes one BLE connection, so nothing else can read the device while the
 * app holds it. */
const recRows = await page.evaluate(() => window.__rec().trim().split('\n'));
check('recorder produced a csv with a header and rows', recRows.length > 5, 'rows=' + recRows.length);
check('recorder captured an in-session sample',
  recRows.slice(1).some(r => r.split(',')[2] === '1'), 'no inSession=1 row');

check('no console or page errors', errors.length === 0, errors.join('\n'));

console.log(`\ne2e: ${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
