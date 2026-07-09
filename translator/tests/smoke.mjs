// 冒煙測試：Demo 模式（假引擎 + 假麥克風）跑完整 UI 管線。
// 執行：node tests/smoke.mjs   （需要 playwright-core 與 Chromium，
//        可用環境變數 CHROME_PATH 指定瀏覽器執行檔）
// 驗證：載入無 JS 錯誤、首次設定導引、Demo 對話字幕流、模式切換、
//       manifest / service worker 檔案可取得。

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.json': 'application/json',
};

function serve() {
  const server = createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (path.endsWith('/')) path += 'index.html';
      const data = await readFile(join(ROOT, path));
      res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
}

const server = await serve();
const base = `http://127.0.0.1:${server.address().port}/`;
console.log(`serving ${ROOT} at ${base}`);

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: [
    '--no-sandbox',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const context = await browser.newContext({ permissions: ['microphone'] });
const page = await context.newPage();

const pageErrors = [];
page.on('pageerror', (err) => pageErrors.push(String(err)));
page.on('console', (msg) => {
  if (msg.type() === 'error') pageErrors.push(msg.text());
});

try {
  // 預先設定：Demo 模式、關 VAD（假麥克風訊號能量不穩定）、關自動待機
  await page.addInitScript(() => {
    localStorage.setItem(
      'liveTranslator.settings.v1',
      JSON.stringify({ demoMode: true, vadEnabled: false, idleDisconnectMin: 0 })
    );
  });

  await page.goto(base, { waitUntil: 'networkidle' });
  check('頁面載入', (await page.title()) === '隨身口譯', await page.title());

  // Demo 模式已設定 → 首次導引不應出現
  check('已設定時不彈首次導引', !(await page.locator('#settings-dialog').isVisible()));

  // 對話模式（預設）：按開始 → mock 引擎連線 → 字幕流出現
  await page.click('#main-btn');
  await page.waitForFunction(
    () => document.querySelector('#status-text').textContent.includes('翻譯中'),
    null, { timeout: 8000 }
  );
  check('Demo 引擎連線（狀態=翻譯中）', true);

  await page.waitForFunction(
    () => document.querySelector('#panel-theirs .live-dst, #panel-theirs .sub-history .sub-row')
      && (document.querySelector('#panel-theirs .live-dst').textContent.length > 0
        || document.querySelectorAll('#panel-theirs .sub-history .sub-row').length > 0),
    null, { timeout: 15000 }
  );
  check('對話模式：譯文出現在對方面板', true);

  await page.waitForFunction(
    () => document.querySelector('#panel-mine .live-src').textContent.length > 0
      || document.querySelectorAll('#panel-mine .sub-history .sub-row').length > 0,
    null, { timeout: 15000 }
  );
  check('對話模式：原文出現在我的面板', true);

  // 停止 → 切聆聽模式 → 再開始
  await page.click('#main-btn');
  await page.click('[data-mode="listen"]');
  check('聆聽模式視圖切換', await page.locator('#view-stream').isVisible());
  await page.click('#main-btn');
  await page.waitForFunction(
    () => document.querySelector('#panel-stream .live-dst').textContent.length > 0
      || document.querySelectorAll('#panel-stream .sub-history .sub-row').length > 0,
    null, { timeout: 15000 }
  );
  check('聆聽模式：字幕流出現', true);
  await page.click('#main-btn');

  // 手動換向按鈕存在於對話模式
  await page.click('[data-mode="conversation"]');
  check('換向按鈕可見（手動模式）', await page.locator('#swap-btn').isVisible());
  await page.click('#swap-btn');
  const dir = await page.locator('#direction-label').textContent();
  check('換向後方向標籤更新', dir.includes('→'), dir);

  // 設定面板開關
  await page.click('#settings-btn');
  check('設定面板開啟', await page.locator('#settings-dialog').isVisible());
  await page.click('#settings-close');

  // 用量儀表有累計（demo 也計）
  const usageText = await page.locator('#usage-chip').textContent();
  check('用量儀表顯示', /今日/.test(usageText), usageText);

  // 逐字稿面板 + 匯出按鈕（載入是非同步的，等資料出現）
  await page.click('#transcript-btn');
  await page.waitForSelector('#transcript-dialog[open]');
  await page.waitForFunction(
    () => document.querySelectorAll('#transcript-list .tr-row').length > 0,
    null, { timeout: 5000 }
  ).catch(() => {});
  const trRows = await page.locator('#transcript-list .tr-row').count();
  check('逐字稿已入庫', trRows > 0, `${trRows} rows`);
  await page.click('#transcript-close');

  // PWA 資產
  const manifestResp = await page.request.get(base + 'manifest.webmanifest');
  const manifest = await manifestResp.json();
  check('manifest 可取得且含圖示', manifestResp.ok() && manifest.icons.length === 3);
  const swResp = await page.request.get(base + 'sw.js');
  check('sw.js 可取得', swResp.ok());
  for (const icon of ['icons/icon.svg', 'icons/maskable.svg', 'icons/icon-192.png']) {
    const r = await page.request.get(base + icon);
    if (!r.ok()) check(`圖示 ${icon}`, false);
  }
  check('圖示檔齊全', true);

  const swState = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 'unsupported';
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? 'registered' : 'none';
  });
  check('service worker 註冊', swState === 'registered', swState);

  // 首次導引：用乾淨的 context（沒有 initScript 預設值）
  const freshContext = await browser.newContext({ permissions: ['microphone'] });
  const freshPage = await freshContext.newPage();
  await freshPage.goto(base, { waitUntil: 'networkidle' });
  check('無設定時彈出首次導引', await freshPage.locator('#settings-dialog').isVisible());
  check('導引含 Demo 試玩按鈕', await freshPage.locator('#set-demo-start').isVisible());
  await freshContext.close();

  check('無 JS 錯誤', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
