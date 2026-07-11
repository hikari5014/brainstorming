// 口譯機 —— 對講機式即時口譯（iOS 優先）。
//
// 回合狀態機（上一代 app 的教訓總結）：
//   聲音「只在按住說話鈕時」送給翻譯引擎；放開才播譯文。
//   說與聽永不重疊 → 喇叭迴授、插話中斷、閘門卡死整類問題從架構上不存在。
//   按下按鈕的瞬間若譯文還在播 → 立刻停掉（人類搶話語意），也不會被收進去。

import { MY_LANG, FOREIGN_LANGS, langOf } from './langs.js';
import { loadSettings, saveSettings } from './settings.js';
import { LiveSession, MockSession } from './live.js';
import { AudioEngine } from './audio.js';
import { runDiagnostics, formatDiagnostics } from './diag.js';

const $ = (s) => document.querySelector(s);

let settings = loadSettings();
const audio = new AudioEngine();

const state = {
  holding: null, // null | 'me' | 'them'
  pressed: { me: false, them: false }, // 實體按壓狀態（與非同步啟動流程解耦）
  sessions: { toForeign: null, toMine: null },
  pending: { toForeign: [], toMine: [] }, // 連線完成前暫存的音訊（按住即說，不吃字）
  turns: { me: null, them: null }, // 各方向最新一輪的氣泡 DOM
  lastActivity: Date.now(),
  startedOnce: false,
  wakeLock: null,
  installPrompt: null,
};

/* ---------- 小工具 ---------- */
let toastTimer = null;
function toast(msg, ms = 4000) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

function useMock() {
  return settings.demoMode || !settings.apiKey?.trim();
}

function track(kind, sec) {
  // 極簡用量統計：今日送出/接收秒數
  const day = new Date().toISOString().slice(0, 10);
  let u;
  try { u = JSON.parse(localStorage.getItem('kouyiji.usage') || '{}'); } catch { u = {}; }
  if (u.day !== day) u = { day, sent: 0, recv: 0 };
  u[kind] += sec;
  localStorage.setItem('kouyiji.usage', JSON.stringify(u));
}

/* ---------- 連線管理 ---------- */
function makeSession(tag) {
  const target = tag === 'toForeign' ? settings.foreignLang : MY_LANG;
  const session = useMock()
    ? new MockSession({ tag })
    : new LiveSession({ apiKey: settings.apiKey.trim(), target, tag });

  session.addEventListener('status', (e) => {
    renderStatus();
    if (e.detail.state === 'open') flushPending(tag);
  });
  session.addEventListener('input-text', (e) => appendText(tag, 'src', e.detail.text));
  session.addEventListener('output-text', (e) => appendText(tag, 'dst', e.detail.text));
  session.addEventListener('audio', (e) => {
    const sec = audio.playBase64(e.detail.base64);
    if (sec) track('recv', sec);
    state.lastActivity = Date.now();
  });
  session.addEventListener('fatal', (e) => {
    const reason = e.detail.reason || '';
    if (/quota|exceeded|429/i.test(reason)) toast('額度已用盡（免費層每日限額），明天再試或檢查方案。', 8000);
    else if (/api key|401|403|PERMISSION/i.test(reason)) toast('API key 無效或無權限：設定 → 連線診斷可找原因。', 8000);
    else toast(`連線失敗：${reason}（設定 → 連線診斷）`, 8000);
    disconnectSessions();
    renderStatus();
  });
  return session;
}

function ensureSessions() {
  for (const tag of ['toForeign', 'toMine']) {
    const s = state.sessions[tag];
    if (!s || s.state === 'closed' || s.state === 'error') {
      state.sessions[tag] = makeSession(tag);
      state.sessions[tag].connect();
    }
  }
}

function disconnectSessions() {
  for (const tag of ['toForeign', 'toMine']) {
    state.sessions[tag]?.close();
    state.sessions[tag] = null;
    state.pending[tag] = [];
  }
}

