import { loadSettings, saveSettings, resolveLayout, ENGINES } from './settings.js';
import { fillLanguageSelect, langName } from './languages.js';
import { Pipeline } from './pipeline.js';
import { MODES, routeSegment } from './modes.js';
import { Segmenter, SubtitlePanel } from './ui/subtitles.js';
import { UsageMeter, formatMin } from './ui/usage.js';
import { TranscriptStore, downloadText } from './ui/transcript.js';
import { VideoSource } from './video.js';
import { runDiagnostics, formatDiagnostics } from './diagnostics.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  modeId: 'conversation',
  direction: 'out', // 手動對話：out = 我→對方
  running: false,
  voiceOn: true,
  flipped: false,
  startedAt: 0,
  installPrompt: null,
};

const usage = new UsageMeter();
const transcript = new TranscriptStore();
let settings = loadSettings();
const pipeline = new Pipeline({ settings, usage });

const panels = {
  mine: new SubtitlePanel($('#panel-mine')),
  theirs: new SubtitlePanel($('#panel-theirs')),
  stream: new SubtitlePanel($('#panel-stream')),
  video: new SubtitlePanel($('#panel-video')),
};

const videoSource = new VideoSource($('#video-el'));

const segmenter = new Segmenter({
  onLive(seg) {
    const dest = routeSegment(state.modeId, settings, state.direction, seg);
    if (dest) panels[dest].updateLive(seg);
  },
  onFinal(seg) {
    const dest = routeSegment(state.modeId, settings, state.direction, seg);
    if (dest) panels[dest].pushFinal(seg);
    transcript.add({
      ts: seg.ts, endTs: seg.endTs, mode: state.modeId,
      kind: seg.kind, lang: seg.lang, text: seg.text,
    });
  },
});

/* ---------- Toast ---------- */
let toastTimer = null;
function toast(msg, ms = 3500) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

/* ---------- 版面 ---------- */
function applyLayout() {
  const layout = resolveLayout(settings);
  document.body.classList.toggle('layout-immersive', layout === 'immersive');
  document.body.classList.toggle('layout-dashboard', layout === 'dashboard');
  document.documentElement.style.setProperty('--font-scale', settings.fontScale);
}

let chromeTimer = null;
function pokeChrome() {
  document.body.classList.remove('chrome-hidden');
  clearTimeout(chromeTimer);
  if (document.body.classList.contains('layout-immersive') && state.running) {
    chromeTimer = setTimeout(() => document.body.classList.add('chrome-hidden'), 3500);
  }
}
for (const evt of ['pointermove', 'pointerdown', 'keydown', 'touchstart']) {
  window.addEventListener(evt, pokeChrome, { passive: true });
}

/* ---------- 模式切換 ---------- */
function setMode(modeId) {
  if (state.running) stopPipeline();
  state.modeId = modeId;
  const mode = MODES[modeId];
  saveSettings({ lastMode: modeId });

  for (const btn of document.querySelectorAll('#mode-tabs .tab')) {
    btn.classList.toggle('active', btn.dataset.mode === modeId);
  }
  $('#view-conversation').classList.toggle('hidden', mode.view !== 'conversation');
  $('#view-stream').classList.toggle('hidden', mode.view !== 'stream');
  $('#view-video').classList.toggle('hidden', mode.view !== 'video');
  if (mode.view === 'stream') $('#stream-hint').textContent = mode.hint;
  if (mode.view === 'video') $('#video-hint').textContent = mode.hint;
  $('#flip-btn').classList.toggle('hidden', !(mode.flippable || mode.view === 'conversation'));
  setFlipped(false);
  refreshModeChrome();

  state.voiceOn = mode.voiceDefault;
  updateVoiceBtn();
  updateDirectionLabel();
  updatePanelTags();
  document.body.dataset.mode = modeId;
}

function updatePanelTags() {
  $('#theirs-tag').textContent = `對方 · ${langName(settings.theirLang)}`;
  $('#mine-tag').textContent = `我 · ${langName(settings.myLang)}`;
}

