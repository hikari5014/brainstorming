// 口譯機 v4 —— 面對面雙向對話（上下分區）＋單向聆聽。
//
// 不變的架構原則（歷代教訓）：
//   - 通話隱喻：按「開始」才開麥克風＋建線；結束通話即全部關閉
//   - 對話模式聲音只在「按住」時送出；聆聽模式為連續送出的單連線
//   - 單一 AudioContext（audio.js）、實體按壓與非同步啟動解耦、window 級 catch-all

import { MY_LANG, langOf, FOREIGN_LANGS } from './langs.js';
import { loadSettings, saveSettings } from './settings.js';
import { LiveSession, MockSession } from './live.js';
import { AudioEngine } from './audio.js';
import { runDiagnostics, formatDiagnostics } from './diag.js';
import { TranscriptStore, formatTxt, downloadTxt } from './transcript.js';

const $ = (s) => document.querySelector(s);

let settings = loadSettings();
const audio = new AudioEngine();
const store = new TranscriptStore();

const state = {
  phase: 'home', // 'home' | 'call' | 'listen'
  mode: 'call', // 首頁選擇的模式
  holding: null, // null | 'me' | 'them'
  pressed: { me: false, them: false },
  listening: false,
  sessions: { toForeign: null, toMine: null },
  pending: { toForeign: [], toMine: [] }, // 連線完成前的音訊暫存
  turns: { toForeign: null, toMine: null }, // 進行中的回合（逐字稿用）
  callHadTurns: false,
  lastActivity: Date.now(),
  wakeLock: null,
  pendingTimer: null,
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

const useMock = () => settings.demoMode || !settings.apiKey?.trim();
const foreign = () => langOf(settings.foreignLang);

function track(kind, sec) {
  const day = new Date().toISOString().slice(0, 10);
  let u;
  try { u = JSON.parse(localStorage.getItem('kouyiji.usage') || '{}'); } catch { u = {}; }
  if (u.day !== day) u = { day, sent: 0, recv: 0 };
  u[kind] += sec;
  localStorage.setItem('kouyiji.usage', JSON.stringify(u));
}

/* ---------- 回合（逐字稿）---------- */
function beginTurn(tag) {
  finalizeTurn(tag); // 前一輪若還沒收尾先存
  state.turns[tag] = {
    ts: Date.now(),
    mode: state.phase,
    side: tag === 'toForeign' ? 'me' : 'them',
    srcLang: tag === 'toForeign' ? '中文' : foreign().name,
    dstLang: tag === 'toForeign' ? foreign().name : '中文',
    src: '', dst: '', saved: false,
  };
}

function finalizeTurn(tag) {
  const t = state.turns[tag];
  if (!t || t.saved) return;
  if (t.src.trim() || t.dst.trim()) {
    t.saved = true;
    state.callHadTurns = true;
    store.add({ ts: t.ts, mode: t.mode, side: t.side, srcLang: t.srcLang, dstLang: t.dstLang, src: t.src.trim(), dst: t.dst.trim() });
  }
  state.turns[tag] = null;
}

function finalizeAllTurns() {
  finalizeTurn('toForeign');
  finalizeTurn('toMine');
}

/* ---------- 顯示路由 ---------- */
// toForeign（我說）→ 上半（對方讀）；toMine（對方說/聆聽）→ 下半或聆聽 feed
function routeText(tag, kind, text) {
  state.lastActivity = Date.now();
  const t = state.turns[tag] || (beginTurn(tag), state.turns[tag]);
  t[kind === 'input' ? 'src' : 'dst'] += text;

  if (kind === 'output') hidePendingDots();

  if (state.phase === 'listen') {
    renderListenTurn(t);
    return;
  }
  const side = tag === 'toForeign' ? 'theirs' : 'mine';
  $(`#${side}-src`).textContent = t.src;
  $(`#${side}-dst`).textContent = t.dst;
  $(`#${side}-src-row`).classList.toggle('show', Boolean(t.src));
}

/* ---------- 連線 ---------- */
function makeSession(tag) {
  const target = tag === 'toForeign' ? settings.foreignLang : MY_LANG;
  const session = useMock() ? new MockSession({ tag }) : new LiveSession({ apiKey: settings.apiKey.trim(), target, tag });

  session.addEventListener('status', (e) => {
    renderLive();
    if (e.detail.state === 'open') flushPending(tag);
  });
  session.addEventListener('input-text', (e) => routeText(tag, 'input', e.detail.text));
  session.addEventListener('output-text', (e) => routeText(tag, 'output', e.detail.text));
  session.addEventListener('audio', (e) => {
    const sec = audio.playBase64(e.detail.base64);
    if (sec) track('recv', sec);
    state.lastActivity = Date.now();
  });
  session.addEventListener('turn-complete', () => finalizeTurn(tag));
  session.addEventListener('fatal', (e) => {
    const reason = e.detail.reason || '';
    if (/quota|exceeded|429/i.test(reason)) toast('額度已用盡（免費層每日限額）。', 8000);
    else if (/api key|401|403|PERMISSION/i.test(reason)) toast('API key 無效或無權限：設定 → 連線診斷。', 8000);
    else toast(`連線失敗：${reason}（設定 → 連線診斷）`, 8000);
    endSession(true);
  });
  return session;
}

function ensureSessions(tags) {
  for (const tag of tags) {
    const s = state.sessions[tag];
    if (!s || s.state === 'closed' || s.state === 'error') {
      state.sessions[tag] = makeSession(tag);
      state.sessions[tag].connect();
    }
  }
}

function closeSessions() {
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

function sendChunk(tag, int16) {
  const s = state.sessions[tag];
  if (s && s.state === 'open') {
    flushPending(tag);
    if (s.sendAudio(int16)) track('sent', int16.length / 16000);
  } else {
    state.pending[tag].push(int16);
    if (state.pending[tag].length > 50) state.pending[tag].shift();
  }
}

/* ---------- 音訊 chunk 路由 ---------- */
audio.onChunk = ({ int16, rms }) => {
  if (state.phase === 'call' && state.holding) {
    setWave(state.holding === 'me' ? 'wave-me' : 'wave-them', rms);
    sendChunk(state.holding === 'me' ? 'toForeign' : 'toMine', int16);
  } else if (state.phase === 'listen' && state.listening) {
    setWave('wave-listen', rms);
    sendChunk('toMine', int16);
  }
};

audio.onMicLost = () => {
  toast('麥克風中斷了。');
  endSession(true);
};

function setWave(id, rms) {
  document.getElementById(id)?.style.setProperty('--level', Math.min(1, rms * 14).toFixed(3));
}

function clearWaves() {
  for (const id of ['wave-me', 'wave-them', 'wave-listen']) {
    document.getElementById(id)?.style.setProperty('--level', '0');
  }
}

/* ---------- 通話開始 / 結束 ---------- */
async function startSession(mode) {
  try {
    await audio.start(); // 使用者手勢中開麥克風（通話隱喻：按下才開）
  } catch (err) {
    toast(err?.name === 'NotAllowedError' ? '需要麥克風權限。' : `無法啟動麥克風：${err?.message || err}`, 6000);
    return;
  }
  audio.setMicEnabled(false);
  state.phase = mode;
  state.callHadTurns = false;
  state.lastActivity = Date.now();
  document.body.dataset.phase = mode;
  $('#view-home').classList.add('hidden');
  $('#view-call').classList.toggle('hidden', mode !== 'call');
  $('#view-listen').classList.toggle('hidden', mode !== 'listen');
  ensureSessions(mode === 'call' ? ['toForeign', 'toMine'] : ['toMine']);
  if (mode === 'listen') {
    $('#listen-feed').innerHTML = '';
    setListening(true); // 進入即開始聆聽，可點按暫停
  }
  acquireWakeLock();
  renderLive();
}

async function endSession(silent = false) {
  releaseHold();
  setListening(false);
  finalizeAllTurns();
  hidePendingDots();
  closeSessions();
  await audio.close(); // 通話隱喻：結束就關麥克風，iOS 錄音指示燈熄滅
  clearWaves();
  const hadTurns = state.callHadTurns;
  state.phase = 'home';
  document.body.dataset.phase = 'home';
  $('#view-call').classList.add('hidden');
  $('#view-listen').classList.add('hidden');
  $('#view-home').classList.remove('hidden');
  // 清空面對面殘留內容
  for (const id of ['theirs-src', 'theirs-dst', 'mine-src', 'mine-dst']) $(`#${id}`).textContent = '';
  $('#theirs-src-row').classList.remove('show');
  $('#mine-src-row').classList.remove('show');
  renderLive();
  if (!silent && hadTurns) openTranscript(); // 結束後進入逐字稿檢視
}

/* ---------- 按住說話（沿用歷代競態防線） ---------- */
async function beginHold(side, btn) {
  if (state.phase !== 'call' || state.holding) return;
  audio.kick();
  if (!state.pressed[side]) return; // 按下後已放開
  audio.stopPlayback(); // 搶話：停掉還沒播完的譯文
  state.holding = side;
  state.lastActivity = Date.now();
  audio.setMicEnabled(true);
  btn.classList.add('holding');
  document.body.dataset.holding = side;
  hidePendingDots();
  beginTurn(side === 'me' ? 'toForeign' : 'toMine');
  renderLive();
}

function releaseHold() {
  state.pressed.me = false;
  state.pressed.them = false;
  if (!state.holding) return;
  state.holding = null;
  audio.setMicEnabled(false);
  document.body.dataset.holding = '';
  $('#hold-me').classList.remove('holding');
  $('#hold-them').classList.remove('holding');
  clearWaves();
  showPendingDots(); // 放開 → 翻譯中跳動點（固定高度區）
  renderLive();
}

function bindHold(btn, side) {
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
for (const evt of ['pointerup', 'pointercancel']) {
  window.addEventListener(evt, () => releaseHold(), true);
}
window.addEventListener('blur', () => releaseHold());

/* ---------- 翻譯中跳動點（固定高度，不跳版面） ---------- */
function showPendingDots() {
  if (state.phase !== 'call') return;
  $('#pending-dots').classList.remove('hidden');
  clearTimeout(state.pendingTimer);
  state.pendingTimer = setTimeout(hidePendingDots, 12000);
}
function hidePendingDots() {
  clearTimeout(state.pendingTimer);
  $('#pending-dots')?.classList.add('hidden');
}

/* ---------- 聆聽模式 ---------- */
function setListening(on, skipUi = false) {
  state.listening = on;
  audio.setMicEnabled(on && state.phase === 'listen');
  if (skipUi) return;
  const btn = $('#listen-toggle');
  btn.classList.toggle('on', on);
  btn.querySelector('span').textContent = on ? '停止聆聽' : '繼續聆聽';
  btn.setAttribute('aria-label', on ? '停止聆聽' : '繼續聆聽');
  $('#listen-state').textContent = on ? '聆聽中' : '已暫停';
  document.body.dataset.listening = on ? 'on' : '';
  if (!on) clearWaves();
}

function renderListenTurn(turn) {
  let el = turn._el;
  if (!el) {
    el = document.createElement('div');
    el.className = 'listen-turn';
    el.innerHTML = '<div class="dst"></div><div class="src"></div>';
    $('#listen-feed').appendChild(el);
    while ($('#listen-feed').children.length > 80) $('#listen-feed').firstChild.remove();
    turn._el = el;
  }
  el.querySelector('.dst').textContent = turn.dst;
  el.querySelector('.src').textContent = turn.src;
  $('#listen-feed').scrollTop = $('#listen-feed').scrollHeight;
}

/* ---------- 逐字稿檢視 ---------- */
async function openTranscript() {
  finalizeAllTurns();
  const turns = await store.all();
  const list = $('#tr-list');
  list.innerHTML = '';
  if (turns.length === 0) {
    list.innerHTML = '<p class="tr-empty">還沒有紀錄。逐字稿只存在這台裝置。</p>';
  }
  for (const t of turns.slice(-200)) {
    const div = document.createElement('div');
    div.className = `tr-turn ${t.side}`;
    const time = new Date(t.ts).toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' });
    div.innerHTML = '<div class="tr-meta"></div><div class="tr-src"></div><div class="tr-dst"></div>';
    div.querySelector('.tr-meta').textContent = `${time} · ${t.side === 'me' ? `中文 → ${t.dstLang}` : `${t.srcLang} → 中文`}`;
    div.querySelector('.tr-src').textContent = t.src;
    div.querySelector('.tr-dst').textContent = t.dst;
    list.appendChild(div);
  }
  $('#transcript').showModal();
  list.scrollTop = list.scrollHeight;
}

function bindTranscript() {
  $('#open-transcript').addEventListener('click', openTranscript);
  $('#tr-close').addEventListener('click', () => $('#transcript').close());
  $('#tr-copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(formatTxt(await store.all())).catch(() => {});
    toast('逐字稿已複製。');
  });
  $('#tr-share').addEventListener('click', async () => {
    const text = formatTxt(await store.all());
    if (navigator.share) {
      await navigator.share({ title: '口譯機逐字稿', text }).catch(() => {});
    } else {
      await navigator.clipboard.writeText(text).catch(() => {});
      toast('此裝置不支援分享，已改為複製。');
    }
  });
  $('#tr-export').addEventListener('click', async () => {
    downloadTxt(`口譯逐字稿-${new Date().toISOString().slice(0, 10)}.txt`, formatTxt(await store.all()));
  });
  $('#tr-clear').addEventListener('click', async () => {
    if (confirm('確定清除所有逐字稿？')) {
      await store.clear();
      openTranscript();
    }
  });
}

/* ---------- 狀態顯示 ---------- */
function renderLive() {
  const states = ['toForeign', 'toMine'].map((t) => state.sessions[t]?.state).filter(Boolean);
  const connecting = states.includes('connecting') || states.includes('reconnecting');
  document.body.dataset.conn = connecting ? 'connecting' : states.includes('open') ? 'open' : 'idle';
  if (state.phase === 'listen' && connecting) $('#listen-state').textContent = '連線中…';
}

/* ---------- 語言 ---------- */
function renderLangUI() {
  const lang = foreign();
  $('#theirs-lang').textContent = lang.native;
  $('#theirs-live').textContent = lang.ui.live;
  $('#theirs-src-label').textContent = lang.ui.original;
  $('#hold-them-label').textContent = lang.ui.hold;
  $('#hold-them').setAttribute('aria-label', lang.ui.hold);
  $('#pair-foreign').textContent = lang.native;
  $('#listen-lang').textContent = `${lang.native} → 中文`;
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
    // 換語言 → toForeign 連線下次建立時採用新目標
    state.sessions.toForeign?.close();
    state.sessions.toForeign = null;
  });
}

