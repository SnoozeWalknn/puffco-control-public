/* Screenshots of the real app, for review. Needs the server on 8791:
 *   node ui/shots.mjs
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
const OUT = new URL('./shots/', import.meta.url).pathname;

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--font-render-hinting=none'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto('http://127.0.0.1:8791/app.html');
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/connect.png` });

await page.click('#cxDemo');
await page.waitForTimeout(12000);           // let the heat graph accumulate
await page.screenshot({ path: `${OUT}/heat.png` });

await page.click('.tab[data-go="curves"]');
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/curves.png` });

await page.click('.tab[data-go="profiles"]');
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/profiles.png` });

await page.click('.tab[data-go="mood"]');
await page.waitForTimeout(400);
await page.click('#mdToggle');
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/mood.png` });

await page.click('.tab[data-go="peak"]');
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/peak.png` });

/* a real session with a curve, mid-flight */
await page.click('.tab[data-go="heat"]');
await page.waitForTimeout(300);
await page.click('#hxStart');
await page.waitForTimeout(30000);
await page.screenshot({ path: `${OUT}/session.png` });

const report = await page.evaluate(() => ({
  overflow: [...document.querySelectorAll('.scr')].filter(s => s.classList.contains('on'))
    .map(s => s.scrollHeight - s.clientHeight),
  state: window.__puffco(),
}));

console.log(JSON.stringify(report, null, 1));
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