function flushPending(tag) {
  const s = state.sessions[tag];
  if (!s || s.state !== 'open') return;
  const buf = state.pending[tag];
  state.pending[tag] = [];
  for (const int16 of buf) {
    if (s.sendAudio(int16)) track('sent', int16.length / 16000);
  }
}

/* ---------- 音訊 chunk 路由（狀態機核心：沒按住 = 一律丟棄） ---------- */
audio.onChunk = ({ int16, rms }) => {
  $('#meter').style.setProperty('--level', Math.min(1, rms * 14));
  if (!state.holding) return;
  state.lastActivity = Date.now();
  const tag = state.holding === 'me' ? 'toForeign' : 'toMine';
  const s = state.sessions[tag];
  if (s && s.state === 'open') {
    flushPending(tag);
    if (s.sendAudio(int16)) track('sent', int16.length / 16000);
  } else {
    state.pending[tag].push(int16);
    if (state.pending[tag].length > 50) state.pending[tag].shift(); // 最多 5 秒
  }
};

audio.onMicLost = () => {
  toast('麥克風中斷了，請重新按住說話。');
  releaseHold();
};

/* ---------- 按住說話 ---------- */
// 重要教訓：beginHold 是非同步的（首次按下要等 getUserMedia 權限對話框）。
// 手指可能在 await 期間就抬起（例如去點「允許」），所以：
//   1. pressed[] 追蹤實體按壓，await 之後必須重新確認還按著才進入錄音
//   2. window 層級的 pointerup/blur catch-all，任何情況都能結束錄音
//   3. mic track 只在按住期間 enabled（audio.setMicEnabled）
async function beginHold(side, btn) {
  if (state.holding) return;
  try {
    // 第一次按下（使用者手勢）啟動整個音訊引擎 —— iOS 的唯一正確時機
    await audio.start();
  } catch (err) {
    state.pressed[side] = false;
    toast(err?.name === 'NotAllowedError' ? '需要麥克風權限才能口譯。' : `無法啟動麥克風：${err?.message || err}`, 6000);
    return;
  }
  if (!state.startedOnce) {
    state.startedOnce = true;
    acquireWakeLock();
    startIdleWatch();
  }
  // await 期間手指已放開（權限對話框、快速點擊）→ 不進入錄音
  if (!state.pressed[side]) {
    audio.setMicEnabled(false);
    renderStatus();
    return;
  }
  audio.stopPlayback(); // 搶話：立刻停掉還沒播完的譯文
  ensureSessions();
  state.holding = side;
  state.lastActivity = Date.now();
  audio.setMicEnabled(true);
  btn.classList.add('holding');
  document.body.dataset.holding = side;
  newTurn(side);
  renderStatus();
}

function releaseHold() {
  state.pressed.me = false;
  state.pressed.them = false;
  if (!state.holding) return;
  const side = state.holding;
  state.holding = null;
  audio.setMicEnabled(false);
  document.body.dataset.holding = '';
  $(side === 'me' ? '#btn-me' : '#btn-them').classList.remove('holding');
  setTurnState(side, 'pending');
  renderStatus();
}

function bindTalkButton(btn, side) {
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    btn.setPointerCapture?.(e.pointerId);
    state.pressed[side] = true;
    beginHold(side, btn);
  });
  for (const evt of ['pointerup', 'pointercancel']) {
    btn.addEventListener(evt, () => {
      state.pressed[side] = false;
      if (state.holding === side) releaseHold();
    });
  }
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}

// catch-all：不管指標事件在哪裡結束、視窗失焦（權限對話框），一律結束錄音
for (const evt of ['pointerup', 'pointercancel']) {
  window.addEventListener(evt, () => releaseHold(), true);
}
window.addEventListener('blur', () => releaseHold());

