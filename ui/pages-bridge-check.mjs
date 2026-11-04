/* Does the DEPLOYED Pages URL reach the local bridge?
 * The page is https, the bridge is ws:// — mixed content is the question. */
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
const msgs = [];
p.on('console', m => msgs.push(m.type() + ': ' + m.text()));
p.on('pageerror', e => msgs.push('pageerror: ' + e.message));
await p.goto(`${URL_}?bridge=1&addr=F0:AD:4E:41:5B:76`, { waitUntil: 'networkidle' });
await p.waitForTimeout(800);
await p.click('#cxGo').catch(e => msgs.push('click: ' + e.message));
await p.waitForTimeout(6000);
const st = await p.evaluate(() => window.__puffco && window.__puffco());
const bridgeUrl = await p.evaluate(() => {
  try { return import('./ble.js').then(m => m.BRIDGE_URL); } catch { return null; }
});
console.log(JSON.stringify({ url: URL_, connected: st?.connected, pollTicks: st?.pollTicks, bridgeUrl, msgs: msgs.slice(0, 12) }, null, 2));
await br.close();
