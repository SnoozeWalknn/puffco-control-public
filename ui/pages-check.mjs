/* Prove the deployed Pages build boots: modules resolve, the simulator
 * connects, and a curve can be started. No hardware involved. */
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
p.on('pageerror', e => errs.push('pageerror: ' + e.message));
/* The optional local key file 404s on a fresh deploy; that is expected. */
p.on('console', m => {
  if (m.type() !== 'error') return;
  const where = m.location()?.url || '';
  if (/handshake\.local\.js/.test(where) || /handshake\.local\.js/.test(m.text())) return;
  errs.push(m.text() + ' @ ' + where);
});
await p.goto(URL_, { waitUntil: 'networkidle' });
await p.waitForTimeout(1200);
const hasConnect = await p.isVisible('#sc-connect');
await p.click('#cxDemo');
await p.waitForTimeout(2500);
const st = await p.evaluate(() => window.__puffco && window.__puffco());
console.log(JSON.stringify({ url: URL_, hasConnect, connected: st?.connected, chamberF: st && st.tempC != null ? +(st.tempC*9/5+32).toFixed(1) : null, errors: errs.slice(0,5) }, null, 2));
const ok = hasConnect && st?.connected === true && errs.length === 0;
console.log(ok ? 'pages-check: PASS' : 'pages-check: FAIL');
await br.close();
process.exit(ok ? 0 : 1);