/* ---------- 字幕氣泡（含 錄音中→翻譯中→完成 的狀態提示） ---------- */
function newTurn(side) {
  const feed = $('#feed');
  $('#feed-hint')?.remove();
  const bubble = document.createElement('div');
  bubble.className = `bubble ${side}`;
  bubble.innerHTML = '<div class="src"></div><div class="dst"></div><div class="turn-state"></div>';
  feed.appendChild(bubble);
  while (feed.children.length > 120) feed.firstChild.remove();
  state.turns[side] = bubble;
  setTurnState(side, 'recording');
  feed.scrollTop = feed.scrollHeight;
}

function setTurnState(side, phase) {
  const bubble = state.turns[side];
  if (!bubble) return;
  const el = bubble.querySelector('.turn-state');
  if (!el) return;
  clearTimeout(bubble._stateTimer);
  if (phase === 'recording') {
    el.textContent = '🔴 錄音中…（放開結束）';
    el.className = 'turn-state recording';
  } else if (phase === 'pending') {
    // 已放開：等待譯文；太久沒回應要明講，不能讓使用者以為還在錄
    el.textContent = '✋ 已停止錄音 · 翻譯中…';
    el.className = 'turn-state pending';
    bubble._stateTimer = setTimeout(() => {
      if (bubble.querySelector('.dst').textContent) return;
      el.textContent = '沒有收到翻譯（可能沒收到聲音），請再按住試一次';
      el.className = 'turn-state failed';
    }, 12000);
  } else {
    el.remove();
  }
}

function appendText(tag, kind, text) {
  const side = tag === 'toForeign' ? 'me' : 'them';
  if (!state.turns[side]) newTurn(side);
  const el = state.turns[side].querySelector(`.${kind}`);
  el.textContent += text;
  if (kind === 'dst') setTurnState(side, 'done'); // 譯文開始出現 → 移除狀態提示
  $('#feed').scrollTop = $('#feed').scrollHeight;
  state.lastActivity = Date.now();
}

/* ---------- 狀態列 ---------- */
function renderStatus() {
  const dot = $('#dot');
  const text = $('#status-text');
  const states = ['toForeign', 'toMine'].map((t) => state.sessions[t]?.state).filter(Boolean);
  let s = 'idle';
  if (state.holding) s = 'talking';
  else if (states.includes('error')) s = 'error';
  else if (states.includes('connecting') || states.includes('reconnecting')) s = 'connecting';
  else if (states.includes('open')) s = 'open';
  dot.dataset.state = s;
  const demo = useMock() ? 'Demo · ' : '';
  text.textContent = demo + ({
    idle: '按住下方按鈕開始',
    connecting: '連線中…',
    open: '就緒',
    talking: state.holding === 'me' ? '你說話中…' : '對方說話中…',
    error: '連線錯誤',
  }[s]);
}

/* ---------- 省額度：閒置自動斷線（按下按鈕自動重連） ---------- */
let idleWatch = null;
function startIdleWatch() {
  clearInterval(idleWatch);
  idleWatch = setInterval(() => {
    const min = settings.idleDisconnectMin;
    if (!min || min <= 0) return;
    const hasOpen = ['toForeign', 'toMine'].some((t) => state.sessions[t]?.state === 'open');
    if (hasOpen && !state.holding && !audio.isSpeaking &&
        Date.now() - state.lastActivity > min * 60_000) {
      disconnectSessions();
      audio.close(); // 連麥克風一起關：iOS 的橘色錄音指示燈熄滅，下次按住再重啟
      renderStatus();
      toast('閒置已自動斷線省額度（麥克風已關閉），按住按鈕即恢復。');
    }
  }, 10_000);
}

/* ---------- Wake Lock：口譯中螢幕不休眠 ---------- */
async function acquireWakeLock() {
  try {
    state.wakeLock = await navigator.wakeLock?.request('screen');
  } catch { /* 不支援就算了 */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.startedOnce) acquireWakeLock();
});

/* ---------- 語言切換 ---------- */
function renderLangUI() {
  const lang = langOf(settings.foreignLang);
  $('#btn-them .talk-label').textContent = `${lang.flag} ${lang.native}`;
  $('#btn-them .talk-sub').textContent = `對方按住說${lang.name} → 中文`;
  $('#btn-me .talk-sub').textContent = `按住說中文 → ${lang.name}`;
}