function updateDirectionLabel() {
  const label = $('#direction-label');
  if (settings.conversationMode === 'auto') {
    label.textContent = `${langName(settings.myLang)} ⇄ ${langName(settings.theirLang)}（自動辨向）`;
  } else {
    label.textContent =
      state.direction === 'out'
        ? `${langName(settings.myLang)} → ${langName(settings.theirLang)}`
        : `${langName(settings.theirLang)} → ${langName(settings.myLang)}`;
  }
  $('#swap-btn').classList.toggle('hidden', settings.conversationMode === 'auto');
}

function setFlipped(on) {
  state.flipped = on;
  if (MODES[state.modeId].view === 'conversation') {
    $('#panel-theirs').classList.toggle('flipped', on);
  } else {
    $('#panel-stream').classList.toggle('flipped', on);
  }
}

/* ---------- 狀態列 ---------- */
const sessionStates = new Map();
function renderStatus() {
  const dot = $('#status-dot');
  const text = $('#status-text');
  if (!state.running) {
    dot.dataset.state = 'idle';
    text.textContent = settings.demoMode || !settings.apiKey ? 'Demo 模式 · 未開始' : '未開始';
    return;
  }
  const states = [...sessionStates.values()];
  let s = 'connecting';
  if (states.some((x) => x === 'error')) s = 'error';
  else if (states.some((x) => x === 'reconnecting')) s = 'reconnecting';
  else if (states.length && states.every((x) => x === 'open')) s = 'open';
  dot.dataset.state = s;
  const demo = settings.demoMode || !settings.apiKey ? 'Demo · ' : '';
  text.textContent =
    demo +
    ({ connecting: '連線中…', open: '翻譯中', reconnecting: '重新連線中…', error: '連線錯誤' }[s] || s);
}

setInterval(() => {
  const el = $('#session-timer');
  if (!state.running || !state.startedAt) {
    el.textContent = '';
    return;
  }
  const sec = Math.floor((Date.now() - state.startedAt) / 1000);
  el.textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}, 1000);

/* ---------- Pipeline 事件 ---------- */
pipeline.addEventListener('transcription', (e) => {
  const { tag, kind, text, languageCode } = e.detail;
  segmenter.feed({ tag, kind, text, languageCode });
  if (kind === 'input' && languageCode) {
    $('#detected-lang').textContent = `偵測：${langName(languageCode)}`;
  }
});
pipeline.addEventListener('status', (e) => {
  if (e.detail.tag === '*') sessionStates.clear();
  else sessionStates.set(e.detail.tag, e.detail.state);
  renderStatus();
});
pipeline.addEventListener('level', (e) => {
  $('#vad-dot').classList.toggle('voiced', e.detail.voiced);
});
pipeline.addEventListener('standby', (e) => {
  $('#standby-overlay').classList.toggle('hidden', !e.detail.on);
});
pipeline.addEventListener('turn-complete', () => segmenter.finalizeAll());
pipeline.addEventListener('fatal', (e) => {
  const reason = e.detail.reason || '';
  if (reason === 'SOURCE_ENDED') toast('音訊來源已停止分享，翻譯結束。');
  else if (/quota|exceeded|429/i.test(reason)) toast('額度已用盡（免費層每日限額）。可到設定切換省額度引擎或明天再試。', 10000);
  else if (/api key|401|403|PERMISSION/i.test(reason)) toast('API key 無效或無權限，請到設定檢查，或執行設定→連線診斷。', 10000);
  else toast(`連線失敗：${reason}｜可到設定→執行連線診斷找原因`, 10000);
  stopPipeline();
});

/* ---------- 模式相關的畫面狀態（會議 CTA、影片空狀態） ---------- */
function refreshModeChrome() {
  $('#meeting-cta').classList.toggle('hidden', !(state.modeId === 'meeting' && !state.running));
  $('#video-wrap').classList.toggle('has-media', videoSource.hasMedia);
}

