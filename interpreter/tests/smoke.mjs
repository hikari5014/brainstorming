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

  // 「等翻譯完整才播」：按住暫存 → 放開後仍暫存（等待完整）→ 完成後才解除
  const boxMe = await page.locator('#hold-me').boundingBox();
  await page.mouse.move(boxMe.x + boxMe.width / 2, boxMe.y + boxMe.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(300);
  check('按住時譯文語音暫存中', await page.evaluate(() => window.__kouyiji.audio.voiceHeld === true));
  await page.mouse.up();
  check('放開瞬間語音仍暫存（等翻譯完整）', await page.evaluate(() => window.__kouyiji.audio.voiceHeld === true));
  await page.waitForFunction(() => window.__kouyiji.audio.voiceHeld === false, null, { timeout: 8000 });
  check('翻譯完整後語音解除暫存開播', true);

  // 我方按住說話 → 上半區出現譯文（大字）與原文參考
  await hold('#hold-me', 1500);
  check('放開後出現翻譯中跳動點', await page.locator('#pending-dots').isVisible());
  await page.waitForFunction(() => document.querySelector('#theirs-dst').textContent.length > 0, null, { timeout: 15000 });
  check('對方側出現譯文', true);
  await page.waitForFunction(() => document.querySelector('#theirs-src').textContent.length > 0, null, { timeout: 5000 });
  check('對方側出現原文參考', true);
  await page.waitForFunction(
    () => document.querySelector('#pending-dots').classList.contains('hidden'),
    null, { timeout: 8000 }
  );
  check('翻譯完整開播後跳動點隱藏', true);

  // 每輪播畢確實斷線（v11 預設：省額度、連線永遠新鮮）
  await page.waitForFunction(() => {
    const s = window.__kouyiji.state.sessions.toForeign;
    return !s || s.state === 'closed';
  }, null, { timeout: 10000 });
  check('語音播畢自動斷線（預設）', true);
  const seqBefore = await page.evaluate(() => window.__kouyiji.state.sessionSeq);

  // 對方按住 → 下半區出現中文譯文；純文字模式（預設）不播中文語音
  await hold('#hold-them', 1500);
  await page.waitForFunction(() => document.querySelector('#mine-dst').textContent.length > 0, null, { timeout: 15000 });
  check('我方側出現中文譯文', true);
  await page.waitForTimeout(1200); // mock 的 beep 已送達（已被純文字模式丟棄）
  const themVoice = await page.evaluate(() => ({
    pending: window.__kouyiji.audio.pendingPcm.length,
    speaking: window.__kouyiji.audio.isSpeaking,
  }));
  check('對方方向純文字：不播中文語音', themVoice.pending === 0 && themVoice.speaking === false, JSON.stringify(themVoice));
  await page.waitForFunction(() => {
    const s = window.__kouyiji.state.sessions.toMine;
    return !s || s.state === 'closed';
  }, null, { timeout: 8000 });
  check('字幕跑完即斷線（對方方向）', true);
  // 下次按住自動重連（開頭進緩衝不漏字）
  await hold('#hold-me', 700);
  const seqAfter = await page.evaluate(() => window.__kouyiji.state.sessionSeq);
  check('按下說話鈕自動重連', seqAfter > seqBefore, `seq ${seqBefore}→${seqAfter}`);
  await page.waitForFunction(() => window.__kouyiji.audio.voiceHeld === false, null, { timeout: 8000 });

  // 快速點擊競態：不卡在錄音
  await hold('#hold-me', 20);
  await page.waitForTimeout(400);
  const race = await page.evaluate(() => ({
    holding: window.__kouyiji.state.holding,
    // v5 教訓：通話期間 mic track 保持開啟（iOS 路由穩定），收不收音由狀態機決定
    micStable: window.__kouyiji.audio.stream?.getAudioTracks().every((t) => t.enabled) ?? false,
  }));
  check('快速點擊不卡在錄音狀態', race.holding === null, JSON.stringify(race));
  check('通話期間 mic track 不切換（保持開啟）', race.micStable === true);

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

  /* ---- 語音完整偵測參數可調 ---- */
  await page.click('#gear');
  check('偵測參數滑桿存在', await page.locator('#set-voice-idle').isVisible());
  await page.evaluate(() => {
    for (const [id, v] of [['set-voice-idle', '0.8'], ['set-tail', '2']]) {
      const el = document.getElementById(id);
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  check('滑桿數值標籤即時更新', (await page.locator('#lbl-voice-idle').textContent()) === '0.8');
  await page.click('#settings-save');
  const params = await page.evaluate(() => ({
    idle: window.__kouyiji.settings.voiceIdleSec,
    tail: window.__kouyiji.settings.silenceTailSec,
  }));
  check('偵測參數已儲存生效', params.idle === 0.8 && params.tail === 2, JSON.stringify(params));

  /* ---- 淺色主題 ---- */
  await page.click('#gear');
  await page.selectOption('#set-theme', 'light');
  await page.click('#settings-save');
  const theme = await page.evaluate(() => ({
    attr: document.documentElement.dataset.theme,
    bg: getComputedStyle(document.body).backgroundColor,
  }));
  check('切換淺色主題', theme.attr === 'light' && theme.bg !== 'rgb(14, 17, 22)', JSON.stringify(theme));
  await page.click('#gear');
  await page.selectOption('#set-theme', 'dark');
  await page.click('#settings-save');
  check('切回深色主題', await page.evaluate(() => document.documentElement.dataset.theme === 'dark'));

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

  /* ---- 點擊收音模式 ---- */
  await page.click('[data-mode="call"]');
  await page.click('#gear');
  await page.selectOption('#set-talk-mode', 'toggle');
  await page.click('#settings-save');
  await page.click('#start-btn');
  await page.waitForSelector('#view-call:not(.hidden)');
  check('點擊模式按鈕文字', (await page.locator('#hold-me-label').textContent()) === '點擊說話');
  await page.click('#hold-me');
  await page.waitForTimeout(600);
  const tOn = await page.evaluate(() => window.__kouyiji.state.holding);
  check('點一下開始收音（放開不中斷）', tOn === 'me', String(tOn));
  check('收音中顯示再點結束', (await page.locator('#hold-me-label').textContent()).includes('再點一下結束'));
  await page.click('#hold-me');
  const tOff = await page.evaluate(() => window.__kouyiji.state.holding);
  check('再點一下結束收音', tOff === null, String(tOff));
  await page.click('#hold-them');
  await page.waitForTimeout(400);
  await page.click('#hold-me'); // 換邊：自動結束對方、開始我方
  const swapped = await page.evaluate(() => window.__kouyiji.state.holding);
  check('點另一側自動換邊', swapped === 'me', String(swapped));
  await page.click('#hold-me');
  await page.click('#end-call');
  await page.waitForTimeout(800);
  if (await page.locator('#transcript').evaluate((d) => d.open)) await page.click('#tr-close');

  /* ---- v9：音訊閘門（語音資料還在到達就不開播）＋缺口偵測 ---- */
  await page.click('#start-btn');
  await page.waitForSelector('#view-call:not(.hidden)');
  await page.evaluate(() => window.__kouyiji.hooks.beginAwaitVoice('toForeign'));
  const stillWaiting = await page.evaluate(async () => {
    const k = window.__kouyiji;
    const t0 = Date.now();
    // 模擬語音資料持續從網路到達 2.4 秒（文字早已停止）→ 不可開播
    while (Date.now() - t0 < 2400) {
      if (k.state.awaitVoice) k.state.awaitVoice.lastAudioAt = Date.now();
      await new Promise((r) => setTimeout(r, 100));
    }
    return Boolean(k.state.awaitVoice);
  });
  check('語音仍在到達時不開播（音訊閘門）', stillWaiting === true);
  await page.waitForFunction(() => !window.__kouyiji.state.awaitVoice, null, { timeout: 6000 });
  check('語音停止到達後才開播', true);

  const gapEv = await page.evaluate(() => new Promise((resolve) => {
    const a = window.__kouyiji.audio;
    a.stopPlayback();
    a.scheduleInt16(new Int16Array(2400), 101); // 0.1 秒
    setTimeout(() => {
      const prev = a.onVoiceEvent;
      a.onVoiceEvent = (ev) => { a.onVoiceEvent = prev; resolve(ev); };
      a.scheduleInt16(new Int16Array(2400), 102); // 上一條已播完 → 中間是缺口
    }, 500);
  }));
  check('播放缺口自動偵測', gapEv.type === 'play' && gapEv.gapMs > 200, JSON.stringify(gapEv));
  await page.click('#end-call');
  await page.waitForTimeout(600);
  if (await page.locator('#transcript').evaluate((d) => d.open)) await page.click('#tr-close');

  /* ---- v9：語音記錄視覺化 ---- */
  const vturn = await page.evaluate(() => {
    const t = window.__kouyiji.vlog.turns.find((x) => x.chunks.some((c) => c.playMs != null));
    if (!t) return null;
    return {
      chunks: t.chunks.length,
      played: t.chunks.filter((c) => c.playMs != null).length,
      reason: t.marks.find((m) => m.type === 'voice-start')?.reason || null,
      released: t.marks.some((m) => m.type === 'release'),
    };
  });
  check('語音記錄逐條入帳（到達＋播放＋開播原因）',
    Boolean(vturn && vturn.chunks > 0 && vturn.played > 0 && vturn.reason && vturn.released),
    JSON.stringify(vturn));
  await page.click('#gear');
  await page.click('#open-voicelog');
  await page.waitForSelector('#voicelog[open]');
  const vui = await page.evaluate(() => ({
    turns: document.querySelectorAll('.vlog-turn').length,
    blocks: document.querySelectorAll('.vlog-blk').length,
    diags: document.querySelectorAll('.vlog-diag').length,
    rows: document.querySelectorAll('.vlog-table tbody tr').length,
  }));
  check('語音記錄視覺化（時間軸＋診斷＋明細）',
    vui.turns > 0 && vui.blocks > 0 && vui.diags > 0 && vui.rows > 0, JSON.stringify(vui));
  await page.click('#vlog-close');
  await page.click('#settings-close');

  /* ---- v10：語音接收指示器＋手動開播 ---- */
  await page.click('#gear');
  check('指示器/手動開播設定存在',
    (await page.locator('#set-voice-ind').isVisible()) && (await page.locator('#set-manual-play').isVisible()));
  await page.selectOption('#set-talk-mode', 'hold');
  await page.check('#set-manual-play');
  await page.click('#settings-save');
  await page.click('#start-btn');
  await page.waitForSelector('#view-call:not(.hidden)');
  check('手動模式：中央區固定加高（不跳版面）', await page.evaluate(() => document.body.dataset.manual === 'on'));
  await hold('#hold-me', 1500);
  await page.waitForSelector('#manual-play:not(.hidden)', { timeout: 3000 });
  check('放開後出現「▶ 播放」鈕', true);
  await page.waitForFunction(() => {
    const el = document.querySelector('#voice-ind');
    return el && !el.classList.contains('hidden');
  }, null, { timeout: 3000 });
  check('語音接收指示器即時顯示', true);
  await page.waitForTimeout(3500); // mock 的 turn-complete 早已送達
  check('手動模式完全不自動開播', await page.evaluate(() => window.__kouyiji.audio.voiceHeld === true));
  const indText = await page.locator('#voice-ind').textContent();
  check('指示器顯示接收統計（條數/秒數）', /條/.test(indText), indText);
  await page.click('#manual-play');
  check('按下播放才開播', await page.evaluate(() => window.__kouyiji.audio.voiceHeld === false));
  check('手動開播原因入帳', await page.evaluate(() =>
    window.__kouyiji.vlog.turns.some((t) => t.marks.some((m) => m.type === 'voice-start' && m.reason === 'manual'))));
  check('播放鈕已收起', await page.evaluate(() => document.querySelector('#manual-play').classList.contains('hidden')));
  await page.click('#end-call');
  await page.waitForTimeout(800);
  if (await page.locator('#transcript').evaluate((d) => d.open)) await page.click('#tr-close');

  // 兩個開關都關掉 → 指示器隱藏、恢復自動開播
  await page.click('#gear');
  await page.uncheck('#set-manual-play');
  await page.uncheck('#set-voice-ind');
  await page.click('#settings-save');
  await page.click('#start-btn');
  await page.waitForSelector('#view-call:not(.hidden)');
  await hold('#hold-me', 1200);
  await page.waitForTimeout(600);
  check('指示器可關閉', await page.evaluate(() => document.querySelector('#voice-ind').classList.contains('hidden')));
  check('關閉手動後無播放鈕', await page.evaluate(() => document.querySelector('#manual-play').classList.contains('hidden')));
  await page.waitForFunction(() => window.__kouyiji.audio.voiceHeld === false, null, { timeout: 8000 });
  check('關閉手動後恢復自動開播', true);
  await page.click('#end-call');
  await page.waitForTimeout(800);
  if (await page.locator('#transcript').evaluate((d) => d.open)) await page.click('#tr-close');

  /* ---- v11：雙 key／純文字／自動斷線設定 ---- */
  await page.click('#gear');
  check('雙 key／純文字／自動斷線設定存在',
    (await page.locator('#set-key2').isVisible())
    && (await page.locator('#set-them-text').isVisible())
    && (await page.locator('#set-auto-disc').isVisible()));
  await page.fill('#set-key2', 'AIzaTest2');
  await page.uncheck('#set-them-text'); // 關閉純文字 → 對方方向恢復語音
  await page.click('#settings-save');
  const k2 = await page.evaluate(() => JSON.parse(localStorage.getItem('kouyiji.settings.v1')).apiKeyThem);
  check('第二把 key 已儲存', k2 === 'AIzaTest2', String(k2));
  await page.click('#start-btn');
  await page.waitForSelector('#view-call:not(.hidden)');
  await hold('#hold-them', 1200);
  check('關閉純文字後對方方向恢復語音等待', await page.evaluate(() => window.__kouyiji.audio.voiceHeld === true));
  await page.waitForFunction(() => window.__kouyiji.audio.voiceHeld === false, null, { timeout: 8000 });
  check('對方語音完整後開播', true);
  await page.click('#end-call');
  await page.waitForTimeout(800);
  if (await page.locator('#transcript').evaluate((d) => d.open)) await page.click('#tr-close');
  await page.click('#gear');
  await page.check('#set-them-text'); // 恢復預設
  await page.click('#settings-save');

  /* ---- v12：外語語音重播鍵 ---- */
  await page.click('#start-btn');
  await page.waitForSelector('#view-call:not(.hidden)');
  check('尚無語音時重播鍵隱藏', await page.evaluate(() => document.querySelector('#replay-them').classList.contains('hidden')));
  await hold('#hold-me', 1500);
  await page.waitForFunction(() => window.__kouyiji.audio.voiceHeld === false, null, { timeout: 8000 });
  await page.waitForSelector('#replay-them:not(.hidden)', { timeout: 5000 });
  check('語音播出後出現重播鍵', true);
  check('重播鍵標籤為讀者語言', (await page.locator('#replay-them').getAttribute('aria-label')) === 'Replay');
  const rbox = await page.locator('#replay-them').boundingBox();
  check('重播鍵為圓形小圖示（不佔版面）', rbox.width <= 48 && Math.abs(rbox.width - rbox.height) < 2, JSON.stringify(rbox));
  await page.waitForFunction(() => !window.__kouyiji.audio.isSpeaking, null, { timeout: 6000 });
  await page.click('#replay-them');
  check('點擊重播立即播放（本機緩衝，不耗額度）', await page.evaluate(() => window.__kouyiji.audio.isSpeaking));
  await page.waitForFunction(() => !window.__kouyiji.audio.isSpeaking, null, { timeout: 6000 });
  await hold('#hold-them', 1200);
  await page.waitForTimeout(2500);
  check('對方回合後重播鍵仍可用', await page.evaluate(() => !document.querySelector('#replay-them').classList.contains('hidden')));
  // v13：重播自動去除空白音段（前置 2 秒靜音應被裁掉，只剩 0.5 秒語音＋少量前導）
  const trimDur = await page.evaluate(() => {
    const k = window.__kouyiji;
    const silent = new Int16Array(48000); // 2s 靜音
    const tone = new Int16Array(12000); // 0.5s 音
    for (let i = 0; i < tone.length; i++) tone[i] = Math.round(Math.sin(i / 8) * 8000);
    k.state.replay = { chunks: [silent, tone], secs: 2.5 };
    document.querySelector('#replay-them').click();
    return (k.audio.speakUntil - performance.now()) / 1000;
  });
  check('重播自動去除空白音段', trimDur > 0.3 && trimDur < 1.2, `${trimDur.toFixed(2)}s`);
  await page.waitForFunction(() => !window.__kouyiji.audio.isSpeaking, null, { timeout: 5000 });
  await hold('#hold-me', 300);
  check('我方新一句開始即清除舊語音', await page.evaluate(() => window.__kouyiji.state.replay.secs === 0));
  await page.click('#end-call');
  await page.waitForTimeout(800);
  if (await page.locator('#transcript').evaluate((d) => d.open)) await page.click('#tr-close');

  /* ---- v14：常用句庫 ---- */
  check('首頁常用句入口', await page.locator('#home-phrases').isVisible());
  await page.click('#home-phrases');
  await page.waitForSelector('#phrasebook[open]');
  check('句庫空狀態提示', (await page.locator('#pb-list').textContent()).includes('還沒有收藏'));
  await page.click('#pb-close');

  await page.click('#start-btn');
  await page.waitForSelector('#view-call:not(.hidden)');
  await hold('#hold-me', 1500);
  await page.waitForFunction(() => window.__kouyiji.audio.voiceHeld === false, null, { timeout: 8000 });
  await page.waitForFunction(() => !window.__kouyiji.audio.isSpeaking, null, { timeout: 6000 });
  await page.click('#save-phrase');
  await page.waitForTimeout(500);
  const savedPhrase = await page.evaluate(async () => {
    const all = await window.__kouyiji.store.allPhrases();
    const p = all[all.length - 1];
    return p ? { n: all.length, lang: p.lang, hasPcm: Boolean(p.pcm), secs: p.secs, hasDst: p.dst.length > 0 } : null;
  });
  check('☆ 收藏上一句（中文＋外語＋語音）',
    Boolean(savedPhrase && savedPhrase.hasPcm && savedPhrase.secs > 0 && savedPhrase.lang === 'en' && savedPhrase.hasDst),
    JSON.stringify(savedPhrase));

  await page.click('#open-phrases');
  await page.waitForSelector('#phrasebook[open]');
  check('句庫列出收藏（含播放鈕）', (await page.locator('.pb-row .pb-play:not([disabled])').count()) >= 1);
  await page.click('.pb-row .pb-play');
  check('點擊立即播放（本機語音、零額度）', await page.evaluate(() => window.__kouyiji.audio.isSpeaking));
  const pbDst = await page.evaluate(() => document.querySelector('#theirs-dst').textContent);
  check('播放同時推上對方側大字', pbDst.length > 0, pbDst.slice(0, 40));
  await page.click('.pb-row .pb-pin');
  await page.waitForTimeout(300);
  check('置頂生效', await page.evaluate(() => document.querySelector('.pb-row').classList.contains('pinned')));
  await page.click('.pb-row .pb-del'); // confirm 由 dialog handler 自動接受
  await page.waitForTimeout(300);
  check('刪除生效', (await page.locator('.pb-row').count()) === 0);
  await page.click('#pb-close');
  await page.click('#end-call');
  await page.waitForTimeout(800);
  if (await page.locator('#transcript').evaluate((d) => d.open)) await page.click('#tr-close');

  /* ---- v15：逐字稿 → 常用句轉存 ---- */
  await page.click('#start-btn');
  await page.waitForSelector('#view-call:not(.hidden)');
  await hold('#hold-me', 1500);
  await page.waitForFunction(() => window.__kouyiji.audio.voiceHeld === false, null, { timeout: 8000 });
  await page.click('#end-call');
  await page.waitForSelector('#transcript[open]', { timeout: 5000 });
  check('逐字稿每句有收藏鈕', (await page.locator('.tr-star').count()) >= 1);
  const pbBefore = await page.evaluate(async () => (await window.__kouyiji.store.allPhrases()).length);
  await page.locator('.tr-star').first().click();
  await page.waitForTimeout(400);
  const pbAfter = await page.evaluate(async () => {
    const all = await window.__kouyiji.store.allPhrases();
    const p = all[all.length - 1];
    return { n: all.length, textOnly: p ? !p.pcm : null, hasLang: p ? Boolean(p.lang) : null };
  });
  check('逐字稿句子轉存成功（純文字＋語言歸類）',
    pbAfter.n === pbBefore + 1 && pbAfter.textOnly === true && pbAfter.hasLang === true, JSON.stringify(pbAfter));
  check('轉存後星號變實心', (await page.locator('.tr-star').first().textContent()) === '★');
  await page.locator('.tr-star').first().click(); // 再點一次 → 重複偵測
  await page.waitForTimeout(400);
  const pbDup = await page.evaluate(async () => (await window.__kouyiji.store.allPhrases()).length);
  check('重複轉存防護', pbDup === pbAfter.n, `count ${pbDup}`);
  await page.click('#tr-close');

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