/* ---------- 省額度：閒置自動結束 ---------- */
setInterval(() => {
  const min = settings.idleDisconnectMin;
  if (!min || min <= 0 || state.phase === 'home') return;
  if (!state.holding && !state.listening && !audio.isSpeaking &&
      Date.now() - state.lastActivity > min * 60_000) {
    toast('閒置已自動結束（麥克風已關閉）。');
    endSession(true);
  }
}, 10_000);

/* ---------- Wake Lock ---------- */
async function acquireWakeLock() {
  try { state.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* unsupported */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.phase !== 'home') acquireWakeLock();
});

/* ---------- 設定 ---------- */
function openSettings(firstRun = false) {
  $('#welcome').classList.toggle('hidden', !firstRun);
  $('#set-key').value = settings.apiKey;
  $('#set-demo').checked = settings.demoMode;
  $('#set-font').value = settings.fontScale;
  $('#set-idle').value = settings.idleDisconnectMin;
  let u = {};
  try { u = JSON.parse(localStorage.getItem('kouyiji.usage') || '{}'); } catch { /* none */ }
  $('#usage-line').textContent = u.day ? `今日已用：送出 ${Math.round(u.sent || 0)} 秒、接收 ${Math.round(u.recv || 0)} 秒` : '今日尚未使用';
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
    closeSessions();
    $('#settings').close();
  });
  $('#demo-start').addEventListener('click', () => {
    settings = saveSettings({ demoMode: true });
    $('#settings').close();
    toast('Demo 模式已開啟，按「開始對話」試玩。');
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
}

/* ---------- 首頁 ---------- */
function bindHome() {
  for (const btn of document.querySelectorAll('#mode-seg .seg')) {
    btn.addEventListener('click', () => {
      state.mode = btn.dataset.mode;
      for (const b of document.querySelectorAll('#mode-seg .seg')) {
        const active = b === btn;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', String(active));
      }
      $('#mode-hint').textContent = state.mode === 'call'
        ? '兩人面對面：手機平放中間，各自按住自己那側說話'
        : '聽演講、導覽：對方的外語即時變成中文字幕';
      $('#start-label').textContent = state.mode === 'call' ? '開始對話' : '開始聆聽';
    });
  }
  $('#start-btn').addEventListener('click', () => {
    if (!settings.apiKey && !settings.demoMode) { openSettings(true); return; }
    startSession(state.mode);
  });
  $('#end-call').addEventListener('click', () => endSession());
  $('#listen-end').addEventListener('click', () => endSession());
  $('#listen-toggle').addEventListener('click', () => setListening(!state.listening));
  $('#pair').addEventListener('click', () => {
    toast('要換語言請先結束通話，回首頁選擇。', 3500);
  });
}

/* ---------- 啟動 ---------- */
function boot() {
  $('#ver').textContent = self.APP_VERSION || '?';
  document.documentElement.style.setProperty('--font-scale', settings.fontScale);
  fillLangSelect();
  renderLangUI();
  bindHold($('#hold-me'), 'me');
  bindHold($('#hold-them'), 'them');
  bindHome();
  bindSettings();
  bindTranscript();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  if (!settings.apiKey && !settings.demoMode) openSettings(true);
  window.__kouyiji = { audio, state, store, get settings() { return settings; } };
}

boot();