/* ---------- 開始 / 停止 ---------- */
async function startPipeline() {
  const mode = MODES[state.modeId];
  if (!settings.apiKey?.trim() && !settings.demoMode) {
    openSettings(true);
    return;
  }
  let externalSource = null;
  if (mode.view === 'video') {
    if (!videoSource.hasMedia) {
      toast('先開啟影片檔或載入網址，再按開始。');
      return;
    }
    externalSource = await videoSource.ensureGraph();
  }
  try {
    state.running = true;
    state.startedAt = Date.now();
    sessionStates.clear();
    renderStatus();
    $('#main-btn').classList.add('running');
    $('#main-btn').textContent = '停止';
    refreshModeChrome();
    await pipeline.start({
      sourceType: mode.source,
      targets: mode.targets(settings, { direction: state.direction }),
      voiceOutput: state.voiceOn,
      audioProcessing: mode.audio,
      gateDuringPlayback: Boolean(mode.gate),
      duckEnabled: mode.view === 'video' ? $('#video-duck').checked : true,
      externalSource,
    });
    pokeChrome();
  } catch (err) {
    state.running = false;
    $('#main-btn').classList.remove('running');
    $('#main-btn').textContent = '開始';
    renderStatus();
    refreshModeChrome();
    if (err?.message === 'NO_TAB_AUDIO') {
      toast('沒有抓到音訊：選擇分享「分頁」並勾選「同時分享分頁音訊」。', 6000);
    } else if (err?.name === 'NotAllowedError') {
      toast(mode.source === 'display' ? '已取消畫面分享。' : '需要麥克風權限才能翻譯。', 5000);
    } else {
      toast(`無法啟動：${err?.message || err}`, 6000);
    }
  }
}

async function stopPipeline() {
  state.running = false;
  segmenter.finalizeAll();
  await pipeline.stop();
  $('#main-btn').classList.remove('running');
  $('#main-btn').textContent = '開始';
  $('#standby-overlay').classList.add('hidden');
  document.body.classList.remove('chrome-hidden');
  renderStatus();
  refreshModeChrome();
}

async function restartIfRunning() {
  if (!state.running) return;
  await stopPipeline();
  await startPipeline();
}

/* ---------- 用量 ---------- */
function renderUsage() {
  const s = usage.todaySummary();
  const cost = s.costUsd >= 0.005 ? ` · ≈$${s.costUsd.toFixed(2)}` : '';
  $('#usage-chip').textContent = `今日 ${formatMin(s.totalMin)}${cost}`;
  if (usage.shouldWarn(settings.dailyBudgetMin)) {
    toast(`⚠️ 今日用量已超過 ${settings.dailyBudgetMin} 分鐘的警示門檻。`, 8000);
  }
}
usage.addEventListener('change', renderUsage);

/* ---------- 設定面板 ---------- */
function openSettings(firstRun = false) {
  const dlg = $('#settings-dialog');
  $('#set-welcome').classList.toggle('hidden', !firstRun);
  $('#set-api-key').value = settings.apiKey;
  $('#set-engine').value = settings.engine;
  $('#set-demo').checked = settings.demoMode;
  $('#set-vad').checked = settings.vadEnabled;
  $('#set-vad-threshold').value = settings.vadThreshold;
  $('#set-idle').value = settings.idleDisconnectMin;
  $('#set-budget').value = settings.dailyBudgetMin;
  $('#set-layout').value = settings.layout;
  $('#set-font').value = settings.fontScale;
  dlg.showModal();
}

