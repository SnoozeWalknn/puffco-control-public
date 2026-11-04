/* Real-link smoke: browser → bridge.py → Peak. Connects, reads, records, and
 * NEVER starts a session. Safe at any battery level.
 *
 *   node ui/real-smoke.mjs <MAC>
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

const addr = process.argv[2] || process.env.PEAK_ADDR;
if (!addr) { console.error('usage: node ui/real-smoke.mjs <MAC>'); process.exit(2); }

const browser = await chromium.launch({ executablePath: resolveChrome(), args: ['--no-sandbox'] });
const page = await browser.newPage();
const logs = [];
page.on('console', m => logs.push(m.type() + ': ' + m.text()));
page.on('pageerror', e => logs.push('pageerror: ' + e.message));

await page.goto(`http://127.0.0.1:8796/app.html?bridge=1&addr=${encodeURIComponent(addr)}`);
await page.waitForTimeout(500);
await page.click('#cxGo');

/* Connect + auth + first polls. No session is started by connecting.
 * Idle polling runs at 5 s, so wait for polls rather than for a fixed time. */
async function waitForTicks(n, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = await page.evaluate(() => window.__S?.pollTicks || 0);
    if (t >= n) return true;
    await page.waitForTimeout(500);
  }
  return false;
}
const gotTicks = await waitForTicks(3);

const state = await page.evaluate(() => (window.__puffco ? window.__puffco() : null));
const rec = await page.evaluate(() => (window.__rec ? window.__rec() : ''));
const screen = await page.evaluate(() => window.__S?.screen);

const rows = rec.trim() ? rec.trim().split('\n').length - 1 : 0;
const verdict = {
  connected: state?.connected,
  screen,
  firmware: state?.firmware,
  authMode: state?.authMode,
  inSession: state?.inSession,
  stateCode: state?.state,
  chamberC: state?.tempC,
  chamberF: state?.tempC == null ? null : +(state.tempC * 9 / 5 + 32).toFixed(1),
  tcmdC: state?.targetC,
  recorderRows: rows,
  pollTicks: state?.pollTicks,
};

console.log(JSON.stringify({ ...verdict, gotTicks }, null, 2));
if (verdict.inSession) {
  console.log('WARNING: device is in a session — this smoke expected idle.');
}
const ok = verdict.connected === true
  && typeof verdict.chamberC === 'number'
  && verdict.chamberC > 0
  && verdict.pollTicks >= 3
  && verdict.recorderRows >= 2;
console.log(ok ? 'real-smoke: PASS' : 'real-smoke: FAIL');
if (!ok) console.log(logs.slice(-25).join('\n'));
await browser.close();
process.exit(ok ? 0 : 1);
