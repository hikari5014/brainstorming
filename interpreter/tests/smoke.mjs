// v4 冒煙測試：通話隱喻 + 面對面分區 + 聆聽模式 + 逐字稿。
// 執行：node tests/smoke.mjs（需 playwright-core；CHROME_PATH 可指定瀏覽器）

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

const server = await new Promise((resolve) => {
  const s = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
      res.end(await readFile(join(ROOT, p)));
    } catch { res.writeHead(404).end(); }
  });
  s.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}/`;
console.log(`serving at ${base}`);

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
page.on('dialog', (d) => d.accept()); // confirm() 清除逐字稿

async function hold(selector, ms) {
  const box = await page.locator(selector).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

try {
  await page.addInitScript(() => {
    localStorage.setItem('kouyiji.settings.v1', JSON.stringify({ demoMode: true }));
    indexedDB.deleteDatabase('kouyiji');
  });
  await page.goto(base, { waitUntil: 'networkidle' });
  check('頁面載入', (await page.title()) === '口譯機', await page.title());
  check('版本徽章顯示', /^v\d+/.test(await page.locator('#ver').textContent()), await page.locator('#ver').textContent());
  check('首頁＝通話隱喻（開始鈕）', await page.locator('#start-btn').isVisible());
  check('麥克風尚未開啟（按開始才開）', await page.evaluate(() => !window.__kouyiji.audio.ready));

  /* ---- 面對面對話 ---- */
  await page.click('#start-btn');
  await page.waitForSelector('#view-call:not(.hidden)');
  check('開始對話 → 進入面對面畫面', true);
  check('麥克風已開啟（單一 context）', await page.evaluate(() => {
    const a = window.__kouyiji.audio;
    return a.ready && a.ctx.state === 'running';
  }));
  const rotated = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.side.theirs')).transform !== 'none');
  check('上半區 180° 旋轉', rotated);
  check('對方側語言標籤', (await page.locator('#theirs-lang').textContent()) === 'English');
  check('對方側按鈕使用讀者語言', (await page.locator('#hold-them-label').textContent()).includes('Hold'));

  // 我方按住說話 → 上半區出現譯文（大字）與原文參考
  await hold('#hold-me', 1500);
  check('放開後出現翻譯中跳動點', await page.locator('#pending-dots').isVisible());
  await page.waitForFunction(() => document.querySelector('#theirs-dst').textContent.length > 0, null, { timeout: 15000 });
  check('對方側出現譯文', true);
  await page.waitForFunction(() => document.querySelector('#theirs-src').textContent.length > 0, null, { timeout: 5000 });
  check('對方側出現原文參考', true);
  check('譯文到達後跳動點隱藏', !(await page.locator('#pending-dots').isVisible()));

  // 對方按住 → 下半區出現中文譯文
  await hold('#hold-them', 1500);
  await page.waitForFunction(() => document.querySelector('#mine-dst').textContent.length > 0, null, { timeout: 15000 });
  check('我方側出現中文譯文', true);

  // 快速點擊競態：不卡在錄音
  await hold('#hold-me', 20);
  await page.waitForTimeout(400);
  const race = await page.evaluate(() => ({
    holding: window.__kouyiji.state.holding,
    mic: window.__kouyiji.audio.stream?.getAudioTracks().some((t) => t.enabled) ?? false,
  }));
  check('快速點擊不卡在錄音狀態', race.holding === null && race.mic === false, JSON.stringify(race));

  // 結束通話 → 逐字稿檢視自動開啟、麥克風關閉
  await page.click('#end-call');
  await page.waitForSelector('#transcript[open]', { timeout: 5000 });
  check('結束通話 → 進入逐字稿檢視', true);
  await page.waitForFunction(() => document.querySelectorAll('.tr-turn').length >= 2, null, { timeout: 5000 });
  check('逐字稿含雙向回合', true);
  check('複製/分享/匯出按鈕齊全',
    (await page.locator('#tr-copy').isVisible()) && (await page.locator('#tr-share').isVisible()) && (await page.locator('#tr-export').isVisible()));
  await page.click('#tr-close');
  check('結束後麥克風已關閉', await page.evaluate(() => !window.__kouyiji.audio.ready));
  check('回到首頁', await page.locator('#view-home').isVisible());

  /* ---- 聆聽模式 ---- */
  await page.click('[data-mode="listen"]');
  check('聆聽模式提示更新', (await page.locator('#start-label').textContent()) === '開始聆聽');
  await page.click('#start-btn');
  await page.waitForSelector('#view-listen:not(.hidden)');
  check('進入聆聽畫面（正向單區）', true);
  await page.waitForFunction(() => document.querySelector('#listen-feed .listen-turn .dst')?.textContent.length > 0, null, { timeout: 20000 });
  check('聆聽模式：連續字幕出現', true);
  await page.click('#listen-toggle');
  check('點按暫停聆聽', (await page.locator('#listen-state').textContent()) === '已暫停');
  await page.click('#listen-end');
  await page.waitForSelector('#transcript[open]', { timeout: 5000 });
  await page.click('#tr-close');
  check('聆聽結束 → 逐字稿', true);

  /* ---- 無障礙抽查 ---- */
  const a11y = await page.evaluate(() => {
    const missing = [...document.querySelectorAll('button.icon-btn')].filter((b) => !b.getAttribute('aria-label'));
    return missing.length;
  });
  check('icon 按鈕皆有 aria-label', a11y === 0, `${a11y} missing`);

  /* ---- PWA ---- */
  const manifest = await (await page.request.get(base + 'manifest.webmanifest')).json();
  check('manifest 含 3 個圖示', manifest.icons.length === 3);
  const sw = await page.evaluate(async () => Boolean(await navigator.serviceWorker.getRegistration()));
  check('service worker 註冊', sw);
  const swVer = await (await page.request.get(base + 'js/version.js')).text();
  const shown = await page.locator('#ver').textContent();
  check('版本徽章與快取版本一致', swVer.includes(`'${shown}'`), shown);

  // 首次導引
  const fresh = await browser.newContext({ permissions: ['microphone'] });
  const freshPage = await fresh.newPage();
  await freshPage.goto(base, { waitUntil: 'networkidle' });
  check('無設定時彈出首次導引', await freshPage.locator('#settings').isVisible());
  await fresh.close();

  check('無 JS 錯誤', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
