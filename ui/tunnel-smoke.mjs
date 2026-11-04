/* Browser → token-gated tunnel → bridge → Peak. Proves the page's own
 * WebSocket carries ?t= into the upgrade, which is the only way the browser
 * path works behind the tunnel. Read-only: connects and polls, never heats.
 *
 *   node ui/tunnel-smoke.mjs http://127.0.0.1:8797 testtoken123
 */
import { chromium } from 'playwright';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
function chrome(){ const b=chromium.executablePath(); if(fs.existsSync(b))return b;
 const r=path.join(os.homedir(),'.cache/ms-playwright');
 for(const d of fs.readdirSync(r).filter(x=>x.startsWith('chromium-')).sort().reverse())
  for(const s of ['chrome-linux64/chrome','chrome-linux/chrome']){const q=path.join(r,d,s);if(fs.existsSync(q))return q;}
 throw new Error('no chrome'); }

const base = process.argv[2] || 'http://127.0.0.1:8797';
const token = process.argv[3] || '';
const addr = process.argv[4] || 'F0:AD:4E:41:5B:76';

const br = await chromium.launch({ executablePath: chrome(), args: ['--no-sandbox'] });
const p = await br.newPage();
const errs = [];
p.on('pageerror', e => errs.push(e.message));
p.on('console', m => {
  if (m.type() !== 'error') return;
  const where = m.location()?.url || '';
  if (/handshake\.local\.js/.test(where) || /handshake\.local\.js/.test(m.text())) return;
  errs.push(m.text() + ' @ ' + where);
});

const url = `${base}/app.html?bridge=1&addr=${encodeURIComponent(addr)}${token ? '&t=' + token : ''}`;
await p.goto(url);
await p.waitForTimeout(600);
await p.click('#cxGo');

const end = Date.now() + 30000;
let st = null;
while (Date.now() < end) {
  st = await p.evaluate(() => window.__puffco && window.__puffco());
  if (st?.connected && (st.pollTicks || 0) >= 2) break;
  await p.waitForTimeout(500);
}

const out = {
  url,
  connected: st?.connected,
  firmware: st?.firmware,
  authMode: st?.authMode,
  chamberF: st?.tempC == null ? null : +(st.tempC * 9 / 5 + 32).toFixed(1),
  pollTicks: st?.pollTicks,
  errors: errs.slice(0, 4),
};
console.log(JSON.stringify(out, null, 2));
const ok = out.connected === true && out.pollTicks >= 2 && errs.length === 0;
console.log(ok ? 'tunnel-smoke: PASS' : 'tunnel-smoke: FAIL');
await br.close();
process.exit(ok ? 0 : 1);
