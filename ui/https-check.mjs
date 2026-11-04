/* Serve the same ui over a self-signed https origin and confirm the guard
 * explains the refusal instead of hanging. */
import { chromium } from 'playwright';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
function chrome(){ const b=chromium.executablePath(); if(fs.existsSync(b))return b;
 const r=path.join(os.homedir(),'.cache/ms-playwright');
 for(const d of fs.readdirSync(r).filter(x=>x.startsWith('chromium-')).sort().reverse())
  for(const s of ['chrome-linux64/chrome','chrome-linux/chrome']){const q=path.join(r,d,s);if(fs.existsSync(q))return q;}
 throw new Error('no chrome'); }
const br = await chromium.launch({ executablePath: chrome(), args: ['--no-sandbox', '--ignore-certificate-errors'] });
const p = await br.newPage();
await p.goto(process.env.APP_URL, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(800);
await p.click('#cxGo').catch(()=>{});
await p.waitForTimeout(2500);
console.log(JSON.stringify({
  sub: (await p.textContent('#cxSub').catch(()=>null))?.slice(0,240),
  connected: await p.evaluate(() => window.__puffco?.()?.connected),
}, null, 2));
await br.close();