function bindSettings() {
  $('#settings-btn').addEventListener('click', () => openSettings(false));
  $('#settings-close').addEventListener('click', () => $('#settings-dialog').close());
  $('#settings-save').addEventListener('click', async () => {
    settings = saveSettings({
      apiKey: $('#set-api-key').value.trim(),
      engine: $('#set-engine').value,
      demoMode: $('#set-demo').checked,
      vadEnabled: $('#set-vad').checked,
      vadThreshold: parseFloat($('#set-vad-threshold').value) || 0.012,
      idleDisconnectMin: Math.max(0, parseFloat($('#set-idle').value) || 0),
      dailyBudgetMin: Math.max(0, parseFloat($('#set-budget').value) || 0),
      layout: $('#set-layout').value,
      fontScale: parseFloat($('#set-font').value) || 1,
    });
    pipeline.settings = settings;
    $('#settings-dialog').close();
    applyLayout();
    renderStatus();
    await restartIfRunning();
  });
  $('#set-demo-start').addEventListener('click', () => {
    settings = saveSettings({ demoMode: true });
    pipeline.settings = settings;
    $('#settings-dialog').close();
    renderStatus();
    toast('Demo 模式已開啟：不需 API key，可直接按「開始」試玩介面。');
  });
  $('#run-diagnostics').addEventListener('click', async () => {
    const box = $('#diag-results');
    box.classList.remove('hidden');
    box.textContent = '診斷中…（約需 15 秒，請允許麥克風權限）';
    const render = (results) => {
      box.innerHTML = '';
      for (const r of results) {
        const div = document.createElement('div');
        div.className = `diag-row ${r.ok ? 'ok' : 'bad'}`;
        div.textContent = `${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`;
        box.appendChild(div);
      }
    };
    const results = await runDiagnostics(settings, render);
    render(results);
    const copyBtn = $('#copy-diagnostics');
    copyBtn.classList.remove('hidden');
    copyBtn.onclick = async () => {
      await navigator.clipboard.writeText(formatDiagnostics(results)).catch(() => {});
      toast('診斷結果已複製，可直接貼給開發者。');
    };
  });

  $('#set-clear-transcript').addEventListener('click', async () => {
    if (confirm('確定清除所有逐字稿？')) {
      await transcript.clear();
      for (const p of Object.values(panels)) p.clear();
      toast('逐字稿已清除。');
    }
  });
}

/* ---------- 逐字稿面板 ---------- */
function bindTranscript() {
  $('#transcript-btn').addEventListener('click', async () => {
    const rows = await transcript.all();
    const list = $('#transcript-list');
    list.innerHTML = '';
    if (rows.length === 0) list.innerHTML = '<p class="hint">還沒有逐字稿。開始翻譯後，定稿的句子會存在這裡（僅存在本機）。</p>';
    for (const r of rows.slice(-300)) {
      const div = document.createElement('div');
      div.className = `tr-row ${r.kind}`;
      const time = new Date(r.ts).toLocaleTimeString('zh-TW', { hour12: false });
      div.innerHTML = `<span class="tr-time">${time}</span><span class="tr-lang">${langName(r.lang) || ''}</span><span class="tr-text"></span>`;
      div.querySelector('.tr-text').textContent = r.text;
      list.appendChild(div);
    }
    $('#transcript-dialog').showModal();
    list.scrollTop = list.scrollHeight;
  });
  $('#transcript-close').addEventListener('click', () => $('#transcript-dialog').close());
  $('#export-txt').addEventListener('click', async () =>
    downloadText(`逐字稿-${new Date().toISOString().slice(0, 10)}.txt`, await transcript.exportTxt())
  );
  $('#export-srt').addEventListener('click', async () =>
    downloadText(`字幕-${new Date().toISOString().slice(0, 10)}.srt`, await transcript.exportSrt())
  );
}

/* ---------- PWA ---------- */
function bindPwa() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installPrompt = e;
    $('#install-btn').classList.remove('hidden');
  });
  $('#install-btn').addEventListener('click', async () => {
    if (!state.installPrompt) return;
    state.installPrompt.prompt();
    await state.installPrompt.userChoice;
    state.installPrompt = null;
    $('#install-btn').classList.add('hidden');
  });
}

