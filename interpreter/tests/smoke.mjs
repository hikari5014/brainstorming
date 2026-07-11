// 冒煙測試：Demo 引擎 + 假麥克風，完整跑對講機回合狀態機。
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
  });
  await page.goto(base, { waitUntil: 'networkidle' });
  check('頁面載入', (await page.title()) === '口譯機', await page.title());
  check('使用說明顯示', await page.locator('#feed-hint').isVisible());

  // 版本徽章：顯示且與 version.js / sw 快取版本一致
  const verInfo = await page.evaluate(() => ({
    shown: document.querySelector('#ver').textContent,
    actual: self.APP_VERSION,
  }));
  check('版本徽章顯示且一致', verInfo.shown === verInfo.actual && /^v\d+/.test(verInfo.shown), verInfo.shown);
  const swVer = await (await page.request.get(base + 'js/version.js')).text();
  check('sw 與頁面共用同一版本來源', swVer.includes(`'${verInfo.shown}'`));

  // 卡死競態防護：快速點一下（await audio.start() 期間就放開）不能卡在錄音狀態
  await hold('#btn-me', 20);
  await page.waitForTimeout(600);
  const race = await page.evaluate(() => ({
    holding: window.__kouyiji.state.holding,
    micEnabled: window.__kouyiji.audio.stream?.getAudioTracks().some((t) => t.enabled) ?? false,
  }));
  check('快速點擊不卡在錄音狀態', race.holding === null, JSON.stringify(race));
  check('未按住時 mic track 為靜音', race.micEnabled === false);

  // 回合 1：我說中文（按住 → 放開），按住期間要顯示錄音中提示
  const holdBox = await page.locator('#btn-me').boundingBox();
  await page.mouse.move(holdBox.x + holdBox.width / 2, holdBox.y + holdBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(400);
  check('按住時顯示錄音中提示', (await page.locator('.turn-state.recording').count()) > 0);
  const micWhileHolding = await page.evaluate(() =>
    window.__kouyiji.audio.stream.getAudioTracks().every((t) => t.enabled));
  check('按住時 mic track 開啟', micWhileHolding);
  await page.waitForTimeout(1100);
  await page.mouse.up();
  await page.waitForFunction(
    () => document.querySelector('.bubble.me .dst')?.textContent.length > 0,
    null, { timeout: 15000 }
  );
  check('我方回合：譯文氣泡出現', true);
  const staleStates = await page.evaluate(() =>
    document.querySelectorAll('.bubble.me .turn-state').length);
  check('譯文出現後狀態提示移除', staleStates === 0, `${staleStates} left`);

  // 單一 AudioContext 不變式（iOS 凍結問題的根治）
  const audioState = await page.evaluate(() => {
    const a = window.__kouyiji.audio;
    return { ready: a.ready, ctxState: a.ctx?.state, holding: window.__kouyiji.state.holding };
  });
  check('音訊引擎就緒（單一 context）', audioState.ready && audioState.ctxState === 'running', audioState.ctxState);
  check('放開後回到未持按狀態', audioState.holding === null);

  // 回合 2：對方說外語
  await hold('#btn-them', 1500);
  await page.waitForFunction(
    () => document.querySelector('.bubble.them .dst')?.textContent.length > 0,
    null, { timeout: 15000 }
  );
  check('對方回合：譯文氣泡出現', true);

  // 沒按住時 chunk 一律丟棄（狀態機核心）：等 2 秒不該長出新氣泡
  const bubblesBefore = await page.locator('.bubble').count();
  await page.waitForTimeout(2500);
  const bubblesAfter = await page.locator('.bubble').count();
  check('未按住時不產生新翻譯（丟棄輸入）', bubblesAfter === bubblesBefore, `${bubblesBefore}→${bubblesAfter}`);

  // 語言切換反映在按鈕上
  await page.selectOption('#foreign-lang', 'ja');
  const label = await page.locator('#btn-them .talk-label').textContent();
  check('切換外語更新按鈕', label.includes('日本語'), label);

  // 設定與診斷入口
  await page.click('#gear');
  check('設定開啟', await page.locator('#settings').isVisible());
  check('診斷按鈕存在', await page.locator('#run-diag').isVisible());
  await page.click('#settings-close');

  // PWA 資產
  const manifest = await (await page.request.get(base + 'manifest.webmanifest')).json();
  check('manifest 含 3 個圖示', manifest.icons.length === 3);
  for (const f of ['sw.js', 'icons/icon.svg', 'icons/maskable.svg', 'icons/icon-192.png']) {
    if (!(await page.request.get(base + f)).ok()) check(`資產 ${f}`, false);
  }
  check('PWA 資產齊全', true);
  const sw = await page.evaluate(async () => Boolean(await navigator.serviceWorker.getRegistration()));
  check('service worker 註冊', sw);

  // 首次導引（乾淨 context）
  const fresh = await browser.newContext({ permissions: ['microphone'] });
  const freshPage = await fresh.newPage();
  await freshPage.goto(base, { waitUntil: 'networkidle' });
  check('無設定時彈出首次導引', await freshPage.locator('#settings').isVisible());
  check('導引含 Demo 按鈕', await freshPage.locator('#demo-start').isVisible());
  await fresh.close();

  check('無 JS 錯誤', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
