/* Recorder smoke: connect to the simulator, run a curve, prove the CSV has
 * before / during / after rows. Run with the ui server on 8791:
 *   node ui/rec-smoke.mjs
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

const browser = await chromium.launch({ executablePath: resolveChrome(), args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto(process.env.APP_URL || 'http://127.0.0.1:8791/app.html');
await page.click('#cxDemo');
await page.waitForTimeout(1500);

/* BEFORE: idle, recorded. */
const beforeRows = await page.evaluate(() => window.__rec().split('\n').length - 1);

await page.click('#hxStart');
await page.waitForTimeout(9000);
const during = await page.evaluate(() => window.__puffco());
const csv = await page.evaluate(() => window.__rec());
const lines = csv.trim().split('\n');
const head = lines[0].split(',');
const rows = lines.slice(1).map(l => Object.fromEntries(l.split(',').map((v, i) => [head[i], v])));

const inSession = rows.filter(r => r.inSession === '1');
const idle = rows.filter(r => r.inSession === '0');
const withCurve = rows.filter(r => r.curveS !== '');
const tcmdMoves = new Set(rows.map(r => r.tcmdF).filter(Boolean)).size;

console.log(JSON.stringify({
  beforeRows,
  totalRows: rows.length,
  idleRows: idle.length,
  inSessionRows: inSession.length,
  curveRows: withCurve.length,
  distinctTcmd: tcmdMoves,
  maxCurveS: Math.max(0, ...rows.map(r => Number(r.curveS) || 0)),
  running: during.curveRunning,
}, null, 2));

/* Idle polls run at 5 s and in-session polls at 400 ms, so the row counts are
 * set by the app's own cadence: a few before, roughly one per tick during. */
const ok = idle.length >= 1 && inSession.length >= 8 && withCurve.length >= 8 && tcmdMoves >= 3;
console.log(ok ? 'rec-smoke: PASS' : 'rec-smoke: FAIL');
await browser.close();
process.exit(ok ? 0 : 1);