/* ---------- 綁定 ---------- */
function bindControls() {
  for (const btn of document.querySelectorAll('#mode-tabs .tab')) {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  }
  $('#main-btn').addEventListener('click', () => (state.running ? stopPipeline() : startPipeline()));
  $('#voice-btn').addEventListener('click', () => {
    state.voiceOn = !state.voiceOn;
    pipeline.setVoiceOutput(state.voiceOn);
    updateVoiceBtn();
  });
  $('#flip-btn').addEventListener('click', () => setFlipped(!state.flipped));
  $('#swap-btn').addEventListener('click', async () => {
    state.direction = state.direction === 'out' ? 'in' : 'out';
    updateDirectionLabel();
    await restartIfRunning();
  });
  $('#auto-duplex').addEventListener('change', async (e) => {
    settings = saveSettings({ conversationMode: e.target.checked ? 'auto' : 'manual' });
    pipeline.settings = settings;
    updateDirectionLabel();
    await restartIfRunning();
    if (e.target.checked) toast('自動雙向：兩條連線同時翻譯（輸入音訊雙倍計量）。');
  });
  $('#my-lang').addEventListener('change', async (e) => {
    settings = saveSettings({ myLang: e.target.value });
    updatePanelTags();
    updateDirectionLabel();
    await restartIfRunning();
  });
  $('#their-lang').addEventListener('change', async (e) => {
    settings = saveSettings({ theirLang: e.target.value });
    updatePanelTags();
    updateDirectionLabel();
    await restartIfRunning();
  });
  $('#layout-btn').addEventListener('click', () => {
    const next = resolveLayout(settings) === 'immersive' ? 'dashboard' : 'immersive';
    settings = saveSettings({ layout: next });
    applyLayout();
  });
  $('#standby-overlay').addEventListener('click', () => pipeline.wake());

  // 會議模式醒目入口：等同按「開始」，直接喚出瀏覽器的分頁選擇器
  $('#meeting-pick').addEventListener('click', () => {
    if (!state.running) startPipeline();
  });

  // 影片模式：開檔 / 貼網址
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'video/*,audio/*';
  fileInput.addEventListener('change', () => {
    if (fileInput.files?.[0]) {
      videoSource.loadFile(fileInput.files[0]);
      refreshModeChrome();
    }
  });
  $('#video-open').addEventListener('click', () => fileInput.click());
  $('#video-load-url').addEventListener('click', () => {
    const url = $('#video-url').value.trim();
    if (!url) return;
    videoSource.loadUrl(url);
    refreshModeChrome();
    toast('若載入後有畫面沒聲音，多半是該網址不允許跨網站音訊（CORS）；改用「開啟影片檔」最可靠。', 6000);
  });
  $('#video-el').addEventListener('error', () => {
    if (MODES[state.modeId].view === 'video') toast('影片載入失敗：請確認是直連影片檔網址，或改用本機檔案。', 6000);
  });
}

function updateVoiceBtn() {
  $('#voice-btn').textContent = state.voiceOn ? '🔊' : '🔇';
  $('#voice-btn').title = state.voiceOn ? '語音輸出：開' : '語音輸出：關（僅字幕）';
}

/* ---------- 啟動 ---------- */
function boot() {
  fillLanguageSelect($('#my-lang'), settings.myLang);
  fillLanguageSelect($('#their-lang'), settings.theirLang);
  const engineSel = $('#set-engine');
  for (const e of Object.values(ENGINES)) {
    const opt = document.createElement('option');
    opt.value = e.id;
    opt.textContent = e.label;
    engineSel.appendChild(opt);
  }
  // 會議模式需要 getDisplayMedia（桌機）
  if (!navigator.mediaDevices?.getDisplayMedia) {
    document.querySelector('[data-mode="meeting"]').classList.add('unavailable');
    document.querySelector('[data-mode="meeting"]').title = '此裝置不支援分頁音訊擷取（需要桌機 Chrome/Edge）';
  }
  bindControls();
  bindSettings();
  bindTranscript();
  bindPwa();
  applyLayout();
  renderUsage();
  setMode(settings.lastMode && MODES[settings.lastMode] ? settings.lastMode : 'conversation');
  renderStatus();
  if (!settings.apiKey && !settings.demoMode) openSettings(true);
}

boot();
