/* Open the app on the real device, in a real window, and leave it running.
 * The window stays open; this script only launches it.
 */
import { chromium } from 'playwright';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const root = path.join(os.homedir(), '.cache/ms-playwright');
let CHROME;
for (const d of fs.readdirSync(root).filter(x => x.startsWith('chromium-')).sort().reverse()) {
  for (const s of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
    const q = path.join(root, d, s);
    if (fs.existsSync(q)) { CHROME = q; break; }
  }
  if (CHROME) break;
}

const ctx = await chromium.launchPersistentContext(
  path.join(os.homedir(), '.cache/peak-app-profile'),
  {
    executablePath: CHROME,
    headless: false,
    viewport: { width: 420, height: 900 },
    args: ['--no-sandbox', '--window-size=460,980', '--window-position=120,60'],
  },
);

const page = ctx.pages()[0] || await ctx.newPage();
await page.goto('http://127.0.0.1:8791/app.html?bridge=1');
await page.waitForTimeout(800);

// Connect to the real Peak through the bridge.
await page.click('#cxGo');
await page.waitForTimeout(7000);

const st = await page.evaluate(() => (window.__puffco ? window.__puffco() : null));
console.log('connected:', st && st.connected, '| fw', st && st.firmware, '| state', st && st.state);

// Leave the window open. Playwright keeps the browser alive while this process runs.
await new Promise(() => {});
