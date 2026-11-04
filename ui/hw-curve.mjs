/* One curve on real hardware, browser → bridge.py → Peak.
 *
 *   node ui/hw-curve.mjs <MAC> [--temp 455] [--len 30] [--max 150]
 *
 * Records before / during / after from the page's own recorder, because a Peak
 * takes one BLE connection and nothing else can read it while the browser holds
 * the link. Writes the CSV to runs/ and prints a verdict.
 *
 * Safety: refuses to start below --min-charge (default 55 %), aborts on any
 * chamber reading >= 600 °F, and aborts the session on every exit path.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function resolveChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const bundled = chromium.executablePath();
  if (fs.existsSync(bundled)) return bundled;
  const root = path.join(os.homedir(), '.cache/ms-playwright');
  for (const d of fs.readdirSync(root).filter(x => x.startsWith('chromium-')).sort().reverse()) {
    for (const s of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const q = path.join(root, d, s);
      if (fs.existsSync(q)) return q;
    }
  }
  throw new Error('no Chromium found');
}

const args = process.argv.slice(2);
const addr = args.find(a => !a.startsWith('--'));
const flag = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const TEMP_F = flag('temp', 455);
const LEN_S = flag('len', 30);
const MAX_S = flag('max', 150);
const MIN_CHARGE = flag('min-charge', 55);

if (!addr) { console.error('usage: node ui/hw-curve.mjs <MAC>'); process.exit(2); }

const RUNS = new URL('../runs/', import.meta.url).pathname;
fs.mkdirSync(RUNS, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const csvPath = path.join(RUNS, `hw-${stamp}.csv`);

const browser = await chromium.launch({ executablePath: resolveChrome(), args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });

const consoleLog = [];
page.on('console', m => {
  const t = m.text();
  consoleLog.push(`[${m.type()}] ${t}`);
  if (/Governor|verify|adapter/i.test(t)) console.log('  page> ' + t);
});
page.on('pageerror', e => consoleLog.push('pageerror: ' + e.message));

const snap = () => page.evaluate(() => (window.__puffco ? window.__puffco() : null));
const f = c => (c == null ? null : +(c * 9 / 5 + 32).toFixed(1));
const say = (...a) => console.log(...a);

/* ---------------------------------------------------------------- before */

await page.addInitScript(([t, l]) => {
  localStorage.setItem('puffco.tempF', String(t));
  localStorage.setItem('puffco.lenS', String(l));
}, [TEMP_F, LEN_S]);

const base = process.env.APP_BASE || 'http://127.0.0.1:8796';
const token = process.env.APP_TOKEN || '';
await page.goto(`${base}/app.html?bridge=1&addr=${encodeURIComponent(addr)}${token ? '&t=' + token : ''}`);
await page.waitForTimeout(400);
await page.click('#cxGo');

async function waitFor(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await page.waitForTimeout(400);
  }
  throw new Error('timeout waiting for ' + label);
}

try {
  await waitFor(async () => (await page.evaluate(() => window.__S?.pollTicks || 0)) >= 2, 40000, 'first polls');
} catch (e) {
  const diag = await page.evaluate(() => ({
    sub: document.querySelector('#cxSub')?.textContent,
    connected: window.__puffco?.()?.connected,
    screen: window.__S?.screen,
  }));
  say('\nCOULD NOT CONNECT: ' + JSON.stringify(diag));
  say(consoleLog.slice(-10).join('\n'));
  await browser.close();
  process.exit(5);
}

const before = await snap();
say('\n=== BEFORE ===');
say(`  state ${before.state}  chamber ${f(before.tempC)} °F  tcmd ${f(before.targetC)} °F  inSession ${before.inSession}`);
say(`  firmware ${before.firmware}  auth ${before.authMode}`);

if (before.inSession) {
  say('\nABORT: device is already in a session. Let it finish and idle first.');
  await browser.close();
  process.exit(3);
}

/* The app does not surface SOC in __puffco; read it from the page's status. */
const soc = await page.evaluate(() => window.__S?.status?.soc ?? null);
say(`  battery ${soc == null ? 'unknown' : soc.toFixed(1) + ' %'}`);
if (soc != null && soc < MIN_CHARGE) {
  say(`\nABORT: battery ${soc.toFixed(1)} % is below the ${MIN_CHARGE} % gate.`);
  say('Below this the heater sags and the result is ambiguous.');
  await browser.close();
  process.exit(4);
}

/* ------------------------------------------------------------------ set up */