function fillLangSelect() {
  const sel = $('#foreign-lang');
  sel.innerHTML = '';
  for (const l of FOREIGN_LANGS) {
    const opt = document.createElement('option');
    opt.value = l.code;
    opt.textContent = `${l.flag} ${l.name} ${l.native}`;
    sel.appendChild(opt);
  }
  sel.value = settings.foreignLang;
  sel.addEventListener('change', () => {
    settings = saveSettings({ foreignLang: sel.value });
    renderLangUI();
    // 目標語言變了 → 換掉 toForeign 連線（下次按住時建立）
    state.sessions.toForeign?.close();
    state.sessions.toForeign = null;
    renderStatus();
  });
}

/* ---------- 設定面板 ---------- */
function openSettings(firstRun = false) {
  $('#welcome').classList.toggle('hidden', !firstRun);
  $('#set-key').value = settings.apiKey;
  $('#set-demo').checked = settings.demoMode;
  $('#set-font').value = settings.fontScale;
  $('#set-idle').value = settings.idleDisconnectMin;
  let u = {};
  try { u = JSON.parse(localStorage.getItem('kouyiji.usage') || '{}'); } catch { /* none */ }
  $('#usage-line').textContent =
    u.day ? `今日已用：送出 ${Math.round(u.sent || 0)} 秒、接收 ${Math.round(u.recv || 0)} 秒` : '今日尚未使用';
  $('#settings').showModal();
}

function bindSettings() {
  $('#gear').addEventListener('click', () => openSettings(false));
  $('#settings-close').addEventListener('click', () => $('#settings').close());
  $('#settings-save').addEventListener('click', () => {
    settings = saveSettings({
      apiKey: $('#set-key').value.trim(),
      demoMode: $('#set-demo').checked,
      fontScale: parseFloat($('#set-font').value) || 1,
      idleDisconnectMin: Math.max(0, parseFloat($('#set-idle').value) || 0),
    });
    document.documentElement.style.setProperty('--font-scale', settings.fontScale);
    disconnectSessions(); // 讓新設定（key/demo）下次按住時生效
    $('#settings').close();
    renderStatus();
  });
  $('#demo-start').addEventListener('click', () => {
    settings = saveSettings({ demoMode: true });
    $('#settings').close();
    renderStatus();
    toast('Demo 模式已開啟：按住下方按鈕、隨便說幾個字再放開試試。');
  });
  $('#run-diag').addEventListener('click', async () => {
    const box = $('#diag-results');
    box.classList.remove('hidden');
    box.textContent = '診斷中…（約 15 秒，請允許麥克風）';
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
    const btn = $('#copy-diag');
    btn.classList.remove('hidden');
    btn.onclick = async () => {
      await navigator.clipboard.writeText(formatDiagnostics(results)).catch(() => {});
      toast('診斷結果已複製。');
    };
  });
  $('#clear-feed').addEventListener('click', () => {
    $('#feed').innerHTML = '';
    state.turns = { me: null, them: null };
    $('#settings').close();
  });
}

/* ---------- PWA ---------- */
function bindPwa() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installPrompt = e;
    $('#install').classList.remove('hidden');
  });
  $('#install').addEventListener('click', async () => {
    if (!state.installPrompt) return;
    state.installPrompt.prompt();
    await state.installPrompt.userChoice;
    state.installPrompt = null;
    $('#install').classList.add('hidden');
  });
}

/* ---------- 啟動 ---------- */
function boot() {
  document.documentElement.style.setProperty('--font-scale', settings.fontScale);
  fillLangSelect();
  renderLangUI();
  bindTalkButton($('#btn-me'), 'me');
  bindTalkButton($('#btn-them'), 'them');
  bindSettings();
  bindPwa();
  renderStatus();
  if (!settings.apiKey && !settings.demoMode) openSettings(true);
  // 測試/除錯把手
  window.__kouyiji = { audio, state, get settings() { return settings; } };
}

boot();
