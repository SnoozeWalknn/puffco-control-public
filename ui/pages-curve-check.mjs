/* Does a CURVE run on the deployed Pages URL? It has no device, so the honest
 * answer is "only against the simulator". */
import { chromium } from 'playwright';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
function chrome(){ const b=chromium.executablePath(); if(fs.existsSync(b))return b;
 const r=path.join(os.homedir(),'.cache/ms-playwright');
 for(const d of fs.readdirSync(r).filter(x=>x.startsWith('chromium-')).sort().reverse())
  for(const s of ['chrome-linux64/chrome','chrome-linux/chrome']){const q=path.join(r,d,s);if(fs.existsSync(q))return q;}
 throw new Error('no chrome'); }
const URL_ = process.env.APP_URL || 'https://snoozewalknn.github.io/puffco-control-public/ui/app.html';
const br = await chromium.launch({ executablePath: chrome(), args: ['--no-sandbox'] });
const p = await br.newPage();
const errs = [];
p.on('pageerror', e => errs.push(e.message));
await p.goto(URL_, { waitUntil: 'networkidle' });
await p.waitForTimeout(900);
await p.click('#cxDemo');
await p.waitForTimeout(1800);

/* Shrink the curve, then start a session from the heat tab. */
await p.click('.tab[data-go="curves"]');
await p.waitForTimeout(400);
await p.click('[data-template="ascent"]');
await p.waitForTimeout(300);
for (let i = 0; i < 6; i++) { await p.click('[data-clen="-10"]'); await p.waitForTimeout(120); }
const len = (await p.textContent('#cvLen')).trim();

await p.click('.tab[data-go="heat"]');
await p.waitForTimeout(300);
await p.click('#hxStart');

/* Wait for the curve to actually progress. */
let best = null;
const end = Date.now() + 45000;
while (Date.now() < end) {
  const d = await p.evaluate(() => window.__puffco && window.__puffco());
  if (d && (d.curveProgress || 0) > 0) best = d;
  if (d && d.curveProgress >= d.curveDuration && d.curveDuration > 0) { best = d; break; }
  await p.waitForTimeout(500);
}
const rec = await p.evaluate(() => window.__rec().trim().split('\n').length - 1);
console.log(JSON.stringify({
  url: URL_, curveLength: len,
  curveProgress: best?.curveProgress, curveDuration: best?.curveDuration,
  liveWrites: best?.liveWrites, running: best?.curveRunning, recorderRows: rec,
  errors: errs.slice(0, 3),
}, null, 2));
const ok = (best?.curveProgress || 0) > 0 && errs.length === 0;
console.log(ok ? 'pages-curve: PASS (simulator)' : 'pages-curve: FAIL');
await br.close();
process.exit(ok ? 0 : 1);