await page.click('.tab[data-go="curves"]');
await page.waitForTimeout(400);
await page.click('[data-template="ascent"]');
await page.waitForTimeout(300);
for (let i = 0; i < 12; i++) {
  const t = await page.textContent('#cvLen');
  const n = Number((t.match(/\d+/) || [0])[0]);
  if (n <= LEN_S) break;
  await page.click('[data-clen="-10"]');
  await page.waitForTimeout(150);
}
const lenTxt = await page.textContent('#cvLen');
const tempTxt = await page.textContent('#cvTemp').catch(() => '');
say(`\n=== SETUP ===\n  curve length ${lenTxt.trim()}  target ${tempTxt.trim() || TEMP_F + ' °F'}`);

await page.evaluate(() => window.__recReset());
await page.click('.tab[data-go="heat"]');
await page.waitForTimeout(300);

/* ------------------------------------------------------------------ during */

say('\n=== DURING ===');
const t0 = Date.now();
await page.click('#hxStart');

let lastPrint = 0;
let maxF = before.tempC == null ? 0 : before.tempC;
let sawActive = false;
let sawComplete = false;

while ((Date.now() - t0) / 1000 < MAX_S) {
  await page.waitForTimeout(1000);
  const d = await snap();
  if (!d) continue;
  if (d.tempC != null) maxF = Math.max(maxF, d.tempC);
  if (d.state === 8) sawActive = true;
  if (d.curveProgress >= d.curveDuration) sawComplete = true;

  const el = ((Date.now() - t0) / 1000).toFixed(0);
  if (Date.now() - lastPrint > 3000) {
    lastPrint = Date.now();
    say(`  ${el}s  state ${d.state}  chamber ${f(d.tempC)}°F  tcmd ${f(d.targetC)}°F`
      + `  curve ${d.curveProgress}/${d.curveDuration}s`
      + `  ${d.curveRunning ? 'running' : 'stopped'}`);
  }
  if (d.tempC != null && f(d.tempC) >= 600) {
    say('\n  EMERGENCY: chamber >= 600 °F — aborting.');
    await page.click('#ssAbort').catch(() => {});
    break;
  }
  if (!d.curveRunning && d.curveProgress > 0) break;   // finished or ended early
  if (!d.inSession && el > 20) break;
}

/* ------------------------------------------------------------------- after */

await page.waitForTimeout(1500);
const after = await snap();
const csv = await page.evaluate(() => window.__rec());
fs.writeFileSync(csvPath, csv);

if (after && after.inSession) {
  say('\n  session still live — aborting.');
  await page.click('#ssAbort').catch(() => {});
  await page.waitForTimeout(2000);
}

const rows = csv.trim().split('\n').slice(1).map(l => {
  const h = csv.trim().split('\n')[0].split(',');
  return Object.fromEntries(l.split(',').map((v, i) => [h[i], v]));
});
const inSession = rows.filter(r => r.inSession === '1');
const peakRow = inSession.reduce((m, r) => (Number(r.chamberF) > Number(m?.chamberF || 0) ? r : m), null);
const tcmdVals = [...new Set(inSession.map(r => r.tcmdF).filter(Boolean))].map(Number);

say('\n=== AFTER ===');
say(`  state ${after?.state}  chamber ${f(after?.tempC)} °F  inSession ${after?.inSession}`);
say(`  csv ${csvPath}  (${rows.length} rows, ${inSession.length} in-session)`);

say('\n=== VERDICT ===');
const checks = [
  ['preheat reached HEAT_ACTIVE', sawActive],
  ['curve completed', sawComplete],
  /* liveWrites is a simulator counter; on hardware the proof is that tcmd took
   * more than one distinct value during the session. */
  ['live target drove tcmd', tcmdVals.length >= 3, `distinct tcmd: ${tcmdVals.length}`],
  ['peak chamber > 300 °F', peakRow && Number(peakRow.chamberF) > 300,
    peakRow ? `peak ${Number(peakRow.chamberF).toFixed(1)} °F` : 'no in-session rows'],
  ['session ended', after?.inSession === false],
  ['no demote to boost', !consoleLog.some(l => /switching to boost override/i.test(l))],
];
let failed = 0;
for (const [name, ok, detail] of checks) {
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!ok) failed++;
}

if (failed) {
  say('\n--- governor log ---');
  for (const l of consoleLog.filter(l => /Governor|verify|adapter/i.test(l)).slice(-25)) say('  ' + l);
}

say(`\n${failed ? 'hw-curve: FAIL (' + failed + ')' : 'hw-curve: PASS'}`);
await browser.close();
process.exit(failed ? 1 : 0);
